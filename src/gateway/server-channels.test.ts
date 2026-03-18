import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChannelId, type ChannelPlugin } from "../channels/plugins/types.js";
import {
  createSubsystemLogger,
  type SubsystemLogger,
  runtimeForLogger,
} from "../logging/subsystem.js";
import {
  getGlobalPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { createChannelManager } from "./server-channels.js";
import {
  ChannelLifecyclePluginRuntimeState,
  resolveChannelLifecyclePluginRuntimeState,
} from "./server-plugin-runtime-state.js";

const hoisted = vi.hoisted(() => {
  const computeBackoff = vi.fn(() => 10);
  const sleepWithAbort = vi.fn((ms: number, abortSignal?: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), ms);
      abortSignal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  });
  return { computeBackoff, sleepWithAbort };
});

vi.mock("../infra/backoff.js", () => ({
  computeBackoff: hoisted.computeBackoff,
  sleepWithAbort: hoisted.sleepWithAbort,
}));

type TestAccount = {
  enabled?: boolean;
  configured?: boolean;
};

function createTestPlugin(params?: {
  id?: ChannelId;
  account?: TestAccount;
  startAccount?: NonNullable<ChannelPlugin<TestAccount>["gateway"]>["startAccount"];
  includeDescribeAccount?: boolean;
  resolveAccount?: ChannelPlugin<TestAccount>["config"]["resolveAccount"];
  isConfigured?: ChannelPlugin<TestAccount>["config"]["isConfigured"];
}): ChannelPlugin<TestAccount> {
  const id = params?.id ?? "discord";
  const account = params?.account ?? { enabled: true, configured: true };
  const includeDescribeAccount = params?.includeDescribeAccount !== false;
  const config: ChannelPlugin<TestAccount>["config"] = {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: params?.resolveAccount ?? (() => account),
    isEnabled: (resolved) => resolved.enabled !== false,
    ...(params?.isConfigured ? { isConfigured: params.isConfigured } : {}),
  };
  if (includeDescribeAccount) {
    config.describeAccount = (resolved) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: resolved.enabled !== false,
      configured: resolved.configured !== false,
    });
  }
  const gateway: NonNullable<ChannelPlugin<TestAccount>["gateway"]> = {};
  if (params?.startAccount) {
    gateway.startAccount = params.startAccount;
  }
  return {
    id,
    meta: {
      id,
      label: id,
      selectionLabel: id,
      docsPath: `/channels/${id}`,
      blurb: "test stub",
    },
    capabilities: { chatTypes: ["direct"] },
    config,
    gateway,
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function createTestRegistry(...plugins: ChannelPlugin<TestAccount>[]): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  for (const plugin of plugins) {
    registry.channels.push({
      pluginId: plugin.id,
      source: "test",
      plugin,
    });
  }
  return registry;
}

function installTestRegistry(plugin: ChannelPlugin<TestAccount>) {
  const registry = createTestRegistry(plugin);
  setActivePluginRegistry(registry);
}

function createManager(options?: {
  channelRuntime?: PluginRuntime["channel"];
  resolveChannelRuntime?: () => PluginRuntime["channel"];
  loadConfig?: () => Record<string, unknown>;
  pluginRegistry?: PluginRegistry;
  pluginRegistryCacheKey?: string | null;
  resolvePluginRuntimeState?: () => { registry: PluginRegistry; cacheKey?: string | null } | null;
}) {
  const log = createSubsystemLogger("gateway/server-channels-test");
  const channelLogs = { discord: log } as Record<ChannelId, SubsystemLogger>;
  const runtime = runtimeForLogger(log);
  const channelRuntimeEnvs = { discord: runtime } as Record<ChannelId, RuntimeEnv>;
  return createChannelManager({
    loadConfig: () => options?.loadConfig?.() ?? {},
    channelLogs,
    channelRuntimeEnvs,
    ...(options?.pluginRegistry ? { pluginRegistry: options.pluginRegistry } : {}),
    ...(options && "pluginRegistryCacheKey" in options
      ? { pluginRegistryCacheKey: options.pluginRegistryCacheKey }
      : {}),
    ...(options?.channelRuntime ? { channelRuntime: options.channelRuntime } : {}),
    ...(options?.resolveChannelRuntime
      ? { resolveChannelRuntime: options.resolveChannelRuntime }
      : {}),
    ...(options?.resolvePluginRuntimeState
      ? { resolvePluginRuntimeState: options.resolvePluginRuntimeState }
      : {}),
  });
}

