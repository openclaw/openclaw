import { Routes } from "discord-api-types/v10";
import { logVerbose } from "../../globals.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { createDiscordRestClient } from "../client.js";
import {
  createThreadForBinding,
  createWebhookForChannel,
  findReusableWebhook,
  isDiscordThreadGoneError,
  isThreadArchived,
  maybeSendBindingMessage,
  resolveChannelIdForBinding,
  summarizeDiscordError,
} from "./thread-bindings.discord-api.js";
import {
  resolveThreadBindingFarewellText,
  resolveThreadBindingThreadName,
} from "./thread-bindings.messages.js";
import {
  BINDINGS_BY_THREAD_ID,
  forgetThreadBindingToken,
  getThreadBindingToken,
  MANAGERS_BY_ACCOUNT_ID,
  PERSIST_BY_ACCOUNT_ID,
  ensureBindingsLoaded,
  rememberThreadBindingToken,
  normalizeTargetKind,
  normalizeThreadBindingDurationMs,
  normalizeThreadId,
  rememberRecentUnboundWebhookEcho,
  removeBindingRecord,
  resolveBindingIdsForSession,
  resolveBindingRecordKey,
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingInactivityExpiresAt,
  resolveThreadBindingMaxAgeExpiresAt,
  resolveThreadBindingMaxAgeMs,
  resolveThreadBindingsPath,
  saveBindingsToDisk,
  setBindingRecord,
  THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS,
  shouldDefaultPersist,
  resetThreadBindingsForTests,
} from "./thread-bindings.state.js";
import {
  DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  DEFAULT_THREAD_BINDING_MAX_AGE_MS,
  THREAD_BINDINGS_SWEEP_INTERVAL_MS,
  type ThreadBindingManager,
  type ThreadBindingRecord,
} from "./thread-bindings.types.js";

function registerManager(manager: ThreadBindingManager) {
  MANAGERS_BY_ACCOUNT_ID.set(manager.accountId, manager);
}

function unregisterManager(accountId: string, manager: ThreadBindingManager) {
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing === manager) {
    MANAGERS_BY_ACCOUNT_ID.delete(accountId);
  }
}

