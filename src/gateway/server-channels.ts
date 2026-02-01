import type { ChannelAccountSnapshot } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { type ChannelId, getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import { formatErrorMessage } from "../infra/errors.js";
import { computeBackoff } from "../infra/backoff.js";
import { formatDurationMs } from "../infra/format-duration.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

/**
 * Auto-restart policy for channels that exit unexpectedly.
 * Uses exponential backoff starting at 2s, capping at 60s.
 */
const CHANNEL_RESTART_POLICY = {
  initialMs: 2000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0.2,
};

/** Maximum consecutive restart attempts before giving up. */
const MAX_RESTART_ATTEMPTS = 10;

/** Reset restart attempts after this many ms of successful running. */
const RESTART_ATTEMPT_RESET_MS = 5 * 60 * 1000; // 5 minutes

export type ChannelRuntimeSnapshot = {
  channels: Partial<Record<ChannelId, ChannelAccountSnapshot>>;
  channelAccounts: Partial<Record<ChannelId, Record<string, ChannelAccountSnapshot>>>;
};

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type ChannelRuntimeStore = {
  aborts: Map<string, AbortController>;
  tasks: Map<string, Promise<unknown>>;
  runtimes: Map<string, ChannelAccountSnapshot>;
  /** Track restart attempts per account for backoff/giving up. */
  restartAttempts: Map<string, number>;
  /** Track when the channel started (for measuring run duration). */
  channelStartTime: Map<string, number>;
  /** Track pending restart timers so they can be cancelled. */
  restartTimers: Map<string, ReturnType<typeof setTimeout>>;
};

function createRuntimeStore(): ChannelRuntimeStore {
  return {
    aborts: new Map(),
    tasks: new Map(),
    runtimes: new Map(),
    restartAttempts: new Map(),
    channelStartTime: new Map(),
    restartTimers: new Map(),
  };
}

function isAccountEnabled(account: unknown): boolean {
  if (!account || typeof account !== "object") {
    return true;
  }
  const enabled = (account as { enabled?: boolean }).enabled;
  return enabled !== false;
}

function resolveDefaultRuntime(channelId: ChannelId): ChannelAccountSnapshot {
  const plugin = getChannelPlugin(channelId);
  return plugin?.status?.defaultRuntime ?? { accountId: DEFAULT_ACCOUNT_ID };
}

function cloneDefaultRuntime(channelId: ChannelId, accountId: string): ChannelAccountSnapshot {
  return { ...resolveDefaultRuntime(channelId), accountId };
}

type ChannelManagerOptions = {
  loadConfig: () => OpenClawConfig;
  channelLogs: Record<ChannelId, SubsystemLogger>;
  channelRuntimeEnvs: Record<ChannelId, RuntimeEnv>;
};

export type ChannelManager = {
  getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
  startChannels: () => Promise<void>;
  startChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
  stopChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
  markChannelLoggedOut: (channelId: ChannelId, cleared: boolean, accountId?: string) => void;
};

// Channel docking: lifecycle hooks (`plugin.gateway`) flow through this manager.
export function createChannelManager(opts: ChannelManagerOptions): ChannelManager {
  const { loadConfig, channelLogs, channelRuntimeEnvs } = opts;

  const channelStores = new Map<ChannelId, ChannelRuntimeStore>();

  const getStore = (channelId: ChannelId): ChannelRuntimeStore => {
    const existing = channelStores.get(channelId);
    if (existing) {
      return existing;
    }
    const next = createRuntimeStore();
    channelStores.set(channelId, next);
    return next;
  };

  const getRuntime = (channelId: ChannelId, accountId: string): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    return store.runtimes.get(accountId) ?? cloneDefaultRuntime(channelId, accountId);
  };

  const setRuntime = (
    channelId: ChannelId,
    accountId: string,
    patch: ChannelAccountSnapshot,
  ): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    const current = getRuntime(channelId, accountId);
    const next = { ...current, ...patch, accountId };
    store.runtimes.set(accountId, next);
    return next;
  };

  const startChannel = async (channelId: ChannelId, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    const startAccount = plugin?.gateway?.startAccount;
    if (!startAccount) {
      return;
    }
    const cfg = loadConfig();
    resetDirectoryCache({ channel: channelId, accountId });
    const store = getStore(channelId);
    const accountIds = accountId ? [accountId] : plugin.config.listAccountIds(cfg);
    if (accountIds.length === 0) {
      return;
    }

    await Promise.all(
      accountIds.map(async (id) => {
        if (store.tasks.has(id)) {
          return;
        }
        const account = plugin.config.resolveAccount(cfg, id);
        const enabled = plugin.config.isEnabled
          ? plugin.config.isEnabled(account, cfg)
          : isAccountEnabled(account);
        if (!enabled) {
          setRuntime(channelId, id, {
            accountId: id,
            running: false,
            lastError: plugin.config.disabledReason?.(account, cfg) ?? "disabled",
          });
          return;
        }

        let configured = true;
        if (plugin.config.isConfigured) {
          configured = await plugin.config.isConfigured(account, cfg);
        }
        if (!configured) {
          setRuntime(channelId, id, {
            accountId: id,
            running: false,
            lastError: plugin.config.unconfiguredReason?.(account, cfg) ?? "not configured",
          });
          return;
        }

        const abort = new AbortController();
        store.aborts.set(id, abort);
        setRuntime(channelId, id, {
          accountId: id,
          running: true,
          lastStartAt: Date.now(),
          lastError: null,
        });

        const log = channelLogs[channelId];
        // Record start time for measuring run duration
        store.channelStartTime.set(id, Date.now());

        // Cancel any pending restart timer (prevents race conditions)
        const existingTimer = store.restartTimers.get(id);
        if (existingTimer) {
          clearTimeout(existingTimer);
          store.restartTimers.delete(id);
        }

        const task = startAccount({
          cfg,
          accountId: id,
          account,
          runtime: channelRuntimeEnvs[channelId],
          abortSignal: abort.signal,
          log,
          getStatus: () => getRuntime(channelId, id),
          setStatus: (next) => setRuntime(channelId, id, next),
        });

        let exitedWithError = false;
        const tracked = Promise.resolve(task)
          .catch((err) => {
            exitedWithError = true;
            const message = formatErrorMessage(err);
            setRuntime(channelId, id, { accountId: id, lastError: message });
            log.error?.(`[${id}] channel exited: ${message}`);
          })
          .finally(() => {
            const wasAborted = abort.signal.aborted;
            store.aborts.delete(id);
            store.tasks.delete(id);
            setRuntime(channelId, id, {
              accountId: id,
              running: false,
              lastStopAt: Date.now(),
            });

            // Auto-restart logic: restart if not deliberately stopped
            if (!wasAborted) {
              const startTime = store.channelStartTime.get(id) ?? 0;
              const runDuration = Date.now() - startTime;
              store.channelStartTime.delete(id);

              // Reset attempt counter if ran without error for a while
              // Only reset if we didn't exit with an error (indicates healthy operation)
              if (!exitedWithError && runDuration >= RESTART_ATTEMPT_RESET_MS) {
                store.restartAttempts.set(id, 0);
              }

              const attempts = (store.restartAttempts.get(id) ?? 0) + 1;
              store.restartAttempts.set(id, attempts);

              if (attempts <= MAX_RESTART_ATTEMPTS) {
                const delayMs = computeBackoff(CHANNEL_RESTART_POLICY, attempts);
                const reason = exitedWithError ? "error" : "unexpected exit";
                log.warn?.(
                  `[${id}] channel ${reason}; scheduling restart in ${formatDurationMs(delayMs)} (attempt ${attempts}/${MAX_RESTART_ATTEMPTS})`,
                );

                // Cancel any existing restart timer before scheduling new one
                const existingTimer = store.restartTimers.get(id);
                if (existingTimer) {
                  clearTimeout(existingTimer);
                }

                // Schedule restart
                const timer = setTimeout(() => {
                  store.restartTimers.delete(id);
                  // Re-check if channel should still restart
                  // Skip if already running, has a pending task, or timer was orphaned
                  if (store.aborts.has(id) || store.tasks.has(id)) {
                    log.debug?.(`[${id}] skipping scheduled restart; channel already running`);
                    return;
                  }
                  void startChannel(channelId, id);
                }, delayMs);
                store.restartTimers.set(id, timer);
              } else {
                log.error?.(
                  `[${id}] channel exceeded max restart attempts (${MAX_RESTART_ATTEMPTS}); giving up. Manual restart required.`,
                );
                setRuntime(channelId, id, {
                  accountId: id,
                  lastError: `exceeded max restart attempts (${MAX_RESTART_ATTEMPTS})`,
                });
              }
            }
          });
        store.tasks.set(id, tracked);
      }),
    );
  };

  const stopChannel = async (channelId: ChannelId, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    const cfg = loadConfig();
    const store = getStore(channelId);
    const knownIds = new Set<string>([
      ...store.aborts.keys(),
      ...store.tasks.keys(),
      ...(plugin ? plugin.config.listAccountIds(cfg) : []),
    ]);
    if (accountId) {
      knownIds.clear();
      knownIds.add(accountId);
    }

    await Promise.all(
      Array.from(knownIds.values()).map(async (id) => {
        // Cancel any pending restart timer
        const restartTimer = store.restartTimers.get(id);
        if (restartTimer) {
          clearTimeout(restartTimer);
          store.restartTimers.delete(id);
        }
        // Reset restart attempts and clear start time on deliberate stop
        store.restartAttempts.delete(id);
        store.channelStartTime.delete(id);

        const abort = store.aborts.get(id);
        const task = store.tasks.get(id);
        if (!abort && !task && !plugin?.gateway?.stopAccount) {
          return;
        }
        abort?.abort();
        if (plugin?.gateway?.stopAccount) {
          const account = plugin.config.resolveAccount(cfg, id);
          await plugin.gateway.stopAccount({
            cfg,
            accountId: id,
            account,
            runtime: channelRuntimeEnvs[channelId],
            abortSignal: abort?.signal ?? new AbortController().signal,
            log: channelLogs[channelId],
            getStatus: () => getRuntime(channelId, id),
            setStatus: (next) => setRuntime(channelId, id, next),
          });
        }
        try {
          await task;
        } catch {
          // ignore
        }
        store.aborts.delete(id);
        store.tasks.delete(id);
        setRuntime(channelId, id, {
          accountId: id,
          running: false,
          lastStopAt: Date.now(),
        });
      }),
    );
  };

  const startChannels = async () => {
    for (const plugin of listChannelPlugins()) {
      await startChannel(plugin.id);
    }
  };

  const markChannelLoggedOut = (channelId: ChannelId, cleared: boolean, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      return;
    }
    const cfg = loadConfig();
    const resolvedId =
      accountId ??
      resolveChannelDefaultAccountId({
        plugin,
        cfg,
      });
    const current = getRuntime(channelId, resolvedId);
    const next: ChannelAccountSnapshot = {
      accountId: resolvedId,
      running: false,
      lastError: cleared ? "logged out" : current.lastError,
    };
    if (typeof current.connected === "boolean") {
      next.connected = false;
    }
    setRuntime(channelId, resolvedId, next);
  };

  const getRuntimeSnapshot = (): ChannelRuntimeSnapshot => {
    const cfg = loadConfig();
    const channels: ChannelRuntimeSnapshot["channels"] = {};
    const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};
    for (const plugin of listChannelPlugins()) {
      const store = getStore(plugin.id);
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const accounts: Record<string, ChannelAccountSnapshot> = {};
      for (const id of accountIds) {
        const account = plugin.config.resolveAccount(cfg, id);
        const enabled = plugin.config.isEnabled
          ? plugin.config.isEnabled(account, cfg)
          : isAccountEnabled(account);
        const described = plugin.config.describeAccount?.(account, cfg);
        const configured = described?.configured;
        const current = store.runtimes.get(id) ?? cloneDefaultRuntime(plugin.id, id);
        const next = { ...current, accountId: id };
        if (!next.running) {
          if (!enabled) {
            next.lastError ??= plugin.config.disabledReason?.(account, cfg) ?? "disabled";
          } else if (configured === false) {
            next.lastError ??= plugin.config.unconfiguredReason?.(account, cfg) ?? "not configured";
          }
        }
        accounts[id] = next;
      }
      const defaultAccount =
        accounts[defaultAccountId] ?? cloneDefaultRuntime(plugin.id, defaultAccountId);
      channels[plugin.id] = defaultAccount;
      channelAccounts[plugin.id] = accounts;
    }
    return { channels, channelAccounts };
  };

  return {
    getRuntimeSnapshot,
    startChannels,
    startChannel,
    stopChannel,
    markChannelLoggedOut,
  };
}
