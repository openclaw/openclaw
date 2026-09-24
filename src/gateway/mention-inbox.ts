import { createHash, randomUUID } from "node:crypto";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  MAX_HUMAN_MENTIONS,
  errorShape,
  type ErrorShape,
  type MentionInboxItem,
  type MentionsListResult,
} from "../../packages/gateway-protocol/src/index.js";
import { updateSessionProfileInvolvement } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { onUserProfilesChanged, readUserProfileVersion } from "../state/user-profile-events.js";
import { createHumanMentionPolicy } from "./human-mention-policy.js";
import { createCommittedMentionAuthority } from "./mention-committed-authority.js";
import { prepareMentionExcerpts } from "./mention-excerpt.js";
import { projectMentionExcerpt, projectMentionInboxItem } from "./mention-inbox-presentation.js";
import type {
  MentionStoreExcerpt,
  MentionStoreHead,
  MentionStoreMessage,
  MentionStoreSnapshot,
} from "./mention-inbox-store.codec.js";
import { readMentionStoreSnapshot } from "./mention-inbox-store.js";
import { mutateMentionInbox } from "./mention-inbox.persistence.js";
import type { MentionCommittedInput, MentionInbox } from "./mention-inbox.types.js";
import type { MentionInboxMutation } from "./mention-inbox.worker-contract.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { GatewayClient } from "./server-methods/types.js";

const log = createSubsystemLogger("gateway/mentions");

type StoredMention = {
  id: string;
  recipientProfileId: string;
  source: ProcessedSource;
  message: MentionStoreMessage;
  preview?: MentionStoreExcerpt;
};

type ProcessedSource = {
  key: string;
  sequence: number;
  expiresAt: number;
  /** Null retains consumption after dismissal, eviction, or intentional non-delivery. */
  recipients: Map<string, StoredMention | null>;
};

type MentionNotification = {
  id: string;
  recipientProfileId: string;
  sessionKey: string;
  agentId: string;
  senderLabel: string;
  sessionTitle: string;
  prepare: () => Promise<void>;
  isCurrent: () => boolean;
};

