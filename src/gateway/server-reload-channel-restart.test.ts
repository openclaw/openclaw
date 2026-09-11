import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import {
  requireActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { channelBlockedPatch, channelReadyPatch } from "./channel-status-patches.js";
import type { ChannelKind } from "./config-reload-plan.js";
import { createChannelManager, type ChannelManager } from "./server-channels.js";
import { rollbackStoppedGatewayChannels } from "./server-reload-channel-restart.js";

// Hot-reload recovery: collapse the restart and backoff ladders so a re-driven
// replacement reaches its next attempt inside the fake-timer budget.
const reloadRecoveryHoisted = vi.hoisted(() => {
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
  return { sleepWithAbort };
});

vi.mock("../../packages/retry/src/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/retry/src/index.js")>();
  class TestRetrySupervisor extends actual.RetrySupervisor {
    constructor(
      _policy: ConstructorParameters<typeof actual.RetrySupervisor>[0],
      maxAttempts?: number,
    ) {
      super({ initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }, maxAttempts);
    }
  }
  return { ...actual, RetrySupervisor: TestRetrySupervisor };
});

vi.mock("../infra/backoff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/backoff.js")>();
  return { ...actual, sleepWithAbort: reloadRecoveryHoisted.sleepWithAbort };
});

let manager: ChannelManager | undefined;
afterEach(async () => {
  await manager?.stopChannel("discord");
  manager = undefined;
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
});

it("retains a failed teardown target when rollback cannot admit its replacement", async () => {
  const stopAccount = vi
    .fn()
    .mockResolvedValue(undefined)
    .mockRejectedValueOnce(new Error("teardown failed"));
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: "discord",
      config: {
        listAccountIds: () => ["running"],
        resolveAccount: (_cfg, accountId) => ({ accountId }),
      },
    }),
    gateway: {
      startAccount: async ({ abortSignal }) =>
        new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        }),
      stopAccount,
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", plugin, source: "test" }]));
  manager = createChannelManager({
    getRuntimeConfig: () => ({}),
    getPluginRegistry: requireActivePluginChannelRegistry,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
  await manager.startChannel("discord");
  await expect(manager.stopChannel("discord", undefined, { manual: false })).rejects.toThrow(
    "teardown failed",
  );

  const channels = new Set<ChannelKind>(["discord"]);
  const logChannels = { info: vi.fn(), error: vi.fn() };
  expect(
    await rollbackStoppedGatewayChannels(
      { startChannel: manager.startChannel, logChannels },
      channels,
      "failed plugin runtime publication",
    ),
  ).toEqual(["discord"]);
  expect([...channels]).toEqual(["discord"]);
  expect(logChannels.error).toHaveBeenCalledWith(expect.stringContaining("stop-in-flight"));
});