describe("server-channels auto restart", () => {
  let previousRegistry: PluginRegistry | null = null;
  let previousRegistryKey: string | null = null;
  let previousHookRegistry: PluginRegistry | null = null;

  beforeEach(() => {
    previousRegistry = getActivePluginRegistry();
    previousRegistryKey = getActivePluginRegistryKey();
    previousHookRegistry = getGlobalPluginRegistry();
    vi.useFakeTimers();
    hoisted.computeBackoff.mockClear();
    hoisted.sleepWithAbort.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    setActivePluginRegistry(
      previousRegistry ?? createEmptyPluginRegistry(),
      previousRegistryKey ?? undefined,
    );
    if (previousHookRegistry) {
      initializeGlobalHookRunner(previousHookRegistry);
    } else {
      resetGlobalHookRunner();
    }
  });

  it("caps crash-loop restarts after max attempts", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(200);

    expect(startAccount).toHaveBeenCalledTimes(11);
    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.running).toBe(false);
    expect(account?.reconnectAttempts).toBe(11);

    await vi.advanceTimersByTimeAsync(200);
    expect(startAccount).toHaveBeenCalledTimes(11);
  });

  it("does not auto-restart after manual stop during backoff", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    vi.runAllTicks();
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);

    await vi.advanceTimersByTimeAsync(200);
    expect(startAccount).toHaveBeenCalledTimes(1);
  });

  it("marks enabled/configured when account descriptors omit them", () => {
    installTestRegistry(
      createTestPlugin({
        includeDescribeAccount: false,
      }),
    );
    const manager = createManager();
    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.enabled).toBe(true);
    expect(account?.configured).toBe(true);
  });

  it("passes channelRuntime through channel gateway context when provided", async () => {
    const channelRuntime = { marker: "channel-runtime" } as unknown as PluginRuntime["channel"];
    const startAccount = vi.fn(async (ctx) => {
      expect(ctx.channelRuntime).toBe(channelRuntime);
    });

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({ channelRuntime });

    await manager.startChannels();
    expect(startAccount).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent start requests for the same account", async () => {
    const startupGate = createDeferred();
    const isConfigured = vi.fn(async () => {
      await startupGate.promise;
      return true;
    });
    const startAccount = vi.fn(async () => {});

    installTestRegistry(createTestPlugin({ startAccount, isConfigured }));
    const manager = createManager();

    const firstStart = manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    const secondStart = manager.startChannel("discord", DEFAULT_ACCOUNT_ID);

    await Promise.resolve();
    expect(isConfigured).toHaveBeenCalledTimes(1);
    expect(startAccount).not.toHaveBeenCalled();

    startupGate.resolve();
    await Promise.all([firstStart, secondStart]);

    expect(startAccount).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending startup when the account is stopped mid-boot", async () => {
    const startupGate = createDeferred();
    const isConfigured = vi.fn(async () => {
      await startupGate.promise;
      return true;
    });
    const startAccount = vi.fn(async () => {});

    installTestRegistry(createTestPlugin({ startAccount, isConfigured }));
    const manager = createManager();

    const startTask = manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    await Promise.resolve();

    const stopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    startupGate.resolve();

    await Promise.all([startTask, stopTask]);

    expect(startAccount).not.toHaveBeenCalled();
  });

  it("does not resolve channelRuntime until a channel starts", async () => {
    const channelRuntime = {
      marker: "lazy-channel-runtime",
    } as unknown as PluginRuntime["channel"];
    const resolveChannelRuntime = vi.fn(() => channelRuntime);
    const startAccount = vi.fn(async (ctx) => {
      expect(ctx.channelRuntime).toBe(channelRuntime);
    });

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({ resolveChannelRuntime });

    expect(resolveChannelRuntime).not.toHaveBeenCalled();

    void manager.getRuntimeSnapshot();
    expect(resolveChannelRuntime).not.toHaveBeenCalled();

    await manager.startChannels();

    expect(resolveChannelRuntime).toHaveBeenCalledTimes(1);
    expect(startAccount).toHaveBeenCalledTimes(1);
  });

  it("reuses plugin account resolution for health monitor overrides", () => {
    installTestRegistry(
      createTestPlugin({
        resolveAccount: (cfg, accountId) => {
          const accounts = (
            cfg as {
              channels?: {
                discord?: {
                  accounts?: Record<
                    string,
                    TestAccount & { healthMonitor?: { enabled?: boolean } }
                  >;
                };
              };
            }
          ).channels?.discord?.accounts;
          if (!accounts) {
            return { enabled: true, configured: true };
          }
          const direct = accounts[accountId ?? DEFAULT_ACCOUNT_ID];
          if (direct) {
            return direct;
          }
          const normalized = (accountId ?? DEFAULT_ACCOUNT_ID).toLowerCase().replaceAll(" ", "-");
          const matchKey = Object.keys(accounts).find(
            (key) => key.toLowerCase().replaceAll(" ", "-") === normalized,
          );
          return matchKey ? (accounts[matchKey] ?? { enabled: true, configured: true }) : {};
        },
      }),
    );

    const manager = createManager({
      loadConfig: () => ({
        channels: {
          discord: {
            accounts: {
              "Router D": {
                enabled: true,
                configured: true,
                healthMonitor: { enabled: false },
              },
            },
          },
        },
      }),
    });

    expect(manager.isHealthMonitorEnabled("discord", "router-d")).toBe(false);
  });

  it("falls back to channel-level health monitor overrides when account resolution omits them", () => {
    installTestRegistry(
      createTestPlugin({
        resolveAccount: () => ({
          enabled: true,
          configured: true,
        }),
      }),
    );

    const manager = createManager({
      loadConfig: () => ({
        channels: {
          discord: {
            healthMonitor: { enabled: false },
          },
        },
      }),
    });

    expect(manager.isHealthMonitorEnabled("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
  });

  it("uses raw account config overrides when resolvers omit health monitor fields", () => {
    installTestRegistry(
      createTestPlugin({
        resolveAccount: () => ({
          enabled: true,
          configured: true,
        }),
      }),
    );

    const manager = createManager({
      loadConfig: () => ({
        channels: {
          discord: {
            accounts: {
              [DEFAULT_ACCOUNT_ID]: {
                healthMonitor: { enabled: false },
              },
            },
          },
        },
      }),
    });

    expect(manager.isHealthMonitorEnabled("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
  });

  it("fails closed when account resolution throws during health monitor gating", () => {
    installTestRegistry(
      createTestPlugin({
        resolveAccount: () => {
          throw new Error("unresolved SecretRef");
        },
      }),
    );

    const manager = createManager();

    expect(manager.isHealthMonitorEnabled("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
  });

  it("does not treat an empty account id as the default account when matching raw overrides", () => {
    installTestRegistry(
      createTestPlugin({
        resolveAccount: () => ({
          enabled: true,
          configured: true,
        }),
      }),
    );

    const manager = createManager({
      loadConfig: () => ({
        channels: {
          discord: {
            accounts: {
              default: {
                healthMonitor: { enabled: false },
              },
            },
          },
        },
      }),
    });

    expect(manager.isHealthMonitorEnabled("discord", "")).toBe(true);
  });

  it("rebinds the active plugin registry and hook runner before channel startup", async () => {
    const startupRegistry = createEmptyPluginRegistry();
    startupRegistry.channels.push({
      pluginId: "discord",
      source: "test",
      plugin: createTestPlugin({
        startAccount: async () => {
          registerPluginHttpRoute({
            path: "/probe-webhook",
            auth: "plugin",
            pluginId: "discord",
            source: "test-webhook",
            handler: () => true,
          });
        },
      }),
    });
    // Drift to an empty registry to verify bulk startup rebinds before listing channels.
    const driftedRegistry = createEmptyPluginRegistry();

    setActivePluginRegistry(startupRegistry, "startup-registry");
    initializeGlobalHookRunner(startupRegistry);
    const manager = createManager({
      resolvePluginRuntimeState: () => ({
        registry: startupRegistry,
        cacheKey: "startup-registry",
      }),
    });

    // Simulate registry drift before a hot-reload channel restart.
    setActivePluginRegistry(driftedRegistry, "drifted-registry");
    initializeGlobalHookRunner(driftedRegistry);

    await manager.startChannels();

    expect(startupRegistry.httpRoutes).toHaveLength(1);
    expect(startupRegistry.httpRoutes[0]?.path).toBe("/probe-webhook");
    expect(driftedRegistry.httpRoutes).toHaveLength(0);
    expect(getActivePluginRegistryKey()).toBe("startup-registry");
    expect(getGlobalPluginRegistry()).toBe(startupRegistry);
  });

  it("promotes live channel runtime state when the active registry gains channels", async () => {
    const startupStartAccount = vi.fn(async () => {
      registerPluginHttpRoute({
        path: "/startup-webhook",
        auth: "plugin",
        pluginId: "discord",
        source: "test-webhook",
        handler: () => true,
      });
    });
    const bootstrappedStartAccount = vi.fn(async () => {
      registerPluginHttpRoute({
        path: "/bootstrapped-webhook",
        auth: "plugin",
        pluginId: "discord",
        source: "test-webhook",
        handler: () => true,
      });
    });
    const startupRegistry = createTestRegistry(
      createTestPlugin({
        startAccount: startupStartAccount,
      }),
    );
    const bootstrappedRegistry = createTestRegistry(
      createTestPlugin({
        startAccount: bootstrappedStartAccount,
      }),
      createTestPlugin({
        id: "telegram",
      }),
    );

    setActivePluginRegistry(startupRegistry, "startup-registry");
    initializeGlobalHookRunner(startupRegistry);
    let runtimeState: ChannelLifecyclePluginRuntimeState = {
      registry: startupRegistry,
      cacheKey: "startup-registry",
    };
    const manager = createManager({
      resolvePluginRuntimeState: () => {
        runtimeState = resolveChannelLifecyclePluginRuntimeState(runtimeState);
        return runtimeState;
      },
    });

    setActivePluginRegistry(bootstrappedRegistry, "bootstrapped-registry");
    initializeGlobalHookRunner(bootstrappedRegistry);

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);

    expect(bootstrappedStartAccount).toHaveBeenCalledTimes(1);
    expect(startupStartAccount).not.toHaveBeenCalled();
    expect(bootstrappedRegistry.httpRoutes).toHaveLength(1);
    expect(bootstrappedRegistry.httpRoutes[0]?.path).toBe("/bootstrapped-webhook");
    expect(startupRegistry.httpRoutes).toHaveLength(0);
    expect(getActivePluginRegistry()).toBe(bootstrappedRegistry);
    expect(getActivePluginRegistryKey()).toBe("bootstrapped-registry");
    expect(getGlobalPluginRegistry()).toBe(bootstrappedRegistry);
  });

  it("promotes live channel runtime state when the active registry changes but channel IDs stay the same", async () => {
    const startupStartAccount = vi.fn(async () => {});
    const upgradedStartAccount = vi.fn(async () => {
      registerPluginHttpRoute({
        path: "/upgraded-webhook",
        auth: "plugin",
        pluginId: "discord",
        source: "test-webhook",
        handler: () => true,
      });
    });
    const startupRegistry = createTestRegistry(
      createTestPlugin({
        startAccount: startupStartAccount,
      }),
    );
    const upgradedRegistry = createTestRegistry(
      createTestPlugin({
        startAccount: upgradedStartAccount,
      }),
    );

    setActivePluginRegistry(startupRegistry, "startup-registry");
    initializeGlobalHookRunner(startupRegistry);
    let runtimeState: ChannelLifecyclePluginRuntimeState = {
      registry: startupRegistry,
      cacheKey: "startup-registry",
    };
    const manager = createManager({
      resolvePluginRuntimeState: () => {
        runtimeState = resolveChannelLifecyclePluginRuntimeState(runtimeState);
        return runtimeState;
      },
    });

    // Simulate an upgrade that activates a new registry with same channel IDs.
    setActivePluginRegistry(upgradedRegistry, "upgraded-registry");
    initializeGlobalHookRunner(upgradedRegistry);

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);

    expect(upgradedStartAccount).toHaveBeenCalledTimes(1);
    expect(startupStartAccount).not.toHaveBeenCalled();
    expect(upgradedRegistry.httpRoutes).toHaveLength(1);
    expect(upgradedRegistry.httpRoutes[0]?.path).toBe("/upgraded-webhook");
    expect(startupRegistry.httpRoutes).toHaveLength(0);
    expect(getActivePluginRegistry()).toBe(upgradedRegistry);
    expect(getActivePluginRegistryKey()).toBe("upgraded-registry");
    expect(getGlobalPluginRegistry()).toBe(upgradedRegistry);
  });
});