/** Durable sources own retention and replay; each Gateway keeps disposable projection indexes. */
export function createMentionInbox(params: {
  gatewayInstanceId: string;
  getRuntimeConfig: () => OpenClawConfig;
  getClients: () => Iterable<GatewayClient>;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  onMentionCreated?: (notification: MentionNotification) => void;
}): MentionInbox {
  let connectedViewsDirty = false;
  const policy = createHumanMentionPolicy({
    ...params,
    getRetainedPreparation: retainedPolicyPreparation,
    onInvalidated: () => {
      connectedViewsDirty = true;
    },
  });
  const items = new Map<string, StoredMention>();
  const itemsByProfile = new Map<string, Set<StoredMention>>();
  const processed = new Map<string, ProcessedSource>();
  let head: MentionStoreHead = { revision: -1, nextSequence: 0 };
  const views = new WeakMap<GatewayClient, { signature: string; revision: number }>();
  let active = true;
  let profileVersion = readUserProfileVersion();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimerAt = Infinity;
  let profileInvalidationPending = false;
  let nextExpiryAt = Infinity;
  const context = captureOpenClawStateWorkerContext();
  let tail = Promise.resolve();
  let disposed: Promise<void> | undefined;

  // Every policy preparation/selection and commit guard shares this FIFO. Internal
  // operations call the helpers directly, never await a queued public method.
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    const settled = () => {
      // Handled RPC failures can still leave committed view updates pending.
      if (connectedViewsDirty) {
        scheduleExpiry(60_000);
      }
    };
    tail = result.then(settled, settled);
    return result;
  }

  function assertCurrent(): void {
    context.admission.assertCurrent();
    if (!active) {
      throw new Error("Mention Inbox is closed");
    }
  }

  function install(snapshot: MentionStoreSnapshot | undefined): void {
    if (!snapshot) {
      return;
    }
    items.clear();
    itemsByProfile.clear();
    processed.clear();
    nextExpiryAt = Infinity;
    for (const stored of snapshot.sources) {
      const source: ProcessedSource = {
        key: stored.key,
        sequence: stored.sequence,
        expiresAt: stored.expiresAt,
        recipients: new Map(),
      };
      processed.set(source.key, source);
      nextExpiryAt = Math.min(nextExpiryAt, source.expiresAt);
      for (const [profileId, id] of stored.recipients) {
        const item: StoredMention | null =
          id && stored.message
            ? {
                id,
                recipientProfileId: profileId,
                source,
                message: stored.message,
                preview: projectMentionExcerpt(stored.message.recipientExcerpts, profileId),
              }
            : null;
        source.recipients.set(profileId, item);
        if (item) {
          items.set(item.id, item);
          const retained = itemsByProfile.get(profileId) ?? new Set<StoredMention>();
          retained.add(item);
          itemsByProfile.set(profileId, retained);
        }
      }
    }
    head = snapshot.head;
    // A restart or another writer may have preceded this process's profile events.
    profileVersion = -1;
    connectedViewsDirty = true;
  }

  async function synchronize(): Promise<void> {
    assertCurrent();
    const snapshot = await readMentionStoreSnapshot(head.revision, context);
    assertCurrent();
    install(snapshot);
  }

  function retainedProfileIds(): Set<string> {
    const ids = new Set<string>();
    for (const source of processed.values()) {
      for (const id of source.recipients.keys()) {
        ids.add(id);
      }
    }
    return ids;
  }

  async function mutate(action: MentionInboxMutation["action"], guard = assertCurrent) {
    const version = readUserProfileVersion();
    const result = await mutateMentionInbox(
      context,
      { action, now: Date.now() },
      () => {
        assertCurrent();
        if (version !== readUserProfileVersion()) {
          throw new Error("Mention profiles changed during mutation");
        }
        guard();
      },
      (committed) => {
        install(committed.snapshot);
      },
    );
    profileVersion = version;
    return result;
  }

  async function maintain(): Promise<void> {
    await synchronize();
    const maintenance = Date.now() >= nextExpiryAt || profileVersion !== readUserProfileVersion();
    if (maintenance) {
      await mutate({ kind: "maintain" });
    }
    await preparePolicy();
  }

  function retainedPolicyPreparation() {
    // The existing store bounds this cohort: MAX_MENTION_SOURCES * MAX_HUMAN_MENTIONS
    // recipient references (including consumed ones), plus the bounded live senders/targets.
    // The policy adds the directory, current clients and one
    // FIFO operation (at most MAX_HUMAN_MENTIONS recipients and its sender/requester).
    const profileIds = retainedProfileIds();
    const targets = [...items.values()].flatMap((item) => {
      // Retention must not depend on reopening an expired source's session store.
      if (item.source.expiresAt <= Date.now()) {
        return [];
      }
      profileIds.add(item.message.content.senderProfileId);
      return [
        {
          sessionKey: item.message.content.sessionKey,
          agentId: item.message.content.agentId,
        },
      ];
    });
    return { targets, profileIds: [...profileIds] };
  }

  async function preparePolicy(
    targets: { sessionKey: string; agentId?: string }[] = [],
    profileIds: readonly string[] = [],
  ) {
    // Policy preparation combines this operation with the Inbox's complete retained cohort.
    const preparation = { targets, profileIds };
    while (policy.needsPreparation(preparation)) {
      await policy.prepare(preparation);
    }
    assertCurrent();
  }

  function currentTarget(item: StoredMention, cfg: OpenClawConfig) {
    const { source, message } = item;
    const { agentId, sessionKey, senderProfileId } = message.content;
    if (!active || items.get(item.id) !== item || source.expiresAt <= Date.now()) {
      return undefined;
    }
    const resolved = policy.resolveTarget({ sessionKey, agentId });
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

  function readView(
    client: GatewayClient | null,
    cfg = params.getRuntimeConfig(),
    remember = true,
  ): Result<MentionsListResult, ErrorShape> {
    const identified = policy.identify(client, cfg);
    if (!identified.ok) {
      return identified;
    }
    const requester = identified.value;
    const visible: MentionInboxItem[] = [];
    const profileItems = itemsByProfile.get(requester.profile.profileId);
    for (const item of [...(profileItems ?? [])].toReversed()) {
      const current = currentTarget(item, cfg);
      if (current && requester.canRead(current.target)) {
        visible.push(projectMentionInboxItem(item, current));
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
    if (!active) {
      return;
    }
    // Consume only this attempt; failures or reentrant invalidation keep future work pending.
    connectedViewsDirty = false;
    try {
      const cfg = params.getRuntimeConfig();
      for (const client of params.getClients()) {
        if (!client.connId) {
          continue;
        }
        const previous = views.get(client);
        const result = readView(client, cfg);
        if (
          !result.ok ||
          (previous ? previous.revision === result.value.revision : result.value.items.length === 0)
        ) {
          continue;
        }
        try {
          params.broadcastToConnIds(
            "mentions.changed",
            { gatewayInstanceId: params.gatewayInstanceId, revision: result.value.revision },
            new Set([client.connId]),
          );
        } catch (error) {
          if (previous) {
            views.set(client, previous);
          } else {
            views.delete(client);
          }
          throw error;
        }
      }
    } catch (error) {
      connectedViewsDirty = true;
      throw error;
    }
  }

  function scheduleExpiry(retryAfterMs?: number): void {
    if (!active || (processed.size === 0 && retryAfterMs === undefined)) {
      return;
    }
    const deadline = retryAfterMs === undefined ? nextExpiryAt : Date.now() + retryAfterMs;
    if (expiryTimer && expiryTimerAt <= deadline) {
      return;
    }
    if (expiryTimer) {
      clearTimeout(expiryTimer);
    }
    expiryTimerAt = deadline;
    expiryTimer = setTimeout(
      () => {
        expiryTimer = undefined;
        expiryTimerAt = Infinity;
        void enqueue(refresh);
      },
      Math.max(1, deadline - Date.now()),
    );
    expiryTimer.unref?.();
  }

  async function refresh(): Promise<void> {
    if (!active) {
      return;
    }
    try {
      await maintain();
      refreshConnectedViews();
      scheduleExpiry();
    } catch {
      log.warn("Unable to refresh the mention Inbox; current reads will retry.");
      scheduleExpiry(60_000);
    }
  }

  function invalidate(sessionKey?: string): Promise<void> {
    policy.invalidateTargets(sessionKey);
    return enqueue(refresh);
  }

  // Profile writes publish after commit. The microtask also follows role-policy cache invalidation.
  const stopProfiles = onUserProfilesChanged(() => {
    if (profileInvalidationPending) {
      return;
    }
    profileInvalidationPending = true;
    queueMicrotask(() => {
      profileInvalidationPending = false;
      void enqueue(refresh);
    });
  });
  const stopSessions = onSessionIdentityMutation(() => {
    void invalidate();
  });

  function unavailable(warn = false): Result<never, ErrorShape> {
    if (warn) {
      log.warn("The mention Inbox could not read or save its current state. Reconnect to retry.");
    }
    return err(
      errorShape(ErrorCodes.UNAVAILABLE, "The mention Inbox is unavailable. Reconnect to retry.", {
        retryable: true,
      }),
    );
  }

  function readOperation<T>(operation: () => Result<T, ErrorShape>): Result<T, ErrorShape> {
    if (active) {
      try {
        return operation();
      } catch {
        return unavailable(true);
      }
    }
    return unavailable();
  }

  void enqueue(refresh);

  return {
    mentionable(client, received, publish) {
      const input = { ...received };
      return enqueue(async () => {
        let preparationFailure: Result<never, ErrorShape> | undefined;
        try {
          // A committed profile change can invalidate preparation before this continuation runs.
          const preparation = {
            directory: true,
            profileIds: client?.authenticatedUserProfile
              ? [client.authenticatedUserProfile.profileId]
              : [],
            targets:
              "sessionKey" in input
                ? [{ sessionKey: input.sessionKey, agentId: input.agentId }]
                : [],
          };
          while (policy.needsPreparation(preparation)) {
            await policy.prepare(preparation);
          }
        } catch {
          preparationFailure = unavailable(true);
        }
        // Current policy selection and response publication must not cross another await.
        publish(preparationFailure ?? readOperation(() => policy.mentionable(client, input)));
      });
    },
    validateRecipients(client, received, profileIds) {
      const input = { ...received };
      const capturedIds = [...profileIds];
      return enqueue(async () => {
        try {
          const preparation = {
            profileIds: [
              ...capturedIds,
              ...(client?.authenticatedUserProfile
                ? [client.authenticatedUserProfile.profileId]
                : []),
            ],
            targets:
              "sessionKey" in input
                ? [{ sessionKey: input.sessionKey, agentId: input.agentId }]
                : [],
          };
          while (policy.needsPreparation(preparation)) {
            await policy.prepare(preparation);
          }
          return readOperation(() => policy.validateRecipients(client, input, capturedIds));
        } catch {
          return unavailable(true);
        }
      });
    },
    list(client: GatewayClient | null, publish): Promise<void> {
      return enqueue(async () => {
        try {
          await maintain();
          await preparePolicy(
            [],
            client?.authenticatedUserProfile ? [client.authenticatedUserProfile.profileId] : [],
          );
          if (connectedViewsDirty) {
            refreshConnectedViews();
          }
        } catch {
          publish(unavailable(true));
          return;
        }
        scheduleExpiry();
        // Authorization and response share this continuation, not a resolved result Promise.
        publish(readOperation(() => readView(client)));
      });
    },
    dismiss(client: GatewayClient | null, ids: readonly string[], publish): Promise<void> {
      const capturedIds = [...ids];
      return enqueue(async () => {
        let result: Result<MentionsListResult, ErrorShape>;
        try {
          await maintain();
          await preparePolicy(
            [],
            client?.authenticatedUserProfile ? [client.authenticatedUserProfile.profileId] : [],
          );
          const identified = policy.identify(client, params.getRuntimeConfig());
          if (!identified.ok) {
            result = identified;
          } else {
            const profileId = identified.value.profile.profileId;
            const current = readView(client, params.getRuntimeConfig(), false);
            if (!current.ok) {
              result = current;
            } else {
              const owned = new Set(current.value.items.map((item) => item.id));
              await mutate(
                { kind: "dismiss", profileId, ids: capturedIds.filter((id) => owned.has(id)) },
                () => {
                  const latest = policy.identify(client, params.getRuntimeConfig());
                  if (!latest.ok || latest.value.profile.profileId !== profileId) {
                    throw new Error("Mention dismissal owner changed");
                  }
                },
              );
              await preparePolicy(
                [],
                client?.authenticatedUserProfile ? [client.authenticatedUserProfile.profileId] : [],
              );
              refreshConnectedViews();
              result = readOperation(() => readView(client));
            }
          }
        } catch {
          result = unavailable(true);
        }
        publish(result);
      });
    },
    recordCommittedInput(received: MentionCommittedInput): Promise<void> {
      if (!active || received.recipientProfileIds.length === 0) {
        return Promise.resolve();
      }
      const input = structuredClone(received);
      return enqueue(async () => {
        try {
          assertCurrent();
          const references = [
            input.sourceId,
            input.sessionId,
            input.messageId,
            input.senderProfileId,
            ...input.recipientProfileIds,
          ];
          if (
            input.recipientProfileIds.length > MAX_HUMAN_MENTIONS ||
            input.sessionKey.length > 512 ||
            references.some((value) => !value || value.length > 256)
          ) {
            log.warn("Skipped mention delivery with invalid committed references.");
            return;
          }
          await synchronize();
          await preparePolicy(
            [{ sessionKey: input.sessionKey, agentId: input.agentId }],
            [input.senderProfileId, ...input.recipientProfileIds],
          );
          const cfg = params.getRuntimeConfig();
          const resolved = policy.resolveTarget({
            sessionKey: input.sessionKey,
            agentId: input.agentId,
          });
          if (
            !resolved ||
            resolved.entry.sessionId !== input.sessionId ||
            resolved.entry.incognito === true ||
            isIncognitoSessionKey(resolved.canonicalKey)
          ) {
            return;
          }
          const target = {
            agentId: resolved.agentId,
            sessionKey: resolved.canonicalKey,
            entry: resolved.entry,
          };
          const sender = policy.readProfile(input.senderProfileId);
          const recipients = input.recipientProfileIds.map((profileId) => {
            const recipient = policy.recipientProfile(profileId, target, cfg);
            return {
              profileId: recipient?.profileId ?? profileId,
              id:
                sender && recipient && sender.profileId !== recipient.profileId
                  ? randomUUID()
                  : null,
              excerptProfileId: profileId,
            };
          });
          const { assertPolicy, assertTarget } = createCommittedMentionAuthority({
            input,
            resolved,
            recipients,
            policy,
            cfg,
            getRuntimeConfig: params.getRuntimeConfig,
            assertCurrent,
          });
          // Involvement was always a separate agent-database commit, not part of Inbox atomicity.
          const involved = await updateSessionProfileInvolvement(
            {
              agentId: resolved.agentId,
              sessionKey: resolved.storeKey,
              storePath: resolved.storePath,
              database: resolved.database,
            },
            {
              expectedSessionId: input.sessionId,
              profileIds: recipients.filter((value) => value.id).map((value) => value.profileId),
              change: { kind: "mention", source: input.committedSource },
              assertCurrent: assertPolicy,
              prepareMutation: async () => {
                await preparePolicy(
                  [{ sessionKey: input.sessionKey, agentId: input.agentId }],
                  [input.senderProfileId, ...input.recipientProfileIds],
                );
                assertTarget();
                return assertTarget;
              },
            },
          );
          if (!involved) {
            return;
          }
          await preparePolicy(
            [{ sessionKey: input.sessionKey, agentId: input.agentId }],
            [input.senderProfileId, ...input.recipientProfileIds],
          );
          assertTarget();
          const prepared = prepareMentionExcerpts(
            input.excerpt ?? "",
            input.mentions ?? [],
            redactSensitiveText,
          );
          const sourceKey = createHash("sha256")
            .update(
              JSON.stringify([
                resolved.agentId,
                resolved.canonicalKey,
                input.sessionId,
                input.sourceId,
              ]),
            )
            .digest("hex");
          const committed = await mutate(
            {
              kind: "record",
              sourceKey,
              recipients,
              message: {
                sessionId: input.sessionId,
                content: {
                  senderProfileId: sender?.profileId ?? input.senderProfileId,
                  sessionKey: target.sessionKey,
                  agentId: target.agentId,
                  messageId: input.messageId,
                  createdAt: Date.now(),
                  ...(prepared.fallback ? { excerpt: prepared.fallback } : {}),
                },
                recipientExcerpts: prepared.recipients,
              },
            },
            assertTarget,
          );
          scheduleExpiry();
          if (committed.capacityReached) {
            log.warn(
              "Mention retention reached its replay budget; new mention alerts are skipped until retained sources expire.",
            );
          }
          try {
            await preparePolicy();
            refreshConnectedViews();
          } catch {
            log.warn("Mention view publication failed; connected views will retry.");
          }
          if (!params.onMentionCreated) {
            return;
          }
          for (const id of committed.createdIds) {
            const item = items.get(id);
            const current = item && currentTarget(item, params.getRuntimeConfig());
            if (!item || !current) {
              continue;
            }
            const projected = projectMentionInboxItem(item, current);
            try {
              params.onMentionCreated({
                id,
                recipientProfileId: current.recipient.profileId,
                sessionKey: projected.sessionKey,
                agentId: projected.agentId,
                senderLabel: projected.senderLabel,
                sessionTitle: projected.sessionTitle,
                prepare: () =>
                  enqueue(async () => {
                    await maintain();
                  }),
                // Final push fencing is deliberately SQL-free and synchronous.
                isCurrent: () => {
                  try {
                    const latest = items.get(id);
                    return Boolean(latest && currentTarget(latest, params.getRuntimeConfig()));
                  } catch {
                    return false;
                  }
                },
              });
            } catch {
              log.warn("Mention push callback failed; the Inbox item is still retained.");
            }
          }
        } catch (error) {
          head = { revision: -1, nextSequence: 0 };
          log.warn(
            `Mention delivery could not be completed; the posted message is unchanged. ${formatErrorMessage(error)}`,
          );
        }
      });
    },
    invalidate,
    dispose(): Promise<void> {
      active = false;
      stopProfiles();
      stopSessions();
      policy.dispose();
      if (expiryTimer) {
        clearTimeout(expiryTimer);
        expiryTimer = undefined;
      }
      disposed ??= tail.then(() => {
        items.clear();
        itemsByProfile.clear();
        processed.clear();
      });
      return disposed;
    },
  };
}
