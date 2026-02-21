import { Routes } from "discord-api-types/v10";
import { logVerbose } from "../../globals.js";
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
  BINDINGS_BY_THREAD_ID,
  MANAGERS_BY_ACCOUNT_ID,
  PERSIST_BY_ACCOUNT_ID,
  ensureBindingsLoaded,
  normalizeTargetKind,
  normalizeThreadBindingTtlMs,
  normalizeThreadId,
  rememberRecentUnboundWebhookEcho,
  removeBindingRecord,
  resolveBindingIdsForSession,
  resolveBindingRecordKey,
  resolveThreadBindingExpiresAt,
  resolveThreadBindingFarewellText,
  resolveThreadBindingThreadName,
  resolveThreadBindingsPath,
  saveBindingsToDisk,
  setBindingRecord,
  shouldDefaultPersist,
  resetThreadBindingsForTests,
} from "./thread-bindings.state.js";
import {
  DEFAULT_THREAD_BINDING_TTL_MS,
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

function createNoopManager(accountIdRaw?: string): ThreadBindingManager {
  const accountId = normalizeAccountId(accountIdRaw);
  return {
    accountId,
    getSessionTtlMs: () => DEFAULT_THREAD_BINDING_TTL_MS,
    getByThreadId: () => undefined,
    getBySessionKey: () => undefined,
    listBySessionKey: () => [],
    listBindings: () => [],
    bindTarget: async () => null,
    unbindThread: () => null,
    unbindBySessionKey: () => [],
    stop: () => {},
  };
}

export function createThreadBindingManager(
  params: {
    accountId?: string;
    token?: string;
    persist?: boolean;
    enableSweeper?: boolean;
    sessionTtlMs?: number;
  } = {},
): ThreadBindingManager {
  ensureBindingsLoaded();
  const accountId = normalizeAccountId(params.accountId);
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing) {
    return existing;
  }

  const persist = params.persist ?? shouldDefaultPersist();
  PERSIST_BY_ACCOUNT_ID.set(accountId, persist);
  const sessionTtlMs = normalizeThreadBindingTtlMs(params.sessionTtlMs);

  let sweepTimer: NodeJS.Timeout | null = null;

  const manager: ThreadBindingManager = {
    accountId,
    getSessionTtlMs: () => sessionTtlMs,
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
            token: params.token,
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
            token: params.token,
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
          token: params.token,
          channelId,
        });
        webhookId = createdWebhook.webhookId ?? "";
        webhookToken = createdWebhook.webhookToken ?? "";
      }

      const boundAt = Date.now();
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
        boundAt,
        expiresAt: sessionTtlMs > 0 ? boundAt + sessionTtlMs : undefined,
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
          sessionTtlMs,
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
          rest = createDiscordRestClient({ accountId, token: params.token }).rest;
        } catch {
          return;
        }
        for (const binding of bindings) {
          const expiresAt = resolveThreadBindingExpiresAt({
            record: binding,
            sessionTtlMs,
          });
          if (expiresAt != null && Date.now() >= expiresAt) {
            const ttlFromBinding = Math.max(0, expiresAt - binding.boundAt);
            manager.unbindThread({
              threadId: binding.threadId,
              reason: "ttl-expired",
              sendFarewell: true,
              farewellText: resolveThreadBindingFarewellText({
                reason: "ttl-expired",
                sessionTtlMs: ttlFromBinding,
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
