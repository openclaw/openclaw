import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChannelId, type ChannelPlugin } from "../channels/plugins/types.js";
import {
  createSubsystemLogger,
  type SubsystemLogger,
  runtimeForLogger,
} from "../logging/subsystem.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { createChannelManager } from "./server-channels.js";

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
  account?: TestAccount;
  startAccount?: NonNullable<ChannelPlugin<TestAccount>["gateway"]>["startAccount"];
  includeDescribeAccount?: boolean;
}): ChannelPlugin<TestAccount> {
  const account = params?.account ?? { enabled: true, configured: true };
  const includeDescribeAccount = params?.includeDescribeAccount !== false;
  const config: ChannelPlugin<TestAccount>["config"] = {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: () => account,
    isEnabled: (resolved) => resolved.enabled !== false,
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
    id: "discord",
    meta: {
      id: "discord",
      label: "Discord",
      selectionLabel: "Discord",
      docsPath: "/channels/discord",
      blurb: "test stub",
    },
    capabilities: { chatTypes: ["direct"] },
    config,
    gateway,
  };
}

function installTestRegistry(plugin: ChannelPlugin<TestAccount>) {
  const registry = createEmptyPluginRegistry();
  registry.channels.push({
    pluginId: plugin.id,
    source: "test",
    plugin,
  });
  setActivePluginRegistry(registry);
}

function createManager(options?: { channelRuntime?: PluginRuntime["channel"] }) {
  const log = createSubsystemLogger("gateway/server-channels-test");
  const channelLogs = { discord: log } as Record<ChannelId, SubsystemLogger>;
  const runtime = runtimeForLogger(log);
  const channelRuntimeEnvs = { discord: runtime } as Record<ChannelId, RuntimeEnv>;
  return createChannelManager({
    loadConfig: () => ({}),
    channelLogs,
    channelRuntimeEnvs,
    ...(options?.channelRuntime ? { channelRuntime: options.channelRuntime } : {}),
  });
}

describe("server-channels auto restart", () => {
  let previousRegistry: PluginRegistry | null = null;

  beforeEach(() => {
    previousRegistry = getActivePluginRegistry();
    vi.useFakeTimers();
    hoisted.computeBackoff.mockClear();
    hoisted.sleepWithAbort.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
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
    expect(account?.reconnectAttempts).toBe(10);

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

  it("staggers Discord account connections when connectStagger is configured", async () => {
    const startTimes: number[] = [];
    const startAccount = vi.fn(async () => {
      startTimes.push(Date.now());
    });

    const testPlugin = createTestPlugin({ startAccount });
    // Override listAccountIds to return multiple accounts
    testPlugin.config.listAccountIds = () => ["bot1", "bot2", "bot3"];

    installTestRegistry(testPlugin);

    // Configure connectStagger
    const manager = createManager({
      loadConfig: () => ({
        channels: {
          discord: {
            connectStagger: 2000,
          },
        },
      }),
    });

    const startTime = Date.now();
    await manager.startChannels();

    expect(startAccount).toHaveBeenCalledTimes(3);
    expect(startTimes).toHaveLength(3);

    // Verify connections were staggered
    const firstDelay = startTimes[1]! - startTimes[0]!;
    const secondDelay = startTimes[2]! - startTimes[1]!;

    // Allow some tolerance for timing
    expect(firstDelay).toBeGreaterThanOrEqual(1900);
    expect(firstDelay).toBeLessThan(2200);
    expect(secondDelay).toBeGreaterThanOrEqual(1900);
    expect(secondDelay).toBeLessThan(2200);

    // Total time should be at least 4000ms (2 staggers * 2000ms)
    const totalTime = Date.now() - startTime;
    expect(totalTime).toBeGreaterThanOrEqual(3800);
  });

  it("connects concurrently when connectStagger is 0 or not configured", async () => {
    const startTimes: number[] = [];
    const startAccount = vi.fn(async () => {
      startTimes.push(Date.now());
      // Add a small delay to ensure we can measure concurrency
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    const testPlugin = createTestPlugin({ startAccount });
    testPlugin.config.listAccountIds = () => ["bot1", "bot2", "bot3"];

    installTestRegistry(testPlugin);

    const manager = createManager({
      loadConfig: () => ({
        channels: {
          discord: {},
        },
      }),
    });

    const startTime = Date.now();
    await manager.startChannels();

    expect(startAccount).toHaveBeenCalledTimes(3);

    // All connections should start nearly simultaneously
    const maxSpread = Math.max(...startTimes) - Math.min(...startTimes);
    expect(maxSpread).toBeLessThan(100); // Allow for some timing variance

    // Total time should be close to 100ms (the artificial delay), not 300ms
    const totalTime = Date.now() - startTime;
    expect(totalTime).toBeLessThan(200);
  });
});
