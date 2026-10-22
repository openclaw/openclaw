import { createHash } from "node:crypto";
import {
  extractErrorCode,
  formatErrorMessage,
  readErrorName,
} from "@openclaw/normalization-core/error-coercion";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type MentionInboxItem,
  type MentionsListResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { warnMentionInboxDeprecation } from "../plugins/compat/mention-inbox-deprecation.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import {
  sessionChangeScopeAffectsStoredRows,
  sessionChanges,
} from "../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import {
  openClawStateDatabaseCache,
  registerOpenClawStateDatabaseAsyncResource,
} from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { onUserProfilesChanged, readUserProfileVersion } from "../state/user-profile-events.js";
import { readGatewayAccessRevision } from "./gateway-access-revision.js";
import { createHumanMentionPolicy, humanMentionDisplayLabel } from "./human-mention-policy.js";
import {
  formatMentionSessionTitle,
  mentionInboxUnavailable,
} from "./mention-inbox-presentation.js";
import {
  createMentionProjection,
  createMentionMutationProjection,
  reconcileMentionProfiles,
  removeMentionItem,
  expireMentionItems,
  serializeMentionSource,
  type InboxState,
  type StoredMention,
} from "./mention-inbox-projection.js";
import {
  createMentionInputRecorder,
  prepareCommittedMentionInput,
} from "./mention-inbox-recording.js";
import { MAX_MENTION_SOURCES } from "./mention-inbox-store.js";
import { createMentionTargetCache } from "./mention-inbox-targets.js";
import { readMentionSnapshot, commitMentionChanges } from "./mention-inbox-worker.js";
import type {
  MentionCommittedInput,
  MentionInbox,
  MentionInboxOptions,
} from "./mention-inbox.types.js";
import type { GatewayClient } from "./server-methods/types.js";
import { prepareSessionSharingRead } from "./session-sharing-target-read.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";

const log = createSubsystemLogger("gateway/mentions");