function resolveEffectiveBindingExpiresAt(params: {
  record: ThreadBindingRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): number | undefined {
  const inactivityExpiresAt = resolveThreadBindingInactivityExpiresAt({
    record: params.record,
    defaultIdleTimeoutMs: params.defaultIdleTimeoutMs,
  });
  const maxAgeExpiresAt = resolveThreadBindingMaxAgeExpiresAt({
    record: params.record,
    defaultMaxAgeMs: params.defaultMaxAgeMs,
  });
  if (inactivityExpiresAt != null && maxAgeExpiresAt != null) {
    return Math.min(inactivityExpiresAt, maxAgeExpiresAt);
  }
  return inactivityExpiresAt ?? maxAgeExpiresAt;
}

function createNoopManager(accountIdRaw?: string): ThreadBindingManager {
  const accountId = normalizeAccountId(accountIdRaw);
  return {
    accountId,
    getIdleTimeoutMs: () => DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
    getMaxAgeMs: () => DEFAULT_THREAD_BINDING_MAX_AGE_MS,
    getByThreadId: () => undefined,
    getBySessionKey: () => undefined,
    listBySessionKey: () => [],
    listBindings: () => [],
    touchThread: () => null,
    bindTarget: async () => null,
    unbindThread: () => null,
    unbindBySessionKey: () => [],
    stop: () => {},
  };
}

function toSessionBindingTargetKind(raw: string): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toThreadBindingTargetKind(raw: BindingTargetKind): "subagent" | "acp" {
  return raw === "subagent" ? "subagent" : "acp";
}

function toSessionBindingRecord(
  record: ThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  const bindingId =
    resolveBindingRecordKey({
      accountId: record.accountId,
      threadId: record.threadId,
    }) ?? `${record.accountId}:${record.threadId}`;
  return {
    bindingId,
    targetSessionKey: record.targetSessionKey,
    targetKind: toSessionBindingTargetKind(record.targetKind),
    conversation: {
      channel: "discord",
      accountId: record.accountId,
      conversationId: record.threadId,
      parentConversationId: record.channelId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt: resolveEffectiveBindingExpiresAt({
      record,
      defaultIdleTimeoutMs: defaults.idleTimeoutMs,
      defaultMaxAgeMs: defaults.maxAgeMs,
    }),
    metadata: {
      agentId: record.agentId,
      label: record.label,
      webhookId: record.webhookId,
      webhookToken: record.webhookToken,
      boundBy: record.boundBy,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs: resolveThreadBindingIdleTimeoutMs({
        record,
        defaultIdleTimeoutMs: defaults.idleTimeoutMs,
      }),
      maxAgeMs: resolveThreadBindingMaxAgeMs({
        record,
        defaultMaxAgeMs: defaults.maxAgeMs,
      }),
    },
  };
}

function resolveThreadIdFromBindingId(params: {
  accountId: string;
  bindingId?: string;
}): string | undefined {
  const bindingId = params.bindingId?.trim();
  if (!bindingId) {
    return undefined;
  }
  const prefix = `${params.accountId}:`;
  if (!bindingId.startsWith(prefix)) {
    return undefined;
  }
  const threadId = bindingId.slice(prefix.length).trim();
  return threadId || undefined;
}

export function createThreadBindingManager(
  params: {
    accountId?: string;
    token?: string;
    persist?: boolean;
    enableSweeper?: boolean;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
  } = {},
): ThreadBindingManager {
  ensureBindingsLoaded();
  const accountId = normalizeAccountId(params.accountId);
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing) {
    rememberThreadBindingToken({ accountId, token: params.token });
    return existing;
  }

  rememberThreadBindingToken({ accountId, token: params.token });

  const persist = params.persist ?? shouldDefaultPersist();
  PERSIST_BY_ACCOUNT_ID.set(accountId, persist);
  const idleTimeoutMs = normalizeThreadBindingDurationMs(
    params.idleTimeoutMs,
    DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  );
  const maxAgeMs = normalizeThreadBindingDurationMs(
    params.maxAgeMs,
    DEFAULT_THREAD_BINDING_MAX_AGE_MS,
  );
  const resolveCurrentToken = () => getThreadBindingToken(accountId) ?? params.token;

  let sweepTimer: NodeJS.Timeout | null = null;

  const manager: ThreadBindingManager = {
    accountId,
    getIdleTimeoutMs: () => idleTimeoutMs,
    getMaxAgeMs: () => maxAgeMs,
    getByThreadId: (threadId) => {
      const key = resolveBindingRecordKey({
        accountId,
        threadId,
      });
      if (!key) {
        return undefined;
      }
      const entry = BINDINGS_BY_THREAD_ID.get(key);
      if (!entry || entry.accountId !== accountId) {
        return undefined;
      }
      return entry;
    },
    getBySessionKey: (targetSessionKey) => {
      const all = manager.listBySessionKey(targetSessionKey);
      return all[0];
    },
    listBySessionKey: (targetSessionKey) => {
      const ids = resolveBindingIdsForSession({
        targetSessionKey,
        accountId,
      });
      return ids
        .map((bindingKey) => BINDINGS_BY_THREAD_ID.get(bindingKey))
        .filter((entry): entry is ThreadBindingRecord => Boolean(entry));
    },
    listBindings: () =>
      [...BINDINGS_BY_THREAD_ID.values()].filter((entry) => entry.accountId === accountId),
    touchThread: (touchParams) => {
      const key = resolveBindingRecordKey({
        accountId,
        threadId: touchParams.threadId,
      });
      if (!key) {
        return null;
      }
      const existing = BINDINGS_BY_THREAD_ID.get(key);
      if (!existing || existing.accountId !== accountId) {
        return null;
      }
      const now = Date.now();
      const at =
        typeof touchParams.at === "number" && Number.isFinite(touchParams.at)
          ? Math.max(0, Math.floor(touchParams.at))
          : now;
      const nextRecord: ThreadBindingRecord = {
        ...existing,
        lastActivityAt: Math.max(existing.lastActivityAt || 0, at),
      };
      setBindingRecord(nextRecord);
      if (touchParams.persist ?? persist) {
        saveBindingsToDisk({
          minIntervalMs: THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS,
        });
      }
      return nextRecord;
    },
    bindTarget: async (bindParams) => {
      let threadId = normalizeThreadId(bindParams.threadId);
      let channelId = bindParams.channelId?.trim() || "";

      if (!threadId && bindParams.createThread) {
        if (!channelId) {
          return null;
        }
        const threadName = resolveThreadBindingThreadName({
          agentId: bindParams.agentId,
          label: bindParams.label,
        });
        threadId =
          (await createThreadForBinding({
            accountId,
            token: resolveCurrentToken(),
            channelId,
            threadName: bindParams.threadName?.trim() || threadName,
          })) ?? undefined;
      }

      if (!threadId) {
        return null;
      }

      if (!channelId) {
        channelId =
          (await resolveChannelIdForBinding({
            accountId,
            token: resolveCurrentToken(),
            threadId,
            channelId: bindParams.channelId,
          })) ?? "";
      }
      if (!channelId) {
        return null;
      }

      const targetSessionKey = bindParams.targetSessionKey.trim();
      if (!targetSessionKey) {
        return null;
      }

      const targetKind = normalizeTargetKind(bindParams.targetKind, targetSessionKey);
      let webhookId = bindParams.webhookId?.trim() || "";
      let webhookToken = bindParams.webhookToken?.trim() || "";
      if (!webhookId || !webhookToken) {
        const cachedWebhook = findReusableWebhook({ accountId, channelId });
        webhookId = cachedWebhook.webhookId ?? "";
        webhookToken = cachedWebhook.webhookToken ?? "";
      }
      if (!webhookId || !webhookToken) {
        const createdWebhook = await createWebhookForChannel({
          accountId,
          token: resolveCurrentToken(),
          channelId,
        });
        webhookId = createdWebhook.webhookId ?? "";
        webhookToken = createdWebhook.webhookToken ?? "";
      }

      const now = Date.now();
      const record: ThreadBindingRecord = {
        accountId,
        channelId,
        threadId,
        targetKind,
        targetSessionKey,
        agentId: bindParams.agentId?.trim() || resolveAgentIdFromSessionKey(targetSessionKey),
        label: bindParams.label?.trim() || undefined,
        webhookId: webhookId || undefined,
        webhookToken: webhookToken || undefined,
        boundBy: bindParams.boundBy?.trim() || "system",
        boundAt: now,
        lastActivityAt: now,
        idleTimeoutMs,
        maxAgeMs,
      };

      setBindingRecord(record);
      if (persist) {
        saveBindingsToDisk();
      }

      const introText = bindParams.introText?.trim();
      if (introText) {
        void maybeSendBindingMessage({ record, text: introText });
      }
      return record;
    },
    unbindThread: (unbindParams) => {
      const bindingKey = resolveBindingRecordKey({
        accountId,
        threadId: unbindParams.threadId,
      });
      if (!bindingKey) {
        return null;
      }
      const existing = BINDINGS_BY_THREAD_ID.get(bindingKey);
      if (!existing || existing.accountId !== accountId) {
        return null;
      }
      const removed = removeBindingRecord(bindingKey);
      if (!removed) {
        return null;
      }
      rememberRecentUnboundWebhookEcho(removed);
      if (persist) {
        saveBindingsToDisk();
      }
      if (unbindParams.sendFarewell !== false) {
        const farewell = resolveThreadBindingFarewellText({
          reason: unbindParams.reason,
          farewellText: unbindParams.farewellText,
          idleTimeoutMs: resolveThreadBindingIdleTimeoutMs({
            record: removed,
            defaultIdleTimeoutMs: idleTimeoutMs,
          }),
          maxAgeMs: resolveThreadBindingMaxAgeMs({
            record: removed,
            defaultMaxAgeMs: maxAgeMs,
          }),
        });
        // Use bot send path for farewell messages so unbound threads don't process
        // webhook echoes as fresh inbound turns when allowBots is enabled.
        void maybeSendBindingMessage({ record: removed, text: farewell, preferWebhook: false });
      }
      return removed;
    },
    unbindBySessionKey: (unbindParams) => {
      const ids = resolveBindingIdsForSession({
        targetSessionKey: unbindParams.targetSessionKey,
        accountId,
        targetKind: unbindParams.targetKind,
      });
      if (ids.length === 0) {
        return [];
      }
      const removed: ThreadBindingRecord[] = [];
      for (const bindingKey of ids) {
        const binding = BINDINGS_BY_THREAD_ID.get(bindingKey);
        if (!binding) {
          continue;
        }
        const entry = manager.unbindThread({
          threadId: binding.threadId,
          reason: unbindParams.reason,
          sendFarewell: unbindParams.sendFarewell,
          farewellText: unbindParams.farewellText,
        });
        if (entry) {
          removed.push(entry);
        }
      }
      return removed;
    },
    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      unregisterManager(accountId, manager);
      unregisterSessionBindingAdapter({
        channel: "discord",
        accountId,
      });
      forgetThreadBindingToken(accountId);
    },
  };

  if (params.enableSweeper !== false) {
    sweepTimer = setInterval(() => {
      void (async () => {
        const bindings = manager.listBindings();
        if (bindings.length === 0) {
          return;
        }
        let rest;
        try {
          rest = createDiscordRestClient({
            accountId,
            token: resolveCurrentToken(),
          }).rest;
        } catch {
          return;
        }
        for (const snapshotBinding of bindings) {
          // Re-read live state after any awaited work from earlier iterations.
          // This avoids unbinding based on stale snapshot data when activity touches
          // happen while the sweeper loop is in-flight.
          const binding = manager.getByThreadId(snapshotBinding.threadId);
          if (!binding) {
            continue;
          }
          const now = Date.now();
          const inactivityExpiresAt = resolveThreadBindingInactivityExpiresAt({
            record: binding,
            defaultIdleTimeoutMs: idleTimeoutMs,
          });
          const maxAgeExpiresAt = resolveThreadBindingMaxAgeExpiresAt({
            record: binding,
            defaultMaxAgeMs: maxAgeMs,
          });
          const expirationCandidates: Array<{
            reason: "idle-expired" | "max-age-expired";
            at: number;
          }> = [];
          if (inactivityExpiresAt != null && now >= inactivityExpiresAt) {
            expirationCandidates.push({ reason: "idle-expired", at: inactivityExpiresAt });
          }
          if (maxAgeExpiresAt != null && now >= maxAgeExpiresAt) {
            expirationCandidates.push({ reason: "max-age-expired", at: maxAgeExpiresAt });
          }
          if (expirationCandidates.length > 0) {
            expirationCandidates.sort((a, b) => a.at - b.at);
            const reason = expirationCandidates[0]?.reason ?? "idle-expired";
            manager.unbindThread({
              threadId: binding.threadId,
              reason,
              sendFarewell: true,
              farewellText: resolveThreadBindingFarewellText({
                reason,
                idleTimeoutMs: resolveThreadBindingIdleTimeoutMs({
                  record: binding,
                  defaultIdleTimeoutMs: idleTimeoutMs,
                }),
                maxAgeMs: resolveThreadBindingMaxAgeMs({
                  record: binding,
                  defaultMaxAgeMs: maxAgeMs,
                }),
              }),
            });
            continue;
          }
          try {
            const channel = await rest.get(Routes.channel(binding.threadId));
            if (!channel || typeof channel !== "object") {
              logVerbose(
                `discord thread binding sweep probe returned invalid payload for ${binding.threadId}`,
              );
              continue;
            }
            if (isThreadArchived(channel)) {
              manager.unbindThread({
                threadId: binding.threadId,
                reason: "thread-archived",
                sendFarewell: true,
              });
            }
          } catch (err) {
            if (isDiscordThreadGoneError(err)) {
              logVerbose(
                `discord thread binding sweep removing stale binding ${binding.threadId}: ${summarizeDiscordError(err)}`,
              );
              manager.unbindThread({
                threadId: binding.threadId,
                reason: "thread-delete",
                sendFarewell: false,
              });
              continue;
            }
            logVerbose(
              `discord thread binding sweep probe failed for ${binding.threadId}: ${summarizeDiscordError(err)}`,
            );
          }
        }
      })();
    }, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  registerSessionBindingAdapter({
    channel: "discord",
    accountId,
    capabilities: {
      placements: ["current", "child"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== "discord") {
        return null;
      }
      const targetSessionKey = input.targetSessionKey.trim();
      if (!targetSessionKey) {
        return null;
      }
      const conversationId = input.conversation.conversationId.trim();
      const placement = input.placement === "child" ? "child" : "current";
      const metadata = input.metadata ?? {};
      const label =
        typeof metadata.label === "string" ? metadata.label.trim() || undefined : undefined;
      const threadName =
        typeof metadata.threadName === "string"
          ? metadata.threadName.trim() || undefined
          : undefined;
      const introText =
        typeof metadata.introText === "string" ? metadata.introText.trim() || undefined : undefined;
      const boundBy =
        typeof metadata.boundBy === "string" ? metadata.boundBy.trim() || undefined : undefined;
      const agentId =
        typeof metadata.agentId === "string" ? metadata.agentId.trim() || undefined : undefined;
      let threadId: string | undefined;
      let channelId = input.conversation.parentConversationId?.trim() || undefined;
      let createThread = false;

      if (placement === "child") {
        createThread = true;
        if (!channelId && conversationId) {
          channelId =
            (await resolveChannelIdForBinding({
              accountId,
              token: resolveCurrentToken(),
              threadId: conversationId,
            })) ?? undefined;
        }
      } else {
        threadId = conversationId || undefined;
      }
      const bound = await manager.bindTarget({
        threadId,
        channelId,
        createThread,
        threadName,
        targetKind: toThreadBindingTargetKind(input.targetKind),
        targetSessionKey,
        agentId,
        label,
        boundBy,
        introText,
      });
      return bound
        ? toSessionBindingRecord(bound, {
            idleTimeoutMs,
            maxAgeMs,
          })
        : null;
    },
    listBySession: (targetSessionKey) =>
      manager
        .listBySessionKey(targetSessionKey)
        .map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs })),
    resolveByConversation: (ref) => {
      if (ref.channel !== "discord") {
        return null;
      }
      const binding = manager.getByThreadId(ref.conversationId);
      return binding ? toSessionBindingRecord(binding, { idleTimeoutMs, maxAgeMs }) : null;
    },
    touch: (bindingId, at) => {
      const threadId = resolveThreadIdFromBindingId({ accountId, bindingId });
      if (!threadId) {
        return;
      }
      manager.touchThread({ threadId, at, persist: true });
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        const removed = manager.unbindBySessionKey({
          targetSessionKey: input.targetSessionKey,
          reason: input.reason,
        });
        return removed.map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs }));
      }
      const threadId = resolveThreadIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!threadId) {
        return [];
      }
      const removed = manager.unbindThread({
        threadId,
        reason: input.reason,
      });
      return removed ? [toSessionBindingRecord(removed, { idleTimeoutMs, maxAgeMs })] : [];
    },
  });

  registerManager(manager);
  return manager;
}

export function createNoopThreadBindingManager(accountId?: string): ThreadBindingManager {
  return createNoopManager(accountId);
}

export function getThreadBindingManager(accountId?: string): ThreadBindingManager | null {
  const normalized = normalizeAccountId(accountId);
  return MANAGERS_BY_ACCOUNT_ID.get(normalized) ?? null;
}

export const __testing = {
  resolveThreadBindingsPath,
  resolveThreadBindingThreadName,
  resetThreadBindingsForTests,
};
