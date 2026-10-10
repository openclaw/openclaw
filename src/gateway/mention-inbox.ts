import { createHash } from "node:crypto";
import { ok, type Result } from "@openclaw/normalization-core/result";
import type {
  ErrorShape,
  MentionInboxItem,
  MentionsListResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { warnMentionInboxDeprecation } from "../plugins/compat/mention-inbox-deprecation.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { onUserProfilesChanged, readUserProfileVersion } from "../state/user-profile-events.js";
import { readGatewayAccessRevision } from "./gateway-access-revision.js";
import { createHumanMentionPolicy, humanMentionDisplayLabel } from "./human-mention-policy.js";
import { hasValidMentionReferences } from "./mention-inbox-input.js";
import {
  formatMentionSessionTitle,
  mentionInboxUnavailable,
} from "./mention-inbox-presentation.js";
import {
  MAX_GLOBAL_ITEMS,
  createMentionProjection,
  createMentionMutationProjection,
  reconcileMentionProfiles,
  removeMentionItem,
  expireMentionItems,
  serializeMentionSource,
  type InboxState,
  type StoredMention,
} from "./mention-inbox-projection.js";
import { createMentionInputRecorder } from "./mention-inbox-recording.js";
import { MAX_MENTION_SOURCES } from "./mention-inbox-store.js";
import { readMentionSnapshot, commitMentionChanges } from "./mention-inbox-worker.js";
import { mutateNativeMentionSnapshot } from "./mention-inbox.native.js";
import type {
  MentionCommittedInput,
  MentionInbox,
  MentionInboxOptions,
} from "./mention-inbox.types.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveSessionSharingTarget } from "./session-sharing.js";

const log = createSubsystemLogger("gateway/mentions");

type SharingTargets = Map<
  string,
  { sessionKey: string; target: ReturnType<typeof resolveSessionSharingTarget> }
>;

/** Durable sources own retention and replay; each Gateway keeps disposable projection indexes. */
export function createMentionInbox(params: MentionInboxOptions): MentionInbox {
  const scheduler = params.scheduler.scope();
  const policy = createHumanMentionPolicy(params);
  const context = captureOpenClawStateWorkerContext();
  const acceptedWork = new AsyncWorkScope();
  let state = createMentionProjection({ head: { revision: -1, nextSequence: 0 }, sources: [] });
  let tail: Promise<void> = Promise.resolve();
  let closing = false;
  let needsSynchronization = true;
  let nativeRevision = 0;
  let sessionRevision = 0;
  const views = new WeakMap<GatewayClient, { signature: string; revision: number }>();
  const connectedTargets: SharingTargets = new Map();
  let targetConfig: OpenClawConfig | undefined;
  let capacityReported = false;
  let profileInvalidationPending = false;
  const applyCommittedInput = createMentionInputRecorder({
    getRuntimeConfig: () => params.getRuntimeConfig(),
    now: scheduler.now,
    policy,
    onCapacityReached() {
      if (!capacityReported) {
        log.warn(
          "Mention retention reached its replay budget; new mention alerts are skipped until retained sources expire.",
        );
        capacityReported = true;
      }
    },
  });

  function assertActive(): void {
    if (closing || scheduler.signal.aborted) {
      throw new Error("Mention Inbox is closed");
    }
    context.admission.assertCurrent();
  }

  async function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    assertActive();
    // Scheduler cancellation closes admission; accepted work retains its own settlement scope.
    const pending = acceptedWork.track(() =>
      tail.then(() => {
        context.admission.assertCurrent();
        return operation();
      }),
    );
    // Failed work must not poison later FIFO operations.
    tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return await pending;
  }

  async function synchronize(): Promise<boolean> {
    for (;;) {
      context.admission.assertCurrent();
      const revision = nativeRevision;
      const snapshot = await readMentionSnapshot(
        context,
        needsSynchronization ? -1 : state.head.revision,
      );
      context.admission.assertCurrent();
      if (revision !== nativeRevision) {
        continue;
      }
      if (snapshot) {
        state = createMentionProjection(snapshot);
      }
      needsSynchronization = false;
      return Boolean(snapshot);
    }
  }

  async function mutate<T>(
    operation: (
      draft: InboxState,
      guards: Array<() => void>,
      bounds: Pick<ReturnType<typeof createMentionMutationProjection>, "sourceIndex" | "itemLimit">,
    ) => T,
    selectProfiles?: () => readonly string[],
  ): Promise<T> {
    try {
      await synchronize();
      for (;;) {
        const revision = nativeRevision;
        const expectedHead = { ...state.head };
        const now = scheduler.now();
        const maintenance =
          now >= state.nextExpiryAt || state.profileVersion !== readUserProfileVersion();
        const prepared = createMentionMutationProjection(
          state,
          maintenance ? undefined : selectProfiles?.(),
        );
        const { draft } = prepared;
        expireMentionItems(draft, now);
        if (prepared.sourceIndex.size < MAX_MENTION_SOURCES) {
          capacityReported = false;
        }
        reconcileMentionProfiles(
          draft,
          readUserProfileVersion(),
          (id) => policy.readProfile(id)?.profileId ?? id,
        );
        const guards: Array<() => void> = [];
        const result = operation(draft, guards, prepared);
        const profiles = readUserProfileVersion();
        const access = readGatewayAccessRevision();
        const sessions = sessionRevision;
        const config = params.getRuntimeConfig();
        const assertCurrent = () => {
          context.admission.assertCurrent();
          if (
            profiles !== readUserProfileVersion() ||
            access !== readGatewayAccessRevision() ||
            sessions !== sessionRevision ||
            config !== params.getRuntimeConfig()
          ) {
            throw new Error("Mention authority changed before commit");
          }
          for (const guard of guards) {
            guard();
          }
        };
        const receipt = await commitMentionChanges(
          context,
          {
            expectedHead,
            nextSequence: draft.head.nextSequence,
            changes: [...draft.dirtySources].map((key) => {
              const source = draft.processed.get(key);
              return [key, source ? serializeMentionSource(source) : undefined];
            }),
          },
          assertCurrent,
        );
        if (receipt.kind === "conflict") {
          context.admission.assertCurrent();
          if (revision === nativeRevision) {
            state = createMentionProjection(receipt.snapshot);
          } else {
            await synchronize();
          }
          continue;
        }
        context.admission.assertCurrent();
        if (revision === nativeRevision) {
          state = prepared.publish(receipt.head);
          needsSynchronization = false;
        } else {
          await synchronize();
        }
        return result;
      }
    } catch (error) {
      // Unknown outcomes are read back by the owner, never replayed to recover a receipt.
      needsSynchronization = true;
      throw error;
    }
  }

  async function maintain(): Promise<boolean> {
    const changed = await synchronize();
    const maintenance =
      scheduler.now() >= state.nextExpiryAt || state.profileVersion !== readUserProfileVersion();
    if (maintenance) {
      await mutate(() => undefined);
    }
    return changed || maintenance;
  }

  function currentTarget(
    item: StoredMention,
    cfg: OpenClawConfig,
    targets?: SharingTargets,
    projection = state,
  ) {
    const { source, message } = item;
    const { agentId, sessionKey, senderProfileId } = message.content;
    if (projection.items.get(item.id) !== item || source.expiresAt <= scheduler.now()) {
      return undefined;
    }
    const key = JSON.stringify([agentId, sessionKey]);
    let resolved = targets?.get(key)?.target;
    if (resolved === undefined) {
      resolved = resolveSessionSharingTarget({
        cfg,
        sessionKey,
        agentId,
      });
      if (targets?.size === MAX_MENTION_SOURCES) {
        targets.clear();
      }
      targets?.set(key, { sessionKey, target: resolved });
    }
    if (!resolved || resolved.entry.sessionId !== message.sessionId) {
      return undefined;
    }
    const target = {
      agentId: resolved.agentId,
      sessionKey: resolved.canonicalKey,
      entry: resolved.entry,
    };
    const recipient = policy.recipientProfile(item.recipientProfileId, target, cfg);
    const sender = policy.readProfile(senderProfileId);
    return recipient && recipient.profileId !== sender?.profileId
      ? { target, recipient, sender }
      : undefined;
  }

  function projectItem(
    item: StoredMention,
    current: NonNullable<ReturnType<typeof currentTarget>>,
  ): MentionInboxItem {
    const { content } = item.message;
    return {
      ...content,
      id: item.id,
      expiresAt: item.source.expiresAt,
      senderProfileId: current.sender?.profileId ?? content.senderProfileId,
      senderLabel: humanMentionDisplayLabel(current.sender?.label, content.senderProfileId),
      ...(current.sender ? { senderAvatarUrl: current.sender.avatarUrl } : {}),
      sessionTitle: formatMentionSessionTitle(current.target.entry),
    };
  }

  function readView(
    client: GatewayClient | null,
    cfg = params.getRuntimeConfig(),
    remember = true,
    targets: SharingTargets = new Map(),
    projection = state,
  ): Result<MentionsListResult, ErrorShape> {
    const identified = policy.identify(client, cfg);
    if (!identified.ok) {
      return identified;
    }
    const requester = identified.value;
    const visible: MentionInboxItem[] = [];
    const profileItems = projection.itemsByProfile.get(requester.profile.profileId);
    for (const item of [...(profileItems ?? [])].toReversed()) {
      const current = currentTarget(item, cfg, targets, projection);
      if (current && requester.canRead(current.target)) {
        visible.push(projectItem(item, current));
      }
    }
    const signature = createHash("sha256")
      .update(JSON.stringify([requester.profile.profileId, visible]))
      .digest("hex");
    const previous = client && views.get(client);
    const revision = previous ? previous.revision + Number(signature !== previous.signature) : 0;
    if (client && remember) {
      views.set(client, { signature, revision });
    }
    return ok({ gatewayInstanceId: params.gatewayInstanceId, revision, items: visible });
  }

  function refreshConnectedViews(): void {
    if (scheduler.signal.aborted) {
      return;
    }
    const cfg = params.getRuntimeConfig();
    if (targetConfig !== cfg) {
      connectedTargets.clear();
      targetConfig = cfg;
    }
    for (const client of params.getClients()) {
      if (!client.connId) {
        continue;
      }
      const previous = views.get(client);
      const result = readView(client, cfg, true, connectedTargets);
      if (
        !result.ok ||
        (previous ? previous.revision === result.value.revision : result.value.items.length === 0)
      ) {
        continue;
      }
      params.broadcastToConnIds(
        "mentions.changed",
        { gatewayInstanceId: params.gatewayInstanceId, revision: result.value.revision },
        new Set([client.connId]),
      );
    }
  }

  function scheduleExpiry(retryAfterMs?: number): void {
    if (
      closing ||
      scheduler.signal.aborted ||
      (state.processed.size === 0 && retryAfterMs === undefined)
    ) {
      return;
    }
    scheduler.schedule({
      id: `mentions:expiry:${params.gatewayInstanceId}`,
      mode: "earliest",
      ...(retryAfterMs === undefined ? { atMs: state.nextExpiryAt } : { delayMs: retryAfterMs }),
      run: refresh,
    });
  }

  async function refresh(): Promise<void> {
    if (closing || scheduler.signal.aborted) {
      return;
    }
    try {
      await enqueue(async () => {
        await maintain();
        context.admission.assertCurrent();
        refreshConnectedViews();
        scheduleExpiry();
      });
    } catch {
      log.warn("Unable to refresh the mention Inbox; current reads will retry.");
      scheduleExpiry(60_000);
    }
  }

  function invalidateTargets(sessionKey?: string): void {
    if (!sessionKey) {
      connectedTargets.clear();
      return;
    }
    for (const [key, cached] of connectedTargets) {
      if (cached.sessionKey === sessionKey || cached.target?.storeKeys.includes(sessionKey)) {
        connectedTargets.delete(key);
      }
    }
  }

  function invalidateAsync(sessionKey?: string): Promise<void> {
    invalidateTargets(sessionKey);
    policy.invalidateDirectory();
    return refresh();
  }

  // Only connected-view refreshes retain targets across calls. Committed row publications
  // invalidate them; direct reads and delayed push authority keep their fresh exact reads.
  const stopRows = sessionChanges.subscribeFacts((change) => {
    if (
      !("facts" in change) ||
      !change.facts ||
      !["participants", "category", "owner", "unchanged"].includes(change.facts.kind) ||
      change.factsInvalidated
    ) {
      sessionRevision++;
    }
    invalidateTargets("sessionKey" in change ? change.sessionKey : undefined);
  });

  // Profile writes publish after commit. The microtask also follows role-policy cache invalidation.
  const stopProfiles = onUserProfilesChanged(() => {
    if (profileInvalidationPending) {
      return;
    }
    profileInvalidationPending = true;
    queueMicrotask(() => {
      profileInvalidationPending = false;
      void invalidateAsync();
    });
  });
  const stopSessions = onSessionIdentityMutation(() => {
    sessionRevision++;
    void invalidateAsync();
  });

  function readOperation<T>(operation: () => Result<T, ErrorShape>): Result<T, ErrorShape> {
    if (!closing && !scheduler.signal.aborted) {
      try {
        return operation();
      } catch {
        return mentionInboxUnavailable(log);
      }
    }
    return mentionInboxUnavailable();
  }

  function mutateNative(apply: (draft: InboxState) => void, notify?: () => void): InboxState {
    nativeRevision++;
    needsSynchronization = true;
    return mutateNativeMentionSnapshot(context, {
      now: scheduler.now,
      canonicalProfileId: (id) => policy.readProfile(id)?.profileId ?? id,
      apply: (current) => {
        assertActive();
        apply(current);
      },
      publish: (current) => {
        if (!scheduler.signal.aborted && current.head.revision >= state.head.revision) {
          state = current;
          needsSynchronization = false;
        }
      },
      notify: () => {
        if (!scheduler.signal.aborted) {
          refreshConnectedViews();
          scheduleExpiry();
          notify?.();
        }
      },
    });
  }

  function legacy(
    client: GatewayClient | null,
    ids?: readonly string[],
  ): Result<MentionsListResult, ErrorShape> {
    warnMentionInboxDeprecation(ids ? "dismiss" : "list");
    return readOperation(() => {
      const draft = mutateNative((current) => {
        if (ids) {
          dismissItems(current, client, ids);
        }
      });
      return readView(client, params.getRuntimeConfig(), true, new Map(), draft);
    });
  }

  function invalidate(sessionKey?: string): void {
    warnMentionInboxDeprecation("invalidate");
    invalidateTargets(sessionKey);
    policy.invalidateDirectory();
    if (closing || scheduler.signal.aborted) {
      return;
    }
    try {
      mutateNative(() => {});
    } catch {
      log.warn("Unable to refresh the mention Inbox; current reads will retry.");
      scheduleExpiry(60_000);
    }
  }

  function dismissItems(draft: InboxState, client: GatewayClient | null, ids: readonly string[]) {
    const current = readView(client, params.getRuntimeConfig(), false, new Map(), draft);
    if (current.ok) {
      const owned = new Set(current.value.items.map((item) => item.id));
      for (const id of ids) {
        if (owned.has(id)) {
          removeMentionItem(draft, draft.items.get(id));
        }
      }
    }
    return current;
  }

  function prepareCommittedInput(input: MentionCommittedInput): boolean {
    if (input.recipientProfileIds.length === 0) {
      return false;
    }
    context.admission.assertCurrent();
    if (!hasValidMentionReferences(input)) {
      log.warn("Skipped mention delivery with invalid committed references.");
      return false;
    }
    return true;
  }

  function publishCommittedMentions(committed: readonly StoredMention[]): void {
    if (scheduler.signal.aborted || !params.onMentionCreated) {
      return;
    }
    for (const item of committed) {
      const retained = state.items.get(item.id);
      const current = retained && currentTarget(retained, params.getRuntimeConfig());
      if (!retained || !current) {
        continue;
      }
      const projected = projectItem(retained, current);
      params.onMentionCreated({
        id: item.id,
        recipientProfileId: current.recipient.profileId,
        sessionKey: projected.sessionKey,
        agentId: projected.agentId,
        senderLabel: projected.senderLabel,
        sessionTitle: projected.sessionTitle,
        prepare: () =>
          enqueue(async () => {
            await maintain();
          }),
        isCurrent: () => {
          try {
            if (scheduler.signal.aborted) {
              return false;
            }
            if (needsSynchronization) {
              return false;
            }
            const latest = state.items.get(item.id);
            return Boolean(latest && currentTarget(latest, params.getRuntimeConfig()));
          } catch {
            return false;
          }
        },
      });
    }
  }

  async function dispose(): Promise<void> {
    closing = true;
    await tail;
    await acceptedWork.drain();
    scheduler.beginClose();
    stopProfiles();
    stopSessions();
    stopRows();
    connectedTargets.clear();
    policy.dispose();
    state.items.clear();
    state.itemsByProfile.clear();
    state.processed.clear();
    await scheduler.stop();
    unregister();
  }

  const unregister = registerOpenClawStateDatabaseAsyncResource({
    async close(identity) {
      if (
        !identity ||
        identity.key === context.admission.identity.key ||
        identity.canonicalPath === context.admission.identity.canonicalPath
      ) {
        await dispose();
      }
    },
  });

  void refresh();

  return {
    async mentionable(client, input, publish) {
      let preparationFailure: Result<never, ErrorShape> | undefined;
      try {
        // A committed profile change can invalidate preparation before this continuation runs.
        while (policy.needsDirectoryPreparation()) {
          await policy.prepareDirectory();
        }
      } catch {
        preparationFailure = mentionInboxUnavailable(log);
      }
      // Current policy selection and response publication must not cross another await.
      publish(preparationFailure ?? readOperation(() => policy.mentionable(client, input)));
    },
    validateRecipients: (...args: Parameters<typeof policy.validateRecipients>) =>
      readOperation(() => policy.validateRecipients(...args)),
    list: (client) => legacy(client),
    dismiss: (client, ids) => legacy(client, ids),
    async listAsync(client, publish) {
      let failure: Result<never, ErrorShape> | undefined;
      try {
        await enqueue(async () => {
          if (await maintain()) {
            refreshConnectedViews();
          }
          scheduleExpiry();
        });
      } catch {
        failure = mentionInboxUnavailable(log);
      }
      publish(failure ?? readOperation(() => readView(client)));
    },
    async dismissAsync(client, ids, publish) {
      let failure: Result<never, ErrorShape> | undefined;
      try {
        const selectedIds = [...ids];
        await enqueue(async () => {
          const result = await mutate(
            (draft, guards) => {
              const current = dismissItems(draft, client, selectedIds);
              if (current.ok) {
                const identity = client?.authenticatedUserProfile?.profileId;
                const scopes = JSON.stringify(client?.connect.scopes);
                const role = client?.connect.role;
                guards.push(() => {
                  if (
                    client?.invalidated ||
                    client?.internal?.syntheticClient ||
                    role !== client?.connect.role ||
                    identity !== client?.authenticatedUserProfile?.profileId ||
                    scopes !== JSON.stringify(client?.connect.scopes)
                  ) {
                    throw new Error("Mention caller changed before dismissal");
                  }
                });
              }
              return current;
            },
            () => {
              const requester = policy.identify(client, params.getRuntimeConfig());
              return requester.ok ? [requester.value.profile.profileId] : [];
            },
          );
          refreshConnectedViews();
          scheduleExpiry();
          if (!result.ok) {
            failure = result;
          }
        });
      } catch {
        failure = mentionInboxUnavailable(log);
      }
      publish(failure ?? readOperation(() => readView(client)));
    },
    recordCommittedInput(input: MentionCommittedInput): void {
      warnMentionInboxDeprecation("recordCommittedInput");
      if (closing || scheduler.signal.aborted) {
        return;
      }
      try {
        if (!prepareCommittedInput(input)) {
          return;
        }
        policy.recordCommittedInvolvement(input);
        let committed: StoredMention[] = [];
        mutateNative(
          (draft) => {
            committed = applyCommittedInput(input, draft, [], {
              sourceIndex: draft.processed,
              itemLimit: MAX_GLOBAL_ITEMS,
            });
          },
          () => {
            try {
              publishCommittedMentions(committed);
            } catch {
              log.warn("Mention delivery could not be completed; the posted message is unchanged.");
            }
          },
        );
      } catch {
        log.warn("Mention delivery could not be completed; the posted message is unchanged.");
      }
    },
    recordCommittedInputAsync(committedInput: MentionCommittedInput): Promise<void> {
      const input = {
        ...committedInput,
        recipientProfileIds: [...committedInput.recipientProfileIds],
        committedSource: { ...committedInput.committedSource },
      };
      return enqueue(async () => {
        if (!prepareCommittedInput(input)) {
          return;
        }
        await policy.recordCommittedInvolvementAsync(input);
        const committed = await mutate<StoredMention[]>(
          (draft, guards, bounds) => applyCommittedInput(input, draft, guards, bounds),
          () => input.recipientProfileIds.map((id) => policy.readProfile(id)?.profileId ?? id),
        );
        context.admission.assertCurrent();
        refreshConnectedViews();
        scheduleExpiry();
        publishCommittedMentions(committed);
      }).catch(() => {
        log.warn("Mention delivery could not be completed; the posted message is unchanged.");
      });
    },
    invalidate,
    invalidateAsync,
    dispose,
  };
}