it.each(["idle", "stopped", "racing"] as const)(
  "channel rollback preserves %s manual stops while explicit starts resume",
  async (state) => {
    const starts: string[] = [];
    const configuring = createDeferred();
    const releaseConfiguration = createDeferred();
    let blockConfiguration = state === "racing";
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "discord",
        config: {
          listAccountIds: () => ["manual", "running"],
          resolveAccount: (_cfg, accountId) => ({ accountId }),
          isConfigured: async (account) => {
            if (blockConfiguration && account.accountId === "manual") {
              configuring.resolve();
              await releaseConfiguration.promise;
            }
            return true;
          },
        },
      }),
      gateway: {
        startAccount: async ({ accountId, abortSignal }) => {
          starts.push(accountId);
          await new Promise<void>((resolve) => {
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", plugin, source: "test" }]));
    manager = createChannelManager({
      getRuntimeConfig: () => ({}),
      getPluginRegistry: requireActivePluginChannelRegistry,
      channelLogs: {},
      channelRuntimeEnvs: {},
    });
    if (state === "stopped") {
      await manager.startChannel("discord", "manual");
      expect(starts).toEqual(["manual"]);
    }
    if (state !== "racing") {
      await manager.stopChannel("discord", "manual");
    }
    const channels = new Set<ChannelKind>(["discord"]);
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const reload = rollbackStoppedGatewayChannels(
      { startChannel: manager.startChannel, logChannels },
      channels,
      "cancelled plugin reload",
    );
    if (state === "racing") {
      await configuring.promise;
      await manager.stopChannel("discord", "manual");
      blockConfiguration = false;
      releaseConfiguration.resolve();
    }
    expect(await reload).toEqual([]);
    expect(channels.size).toBe(0);
    expect(logChannels.error).not.toHaveBeenCalled();
    expect(manager.isManuallyStopped("discord", "manual")).toBe(true);
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.manual?.running).toBe(false);
    expect(starts).toEqual(state === "stopped" ? ["manual", "running"] : ["running"]);

    await manager.startChannel("discord", "manual", { manual: true });
    expect(manager.isManuallyStopped("discord", "manual")).toBe(false);
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.manual?.running).toBe(true);
    expect(starts.at(-1)).toBe("manual");
  },
);
it("channel rollback uses the attached registry while another Gateway is active", async () => {
  const monitors: Array<{
    owner: string;
    channelId: ChannelKind;
    abortSignal: AbortSignal;
    joined: boolean;
  }> = [];
  const stopOwners: string[] = [];
  const createRegistry = (owner: string, channelIds: ChannelKind[]) =>
    createTestRegistry(
      channelIds.map((id) => {
        const plugin: ChannelPlugin = {
          ...createChannelTestPluginBase({ id }),
          gateway: {
            startAccount: async ({ abortSignal }) => {
              const monitor = { owner, channelId: id, abortSignal, joined: false };
              monitors.push(monitor);
              await new Promise<void>((resolve) => {
                abortSignal.addEventListener("abort", () => resolve(), { once: true });
              });
              monitor.joined = true;
            },
            stopAccount: async () => {
              stopOwners.push(owner);
            },
          },
        };
        return { pluginId: id, plugin, source: "test" };
      }),
    );
  const ownedIds: ChannelKind[] = ["collision", "owner-only"];
  let attached = createRegistry("A-original", ownedIds);
  const current = createRegistry("A-current", ownedIds);
  const foreign = createRegistry("B", ["collision", "foreign-only"]);
  const ownerA = createChannelManager({
    getRuntimeConfig: () => ({}),
    getPluginRegistry: () => attached,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
  const ownerB = createChannelManager({
    getRuntimeConfig: () => ({}),
    getPluginRegistry: () => foreign,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
  const stopOwnedChannels = async () => {
    for (const id of ownedIds) {
      await ownerA.stopChannel(id, undefined, { manual: false });
    }
  };
  try {
    setActivePluginRegistry(attached);
    await ownerA.startChannels();
    expect(monitors.map(({ owner }) => owner)).toEqual(["A-original", "A-original"]);
    await stopOwnedChannels();
    expect(monitors.every(({ abortSignal, joined }) => abortSignal.aborted && joined)).toBe(true);

    attached = current;
    setActivePluginRegistry(current);
    await ownerA.startChannels();
    expect(monitors.slice(2).map(({ owner }) => owner)).toEqual(["A-current", "A-current"]);
    // Rollback must resume this generation, not the manager's original registry.
    await stopOwnedChannels();
    expect(monitors.every(({ abortSignal, joined }) => abortSignal.aborted && joined)).toBe(true);

    setActivePluginRegistry(foreign);
    await ownerB.startChannels();
    const foreignMonitors = monitors.filter(({ owner }) => owner === "B");
    expect(foreignMonitors).toHaveLength(2);
    const beforeRollback = monitors.length;
    const channels = new Set<ChannelKind>(ownedIds);
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const failures = await rollbackStoppedGatewayChannels(
      { startChannel: ownerA.startChannel, logChannels },
      channels,
      "cancelled plugin reload",
    );
    expect(failures).toEqual([]);
    expect(channels.size).toBe(0);
    expect(logChannels.error).not.toHaveBeenCalled();
    const resumed = monitors
      .slice(beforeRollback)
      .map(({ owner, channelId }) => `${owner}:${channelId}`)
      .toSorted();
    const bInterrupted = foreignMonitors.some(
      ({ abortSignal, joined }) => abortSignal.aborted || joined,
    );
    expect(
      {
        resumed,
        aChannels: Object.keys(ownerA.getRuntimeSnapshot().channelAccounts).toSorted(),
        bChannels: Object.keys(ownerB.getRuntimeSnapshot().channelAccounts).toSorted(),
        bStopped: stopOwners.includes("B"),
        bInterrupted,
      },
      "rollback borrowed a foreign or constructor-time channel registry",
    ).toEqual({
      resumed: ["A-current:collision", "A-current:owner-only"],
      aChannels: ["collision", "owner-only"],
      bChannels: ["collision", "foreign-only"],
      bStopped: false,
      bInterrupted: false,
    });
  } finally {
    for (const owner of [ownerA, ownerB]) {
      for (const id of ["collision", "owner-only", "foreign-only"]) {
        await owner.stopChannel(id);
      }
    }
    expect(monitors.every(({ abortSignal, joined }) => abortSignal.aborted && joined)).toBe(true);
  }
});

type StartAccount = NonNullable<NonNullable<ChannelPlugin["gateway"]>["startAccount"]>;

/**
 * A config write (`openclaw doctor`) stops and re-admits every channel account the
 * changed config owns. A plugin channel whose plugin owns `gateway.startAccount` can
 * lose that handshake against its own still-live predecessor session and report a
 * terminal verdict before it ever connects. That account must not wedge behind a
 * manual `channels.start` RPC.
 */
describe("hot-reload replacement recovery", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(async () => {
    const stopping = manager?.stopChannel("discord").catch(() => {});
    manager = undefined;
    await vi.advanceTimersByTimeAsync(6_000);
    await stopping;
    vi.clearAllTimers();
    vi.useRealTimers();
    resetPluginRuntimeStateForTest();
    resetGatewayWorkAdmission();
  });

  function installPlugin(startAccount: StartAccount): void {
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "discord",
        config: {
          listAccountIds: () => [DEFAULT_ACCOUNT_ID],
          resolveAccount: () => ({}),
        },
      }),
      gateway: { startAccount },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", plugin, source: "test" }]));
  }

  function createManager(): ChannelManager {
    return createChannelManager({
      getRuntimeConfig: () => ({}),
      getPluginRegistry: requireActivePluginChannelRegistry,
      channelLogs: {},
      channelRuntimeEnvs: {},
    });
  }

  /** The reload planner's own sequence: stop with a route handoff, then re-admit. */
  async function reloadAccount(target: ChannelManager): Promise<void> {
    await target.stopChannel("discord", DEFAULT_ACCOUNT_ID, { manual: false, routeHandoff: true });
    await target.startChannel("discord", DEFAULT_ACCOUNT_ID, {
      preserveManualStop: true,
      skipUnavailableAccounts: true,
    });
  }

  async function flushMicrotasks(times = 8): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await Promise.resolve();
    }
  }

  async function advanceTimersUntil(
    check: () => boolean,
    message: string,
    options: { stepMs: number; maxMs: number },
  ): Promise<void> {
    for (let elapsed = 0; elapsed <= options.maxMs; elapsed += options.stepMs) {
      if (check()) {
        return;
      }
      await vi.advanceTimersByTimeAsync(options.stepMs);
      await flushMicrotasks();
    }
    if (check()) {
      return;
    }
    throw new Error(message);
  }

  function accountRuntime(target: ChannelManager) {
    return target.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
  }

  it("re-drives a reload replacement that terminally disconnects before its first ready", async () => {
    let starts = 0;
    installPlugin(async ({ setStatus, abortSignal }) => {
      starts += 1;
      if (starts === 2) {
        // The replacement collided with its own still-live predecessor session.
        // A terminal verdict, but the credentials never changed.
        setStatus(
          channelBlockedPatch("session collision with the previous connection", {
            accountId: DEFAULT_ACCOUNT_ID,
          }),
        );
        return;
      }
      setStatus(channelReadyPatch({ accountId: DEFAULT_ACCOUNT_ID }));
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    manager = createManager();
    await manager.startChannels();
    await reloadAccount(manager);

    await advanceTimersUntil(
      () => starts >= 3,
      "reload replacement was not re-driven after a terminal handshake",
      { stepMs: 10, maxMs: 1_000 },
    );
    await flushMicrotasks();
    expect(accountRuntime(manager)?.lifecycle).toBe("ready");
    expect(accountRuntime(manager)?.terminalDisconnect).toBeUndefined();
  });

  it("still wedges a terminal disconnect with no healthy predecessor", async () => {
    let starts = 0;
    installPlugin(async ({ setStatus }) => {
      starts += 1;
      setStatus(channelBlockedPatch("relink required", { accountId: DEFAULT_ACCOUNT_ID }));
    });
    manager = createManager();
    await manager.startChannels();
    await flushMicrotasks(30);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(starts).toBe(1);
    expect(accountRuntime(manager)?.lifecycle).toBe("blocked");
    expect(accountRuntime(manager)?.restartPending).toBe(false);
  });
});
