import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChannelId, type ChannelPlugin } from "../channels/plugins/types.js";
import {
  createSubsystemLogger,
  type SubsystemLogger,
  runtimeForLogger,
} from "../logging/subsystem.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
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

function createManager() {
  const log = createSubsystemLogger("gateway/server-channels-test");
  const channelLogs = { discord: log } as Record<ChannelId, SubsystemLogger>;
  const runtime = runtimeForLogger(log);
  const channelRuntimeEnvs = { discord: runtime } as Record<ChannelId, RuntimeEnv>;
  return createChannelManager({
    loadConfig: () => ({}),
    channelLogs,
    channelRuntimeEnvs,
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

  it("pauses auto-restart on a terminal error after the first exit", async () => {
    const startAccount = vi.fn(async () => {
      throw new Error("Call to 'getMe' failed! (401: Unauthorized)");
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(200);

    // one start, no retry storm — the 401 is terminal
    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(manager.isTerminallyErrored("discord", DEFAULT_ACCOUNT_ID)).toBe(true);
    const account = manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.terminalError).toContain("401");
    expect(account?.running).toBe(false);
  });

  it("clears the terminal-error pause on an explicit start", async () => {
    const startAccount = vi.fn(async () => {
      throw new Error("Call to 'getMe' failed! (401: Unauthorized)");
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(200);
    expect(startAccount).toHaveBeenCalledTimes(1);

    // operator action (e.g. token fixed + channel restart) retries immediately
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(startAccount).toHaveBeenCalledTimes(2);
  });

  it("expires the terminal-error pause after the retry window", async () => {
    const startAccount = vi.fn(async () => {
      throw new Error("Call to 'getMe' failed! (401: Unauthorized)");
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(200);
    expect(manager.isTerminallyErrored("discord", DEFAULT_ACCOUNT_ID)).toBe(true);

    // after the window the pause lifts so the health monitor's next check re-probes
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(manager.isTerminallyErrored("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
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
});