/** Durable sources own retention and replay; each Gateway keeps disposable projection indexes. */
export function createMentionInbox(params: MentionInboxOptions): MentionInbox {
  const scheduler = params.scheduler.scope();
  const context = captureOpenClawStateWorkerContext();
  const acceptedWork = new AsyncWorkScope();
  let state = createMentionProjection({ head: { revision: -1, nextSequence: 0 }, sources: [] });
  const { readTarget, prepareTarget, prepareTargets, invalidateTargets } = createMentionTargetCache(
    {
      getRuntimeConfig: () => params.getRuntimeConfig(),
      readItems: () => state.items.values(),
    },
  );
  const policy = createHumanMentionPolicy({ ...params, readSessionTarget: readTarget });
  let tail: Promise<void> = Promise.resolve();
  let closing = false;
  let needsSynchronization = true;
  let sessionRevision = 0;
  let refreshRetryAt = 0;
  let refreshRetryMs = 0;
  const views = new WeakMap<GatewayClient, { signature: string; revision: number }>();
  let capacityReported = false;
  let profileInvalidationPending = false;
  const applyCommittedInput = createMentionInputRecorder({
    getRuntimeConfig: () => params.getRuntimeConfig(),
    now: () => scheduler.now(),
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
    // Post-commit work must not borrow the completed input writer's custody.
    const pending = runInDetachedAsyncContext(() =>
      acceptedWork.track(() =>
        tail.then(() => {
          context.admission.assertCurrent();
          return operation();
        }),
      ),
    );
    // Failed work must not poison later FIFO operations.
    tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return await pending;
  }

  async function synchronize(): Promise<boolean> {
    const snapshot = await readMentionSnapshot(
      context,
      needsSynchronization ? -1 : state.head.revision,
    );
    if (snapshot) {
      state = createMentionProjection(snapshot);
    }
    needsSynchronization = false;
    return Boolean(snapshot);
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
        if (draft.dirtySources.size === 0) {
          // No durable effect needs commit admission; publish maintenance bookkeeping in this turn.
          state = prepared.publish(expectedHead);
          return result;
        }
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
          state = createMentionProjection(receipt.snapshot);
          continue;
        }
        context.admission.assertCurrent();
        state = prepared.publish(receipt.head);
        needsSynchronization = false;
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

  function currentTarget(item: StoredMention, cfg: OpenClawConfig, projection = state) {
    const { source, message } = item;
    const { agentId, sessionKey, senderProfileId } = message.content;
    if (projection.items.get(item.id) !== item || source.expiresAt <= scheduler.now()) {
      return undefined;
    }
    const resolved = readTarget(sessionKey, agentId);
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
    cfg: OpenClawConfig,
    remember: boolean,
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
      const current = currentTarget(item, cfg, projection);
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

  function publishConnectedViews(): void {
    if (scheduler.signal.aborted) {
      return;
    }
    const cfg = params.getRuntimeConfig();
    for (const client of params.getClients()) {
      if (!client.connId) {
        continue;
      }
      const previous = views.get(client);
      const result = readView(client, cfg, true);
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

  async function refreshConnectedViews(): Promise<void> {
    await prepareTargets();
    publishConnectedViews();
  }

  function scheduleExpiry(): void {
    if (
      closing ||
      scheduler.signal.aborted ||
      (state.processed.size === 0 && refreshRetryAt === 0)
    ) {
      return;
    }
    scheduler.schedule({
      id: `mentions:expiry:${params.gatewayInstanceId}`,
      atMs: refreshRetryAt || state.nextExpiryAt,
      run: refresh,
    });
  }

  async function refresh(): Promise<void> {
    if (closing || scheduler.signal.aborted) {
      return;
    }
    const started = performance.now();
    let phase = "admission";
    try {
      await enqueue(async () => {
        // Queued invalidations share the retry budget; foreground reads still retry immediately.
        if (scheduler.now() < refreshRetryAt) {
          return;
        }
        phase = "maintenance";
        await maintain();
        context.admission.assertCurrent();
        phase = "sharing";
        await prepareTargets();
        phase = "publication";
        publishConnectedViews();
        refreshRetryAt = 0;
        refreshRetryMs = 0;
        scheduleExpiry();
      });
    } catch (error) {
      if (closing || scheduler.signal.aborted) {
        return;
      }
      refreshRetryMs = Math.min(refreshRetryMs ? refreshRetryMs * 2 : 60_000, 15 * 60_000);
      refreshRetryAt = scheduler.now() + refreshRetryMs;
      log.warn(
        `Unable to refresh the mention Inbox; current reads will retry. phase=${phase} error=${readErrorName(error) || "unknown"} code=${extractErrorCode(error) ?? "unknown"} elapsedMs=${Math.round(performance.now() - started)} retryAfterMs=${refreshRetryMs} cause=${formatErrorMessage(error, { includeCode: true })}`,
        { source: context.admission.databasePath },
      );
      scheduleExpiry();
    }
  }

  function invalidateAsync(sessionKey?: string): Promise<void> {
    invalidateTargets(sessionKey);
    policy.invalidateDirectory();
    return refresh();
  }

  // The inbox retains worker-prepared sharing facts. Committed row publications
  // invalidate them; direct reads and delayed pushes consume the same receipt-backed facts.
  const stopRows = sessionChanges.subscribeFacts((change) => {
    if (!sessionChangeScopeAffectsStoredRows(change)) {
      return;
    }
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

  function legacyError(
    method: "list" | "dismiss" | "recordCommittedInput" | "invalidate",
  ): ErrorShape {
    warnMentionInboxDeprecation(method);
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `mentionInbox.${method} is unavailable; await mentionInbox.${method}Async instead.`,
    );
  }

  function dismissItems(draft: InboxState, client: GatewayClient | null, ids: readonly string[]) {
    const current = readView(client, params.getRuntimeConfig(), false, draft);
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
            await prepareTargets();
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
    invalidateTargets();
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

  function recordCommittedInputAsync(committedInput: MentionCommittedInput): Promise<void> {
    const input = {
      ...committedInput,
      recipientProfileIds: [...committedInput.recipientProfileIds],
      committedSource: { ...committedInput.committedSource },
    };
    return enqueue(async () => {
      if (!prepareCommittedMentionInput(input)) {
        return;
      }
      const cfg = params.getRuntimeConfig();
      const { agentId } = resolveSessionStoreIdentity({
        cfg,
        sessionKey: input.sessionKey,
        agentId: input.agentId,
      });
      const prepared = await prepareSessionSharingRead({
        cfg,
        sessionKey: input.sessionKey,
        agentId,
      });
      try {
        await policy.recordCommittedInvolvementAsync(input, prepared);
        const committed = await mutate<StoredMention[]>(
          (draft, guards, bounds) =>
            applyCommittedInput(
              input,
              draft,
              guards,
              bounds,
              () => prepared.readCurrent(params.getRuntimeConfig()).target,
            ),
          () => input.recipientProfileIds.map((id) => policy.readProfile(id)?.profileId ?? id),
        );
        context.admission.assertCurrent();
        await refreshConnectedViews();
        scheduleExpiry();
        publishCommittedMentions(committed);
      } finally {
        prepared.release();
      }
    }).catch(() => {
      log.warn("Mention delivery could not be completed; the posted message is unchanged.");
    });
  }

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
      try {
        if ("sessionKey" in input) {
          await prepareTarget(input.sessionKey, input.agentId);
        }
      } catch {
        preparationFailure = mentionInboxUnavailable(log);
      }
      // Current policy selection and response publication must not cross another await.
      publish(preparationFailure ?? readOperation(() => policy.mentionable(client, input)));
    },
    validateRecipients(client, input, profileIds) {
      warnMentionInboxDeprecation("validateRecipients");
      return readOperation(() => policy.validateRecipients(client, input, profileIds));
    },
    async validateRecipientsAsync(client, input, profileIds) {
      try {
        const prepared = await policy.prepareContext(input);
        try {
          return readOperation(() =>
            policy.validateRecipients(client, input, profileIds, prepared),
          );
        } finally {
          prepared.release();
        }
      } catch {
        return mentionInboxUnavailable(log);
      }
    },
    list: () => err(legacyError("list")),
    dismiss: () => err(legacyError("dismiss")),
    async listAsync(client, publish) {
      let failure: Result<never, ErrorShape> | undefined;
      try {
        await enqueue(async () => {
          const changed = await maintain();
          await prepareTargets();
          if (changed) {
            publishConnectedViews();
          }
          scheduleExpiry();
        });
      } catch {
        failure = mentionInboxUnavailable(log);
      }
      publish(failure ?? readOperation(() => readView(client, params.getRuntimeConfig(), true)));
    },
    async dismissAsync(client, ids, publish) {
      let failure: Result<never, ErrorShape> | undefined;
      try {
        const selectedIds = [...ids];
        await enqueue(async () => {
          await maintain();
          await prepareTargets();
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
          await refreshConnectedViews();
          scheduleExpiry();
          if (!result.ok) {
            failure = result;
          }
        });
      } catch {
        failure = mentionInboxUnavailable(log);
      }
      publish(failure ?? readOperation(() => readView(client, params.getRuntimeConfig(), true)));
    },
    recordCommittedInput(input: MentionCommittedInput): void {
      warnMentionInboxDeprecation("recordCommittedInput");
      if (closing || scheduler.signal.aborted) {
        return;
      }
      const captured = structuredClone(input);
      const record = () => void recordCommittedInputAsync(captured);
      // Legacy callers may still submit inside a transaction. Rollback must not enqueue a mention.
      const database = openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(
        context.admission.identity.canonicalPath,
      );
      if (!database || !deferSqlitePostCommitPublication(database.db, record)) {
        record();
      }
    },
    recordCommittedInputAsync,
    invalidate(): never {
      throw new Error(legacyError("invalidate").message);
    },
    invalidateAsync,
    dispose,
  };
}
