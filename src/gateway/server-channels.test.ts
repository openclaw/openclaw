/**
 * Server channel lifecycle tests.
 */
import { getEventListeners } from "node:events";
import fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ChannelIngressUnavailableError } from "../channels/message/ingress-unavailable.js";
import type {
  ChannelAccountLinkState,
  ChannelGatewayContext,
} from "../channels/plugins/types.adapters.js";
import type { ChannelAccountSnapshot, ChannelId } from "../channels/plugins/types.public.js";
import { formatGatewayChannelsStatusLines } from "../commands/channels/status.runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime-context.js";
import type { GatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime.types.js";
import { tryReadSecretFileSync } from "../infra/secret-file.js";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { createPluginModuleLoader } from "../plugins/loader-module-runtime.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import {
  getActivePluginRegistry,
  requireActivePluginChannelRegistry,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createRuntimeChannel } from "../plugins/runtime/runtime-channel.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import {
  isGatewaySubordinateWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  clearActiveCredentialDegradedOwners,
  listActiveDegradedSecretOwners,
  setActiveDegradedSecretOwners,
} from "../secrets/runtime-degraded-state.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import {
  channelBlockedPatch,
  channelReadyPatch,
  createTransportActivityStatusPatch,
} from "./channel-status-patches.js";
import { restartRunningChannelAccounts } from "./channel-thaw-restart.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createChannelManager, type ChannelManager } from "./server-channels.js";
import {
  createTestPlugin,
  createTestChannelRegistry,
  createTestChannelManager,
  waitForAbort,
  flushMicrotasks,
  healthOf,
  type TestAccount,
} from "./server-channels.test-support.js";
import { AUTH_NONE, createTestGatewayServer } from "./server-http.test-harness.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";

const hoisted = vi.hoisted(() => {
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
  const startChannelApprovalHandlerBootstrap = vi.fn(async () => async () => {});
  return { sleepWithAbort, startChannelApprovalHandlerBootstrap };
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
  return {
    ...actual,
    RetrySupervisor: TestRetrySupervisor,
  };
});

vi.mock("../infra/backoff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/backoff.js")>();
  return {
    ...actual,
    sleepWithAbort: hoisted.sleepWithAbort,
  };
});

vi.mock("../infra/approval-handler-bootstrap.js", () => ({
  startChannelApprovalHandlerBootstrap: hoisted.startChannelApprovalHandlerBootstrap,
}));

const CHANNEL_APPROVAL_GATEWAY_RUNTIME_CONTEXT_CAPABILITY = "approval.gateway";
type ApprovalGatewayRequestRuntime = Pick<GatewayNativeApprovalRuntime, "request">;

const createdManagers: Array<{ manager: ChannelManager; channelIds: ChannelId[] }> = [];
const channelTempDirs = useAutoCleanupTempDirTracker(afterEach);

async function waitForImmediate(): Promise<void> {
  await new Promise<void>((resolve) => {
    const handle = setImmediate(resolve);
    handle.unref?.();
  });
}

async function waitForMicrotaskCondition(
  check: () => boolean,
  message: string,
  attempts = 100,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (check()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(message);
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

function firstStartAccountContext(
  startAccount: ReturnType<typeof vi.fn>,
): ChannelGatewayContext<TestAccount> {
  const ctx = startAccount.mock.calls[0]?.[0];
  if (!ctx || typeof ctx !== "object") {
    throw new Error("expected channel start context");
  }
  return ctx as ChannelGatewayContext<TestAccount>;
}

function installTestRegistry(...plugins: Parameters<typeof createTestChannelRegistry>) {
  const registry = createTestChannelRegistry(...plugins);
  setActivePluginRegistry(registry);
  return registry;
}

function createManager(options: Parameters<typeof createTestChannelManager>[0] = {}) {
  const manager = createTestChannelManager(options);
  createdManagers.push({ channelIds: options.channelIds ?? ["discord"], manager });
  return manager;
}

function readAccount(manager: ChannelManager, accountId = DEFAULT_ACCOUNT_ID) {
  return manager.getRuntimeSnapshot().channelAccounts.discord?.[accountId];
}

function stayRunning({ abortSignal }: ChannelGatewayContext<TestAccount>) {
  return waitForAbort(abortSignal);
}

describe("server-channels auto restart", () => {
  const stableChannelRunMs = 5 * 60_000;
  let previousRegistry: PluginRegistry | null = null;

  beforeEach(() => {
    resetGatewayWorkAdmission();
    previousRegistry = getActivePluginRegistry();
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    hoisted.sleepWithAbort.mockClear();
    hoisted.startChannelApprovalHandlerBootstrap.mockReset();
    hoisted.startChannelApprovalHandlerBootstrap.mockResolvedValue(async () => {});
    clearActiveCredentialDegradedOwners();
    setActiveDegradedSecretOwners([]);
  });

  afterEach(async () => {
    const stops = createdManagers
      .splice(0)
      .flatMap(({ channelIds, manager }) =>
        channelIds.map((channelId) => manager.stopChannel(channelId).catch(() => {})),
      );
    await vi.advanceTimersByTimeAsync(6_000);
    await Promise.allSettled(stops);
    await flushMicrotasks();
    vi.clearAllTimers();
    vi.useRealTimers();
    resetGatewayWorkAdmission();
    clearActiveCredentialDegradedOwners();
    setActiveDegradedSecretOwners([]);
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
  });

  it("keeps channel hooks and snapshots bound to their Gateway registry", async () => {
    const joined: AbortSignal[] = [];
    const createLifecycle = (id: ChannelId) => {
      const startAccount = vi.fn(async ({ abortSignal }: ChannelGatewayContext<TestAccount>) => {
        await waitForAbort(abortSignal);
        joined.push(abortSignal);
      });
      const stopAccount = vi.fn(async (_ctx: ChannelGatewayContext<TestAccount>) => undefined);
      return {
        plugin: createTestPlugin({ id, startAccount, stopAccount }),
        startAccount,
        stopAccount,
      };
    };
    const a = createLifecycle("discord");
    const b = createLifecycle("discord");
    const bOnly = createLifecycle("slack");
    const registryA = installTestRegistry(a.plugin);
    const managerA = createManager({
      channelIds: ["discord", "slack"],
      getPluginRegistry: () => registryA,
    });
    await managerA.startChannels();
    await waitForImmediate();
    expect(a.startAccount).toHaveBeenCalledTimes(1);
    const originalA = firstStartAccountContext(a.startAccount).abortSignal;

    const registryB = installTestRegistry(b.plugin, bOnly.plugin);
    const managerB = createManager({
      channelIds: ["discord", "slack"],
      getPluginRegistry: () => registryB,
    });
    try {
      await managerB.startChannels();
      await waitForImmediate();
      expect(b.startAccount).toHaveBeenCalledTimes(1);
      expect(bOnly.startAccount).toHaveBeenCalledTimes(1);
      const originalB = firstStartAccountContext(b.startAccount).abortSignal;
      const originalBOnly = firstStartAccountContext(bOnly.startAccount).abortSignal;
      const snapshotChannels = Object.keys(
        managerA.getRuntimeSnapshot().channelAccounts,
      ).toSorted();
      expect(managerA.isAccountListed("slack", DEFAULT_ACCOUNT_ID)).toBe(false);
      expect(managerB.isAccountListed("slack", DEFAULT_ACCOUNT_ID)).toBe(true);

      await managerA.stopChannel("discord", DEFAULT_ACCOUNT_ID, { manual: false });
      const stopped = {
        aHook: a.stopAccount.mock.calls.length,
        bHook: b.stopAccount.mock.calls.length,
        aHookReceivedOwnSignal: a.stopAccount.mock.calls[0]?.[0].abortSignal === originalA,
        foreignHookReceivedASignal: b.stopAccount.mock.calls.some(
          ([ctx]) => ctx.abortSignal === originalA,
        ),
        aAborted: originalA.aborted,
        aJoined: joined.includes(originalA),
        bAborted: originalB.aborted,
        bOnlyAborted: originalBOnly.aborted,
      };
      await managerA.startChannels();
      await waitForImmediate();
      expect(
        {
          snapshotChannels,
          stopped,
          starts: [a, b, bOnly].map(({ startAccount }) => startAccount.mock.calls.length),
          bStillLive: !originalB.aborted && !originalBOnly.aborted,
        },
        "channel manager borrowed another Gateway registry",
      ).toEqual({
        snapshotChannels: ["discord"],
        stopped: {
          aHook: 1,
          bHook: 0,
          aHookReceivedOwnSignal: true,
          foreignHookReceivedASignal: false,
          aAborted: true,
          aJoined: true,
          bAborted: false,
          bOnlyAborted: false,
        },
        starts: [2, 1, 1],
        bStillLive: true,
      });
    } finally {
      await Promise.all(
        [managerA, managerB].flatMap((manager) =>
          ["discord", "slack"].map((id) => manager.stopChannel(id)),
        ),
      );
      const signals = [a, b, bOnly].flatMap(({ startAccount }) =>
        startAccount.mock.calls.map(([ctx]) => ctx.abortSignal),
      );
      expect(signals.every((signal) => signal.aborted && joined.includes(signal))).toBe(true);
      expect(joined).toHaveLength(signals.length);
    }
  });

  it("keeps channel requests bound to their Gateway after the starting client closes", async () => {
    const continueChannelRequest = createDeferred();
    const observedGateway = createDeferred<{ gateway: string }>();
    const ownerContext = createContext();
    ownerContext.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: "health",
          scope: "operator.read",
          owner: { kind: "core", area: "channel-startup" },
          handler: ({ respond }: GatewayRequestHandlerOptions) =>
            respond(true, { gateway: "channel-owner" }),
        },
      ]);
    const callerContext = createContext();
    callerContext.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: "health",
          scope: "operator.read",
          owner: { kind: "core", area: "channel-startup" },
          handler: ({ respond }: GatewayRequestHandlerOptions) =>
            respond(true, { gateway: "starting-client" }),
        },
      ]);
    const startAccount = async ({ abortSignal }: ChannelGatewayContext<TestAccount>) => {
      await continueChannelRequest.promise;
      try {
        observedGateway.resolve(
          await dispatchGatewayMethodInProcess<{ gateway: string }>(
            "health",
            {},
            {
              syntheticScopes: ["operator.read"],
              operatorRoleActor: { kind: "system" },
            },
          ),
        );
      } catch (error) {
        observedGateway.reject(error);
      }
      await waitForAbort(abortSignal);
    };
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({ resolveGatewayContext: () => ownerContext });
    const callerLifetime = new AbortController();

    try {
      await withPluginRuntimeGatewayRequestScope(
        {
          context: callerContext,
          client: createSyntheticPluginRuntimeClient({
            scopes: ["operator.read"],
            operatorRoleActor: { kind: "system" },
          }),
          isWebchatConnect: () => false,
          signal: callerLifetime.signal,
          hasCurrentClientAuthority: () => !callerLifetime.signal.aborted,
        },
        () => manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { manual: true }),
      );
      callerLifetime.abort();
      const requestResult = expect(observedGateway.promise).resolves.toEqual({
        gateway: "channel-owner",
      });
      continueChannelRequest.resolve();
      await requestResult;
    } finally {
      continueChannelRequest.resolve();
      await manager.stopChannel("discord");
    }
  });

  it("keeps approval-bootstrap descendants admitted after the starting request finishes", async () => {
    const continueApprovalDescendant = createDeferred();
    const observedAdmission = createDeferred<boolean>();
    hoisted.startChannelApprovalHandlerBootstrap.mockImplementation(async () => {
      void Promise.resolve().then(async () => {
        await continueApprovalDescendant.promise;
        observedAdmission.resolve(isGatewaySubordinateWorkAdmissionClosed());
      });
      return async () => {};
    });
    const startAccount = vi.fn(stayRunning);
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();
    const requestAdmission = tryBeginGatewayRootWorkAdmission();
    expect(requestAdmission).not.toBeNull();
    if (!requestAdmission) {
      return;
    }

    try {
      await requestAdmission.run(async () => {
        await manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { manual: true });
        await waitForImmediate();
        await waitForMicrotaskCondition(
          () => startAccount.mock.calls.length === 1,
          "expected channel task to start",
        );
      });
      requestAdmission.release();
      continueApprovalDescendant.resolve();

      await expect(observedAdmission.promise).resolves.toBe(false);
    } finally {
      requestAdmission.release();
      continueApprovalDescendant.resolve();
    }
  });

  it("keeps automatic restarts admitted after the starting request finishes", async () => {
    const finishFirstChannelTask = createDeferred();
    const observedAdmission: boolean[] = [];
    const startAccount = vi.fn(async ({ abortSignal }: ChannelGatewayContext<TestAccount>) => {
      observedAdmission.push(isGatewaySubordinateWorkAdmissionClosed());
      if (observedAdmission.length === 1) {
        await finishFirstChannelTask.promise;
        return;
      }
      await waitForAbort(abortSignal);
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();
    const requestAdmission = tryBeginGatewayRootWorkAdmission();
    expect(requestAdmission).not.toBeNull();
    if (!requestAdmission) {
      return;
    }

    try {
      await requestAdmission.run(async () => {
        await manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { manual: true });
        await waitForImmediate();
        await waitForMicrotaskCondition(
          () => startAccount.mock.calls.length === 1,
          "expected initial channel task to start",
        );
      });
      requestAdmission.release();
      finishFirstChannelTask.resolve();
      await advanceTimersUntil(
        () => startAccount.mock.calls.length === 2,
        "expected channel task to restart",
        { stepMs: 10, maxMs: 100 },
      );

      expect(observedAdmission).toEqual([false, false]);
    } finally {
      requestAdmission.release();
      finishFirstChannelTask.resolve();
    }
  });

  it("clears a previous lifecycle's dead-ingress verdict once ingress starts again", async () => {
    let failIngress = true;
    const startAccount = vi.fn(async () => {
      if (failIngress) {
        throw new ChannelIngressUnavailableError("Channel ingress queue is unavailable: denied");
      }
      await new Promise(() => {});
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await advanceTimersUntil(
      () => readAccount(manager)?.ingressUnavailable === true,
      "expected the first start to record dead ingress",
      { stepMs: 10, maxMs: 500 },
    );
    expect(healthOf(readAccount(manager))).toEqual({
      healthy: false,
      reason: "ingress-unavailable",
    });

    // Runtime rows are patch-merged, so a sticky verdict would keep the channel
    // unhealthy forever after the operator fixed the underlying capability. The
    // supervisor's own backoff ladder supplies the next start here.
    failIngress = false;
    await advanceTimersUntil(
      () =>
        readAccount(manager)?.running === true &&
        readAccount(manager)?.ingressUnavailable === undefined,
      "expected a later start to clear the dead-ingress verdict",
      { stepMs: 10, maxMs: 500 },
    );

    expect(healthOf(readAccount(manager)).reason).not.toBe("ingress-unavailable");
  });

  it("claims auto-restart ownership between crash-loop attempts", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await flushMicrotasks();

    // The health monitor must see the supervisor own recovery here, otherwise it
    // resets the attempt ladder and the give-up below never happens.
    expect(manager.isAutoRestartScheduled("discord", DEFAULT_ACCOUNT_ID)).toBe(true);
    expect(readAccount(manager)).toMatchObject({
      running: false,
      restartPending: true,
      lifecycle: "recovering",
      lastError: "channel exited without an error",
    });

    // A competing restart request cannot help while the supervisor holds the
    // account task; it returns without booting anything.
    const startsBeforeRequest = startAccount.mock.calls.length;
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(startAccount).toHaveBeenCalledTimes(startsBeforeRequest);

    await advanceTimersUntil(
      () => startAccount.mock.calls.length >= 11,
      "expected crash-loop restarts to reach the maximum attempt cap",
      { stepMs: 10, maxMs: 500 },
    );

    expect(manager.isAutoRestartScheduled("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
    expect(startAccount).toHaveBeenCalledTimes(11);
    expect(readAccount(manager)).toMatchObject({
      running: false,
      reconnectAttempts: 11,
      lastError: "channel exited without an error",
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(startAccount).toHaveBeenCalledTimes(11);
  });

  it("binds and rebinds a channel port after concurrent native SDK imports", async () => {
    const root = channelTempDirs.make("openclaw-channel-sdk-restart-");
    const files = {
      "package.json": JSON.stringify({
        name: "openclaw",
        type: "module",
        bin: { openclaw: "./openclaw.mjs" },
        exports: { "./plugin-sdk/used": "./dist/plugin-sdk/used.js" },
      }),
      "dist/plugin-sdk/leaf.js": 'export const value = "ready";',
      "dist/plugin-sdk/used.js": 'export { value } from "./leaf.js";',
      "dist/extensions/demo/esm-plugin.mjs": 'export { value } from "openclaw/plugin-sdk/used";',
      "dist/extensions/demo/cjs-plugin.cjs":
        'module.exports = require("openclaw/plugin-sdk/used");',
      "dist/extensions/demo/index.cjs": `module.exports = { load: () => Promise.all([
        import("./esm-plugin.mjs"), import("./cjs-plugin.cjs")
      ]).then(([esm, cjs]) => esm.value + ":" + cjs.default.value) };`,
    };
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    fs.mkdirSync(path.join(root, "extensions"));
    const load = createPluginModuleLoader({ devSourceRoot: root });
    const plugin = load(path.join(root, "dist/extensions/demo/index.cjs")) as {
      load: () => Promise<string>;
    };
    const firstStarted = createDeferred<Server>();
    const secondStarted = createDeferred<Server>();
    const crash = createDeferred();
    const closed = createDeferred();
    let generation = 0;
    let port = 0;
    installTestRegistry(
      createTestPlugin({
        startAccount: async ({ abortSignal }) => {
          const current = generation++;
          const ready = current === 0 ? firstStarted : secondStarted;
          let server: Server | undefined;
          try {
            const value = await plugin.load();
            server = createServer((_req, res) => res.end(`${value}:${current + 1}`));
            const listener = server;
            await new Promise<void>((resolve, reject) => {
              listener.once("error", reject);
              listener.listen(port, "127.0.0.1", resolve);
            });
            const address = listener.address();
            if (!address || typeof address === "string") {
              throw new Error("expected channel TCP listener");
            }
            port = address.port;
            ready.resolve(listener);
            await new Promise<void>((resolve, reject) => {
              abortSignal.addEventListener("abort", () => resolve(), { once: true });
              if (current === 0) {
                void crash.promise.then(() => reject(new Error("channel worker crashed")));
              }
            });
          } catch (error) {
            // Surface native import failures directly instead of waiting for a port timeout.
            ready.reject(error);
            throw error;
          } finally {
            const listener = server;
            if (listener) {
              await new Promise<void>((resolve) => {
                listener.close(() => resolve());
              });
            }
            if (current === 0) {
              closed.resolve();
            }
          }
        },
      }),
    );
    const manager = createManager();
    const read = async () => {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        headers: { Connection: "close" },
      });
      return response.text();
    };
    try {
      await manager.startChannels();
      const first = await firstStarted.promise;
      const firstPort = port;
      expect(await read()).toBe("ready:ready:1");
      crash.resolve();
      await closed.promise;
      expect(first.listening).toBe(false);
      await waitForMicrotaskCondition(
        () => manager.isAutoRestartScheduled("discord", DEFAULT_ACCOUNT_ID),
        "expected automatic channel restart after worker crash",
      );
      await vi.advanceTimersByTimeAsync(10);
      const second = await secondStarted.promise;
      expect(second).not.toBe(first);
      expect(port).toBe(firstPort);
      expect(await read()).toBe("ready:ready:2");
    } finally {
      await manager.stopChannel("discord");
    }
  });

  it("resets the restart counter after a stable run rejects", async () => {
    const attemptsAtStart: number[] = [];
    let calls = 0;
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      attemptsAtStart.push(ctx.getStatus().reconnectAttempts ?? 0);
      calls += 1;
      if (calls === 3) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, stableChannelRunMs + 1_000);
        });
        throw new Error("stable run ended");
      }
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    // Two instant exits accumulate attempts 1 and 2; the third run is stable.
    await advanceTimersUntil(
      () => startAccount.mock.calls.length >= 3,
      "expected two crash-loop restarts before the stable run",
      { stepMs: 10, maxMs: 500 },
    );
    await advanceTimersUntil(
      () => startAccount.mock.calls.length >= 4,
      "expected an auto-restart after the stable run exited",
      { stepMs: 30_000, maxMs: 4 * stableChannelRunMs },
    );

    expect(attemptsAtStart[3]).toBe(1);
  });

  it("does not count slow cleanup as a stable channel run", async () => {
    const attemptsAtStart: number[] = [];
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      attemptsAtStart.push(ctx.getStatus().reconnectAttempts ?? 0);
    });
    hoisted.startChannelApprovalHandlerBootstrap.mockImplementation(async () => {
      const run = hoisted.startChannelApprovalHandlerBootstrap.mock.calls.length;
      return async () => {
        if (run === 3) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, stableChannelRunMs + 1_000);
          });
        }
      };
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await advanceTimersUntil(
      () => startAccount.mock.calls.length >= 3,
      "expected two crash-loop restarts before slow cleanup",
      { stepMs: 10, maxMs: 500 },
    );
    await advanceTimersUntil(
      () => startAccount.mock.calls.length >= 4,
      "expected an auto-restart after slow cleanup",
      { stepMs: 30_000, maxMs: 4 * stableChannelRunMs },
    );

    expect(attemptsAtStart[3]).toBe(3);
  });

  it("lets stop hooks update status after aborting the running task", async () => {
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      ctx.setStatus({
        accountId: DEFAULT_ACCOUNT_ID,
        running: true,
        connected: true,
        lastError: "startup warning",
      });
      await waitForAbort(ctx.abortSignal);
    });
    const stopAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      ctx.setStatus({
        accountId: DEFAULT_ACCOUNT_ID,
        connected: false,
        lastError: null,
      });
    });
    installTestRegistry(createTestPlugin({ startAccount, stopAccount }));
    const manager = createManager();

    await manager.startChannels();
    await flushMicrotasks();
    expect(readAccount(manager)?.lifecycle).toBe("ready");
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);

    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(stopAccount).toHaveBeenCalledTimes(1);
    expect(account?.running).toBe(false);
    expect(account?.connected).toBe(false);
    expect(account?.lifecycle).toBe("stopped");
    expect(account?.lastError).toBeNull();
  });

  it("keeps a running channel without transport reporting free of a synthetic disconnect", async () => {
    // Socketless channels (imessage, signal, sms, ...) never publish `connected`.
    // Projecting a synthetic `false` made the health monitor read them as
    // disconnected and restart them once per cooldown window forever.
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      ctx.setStatus({ accountId: DEFAULT_ACCOUNT_ID, running: true });
      await waitForAbort(ctx.abortSignal);
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await flushMicrotasks();

    const account = readAccount(manager);
    expect(account?.running).toBe(true);
    expect(account).not.toHaveProperty("connected");
    expect(healthOf(account)).toEqual({ healthy: true, reason: "healthy" });
  });

  it("settles every account before surfacing a stop hook failure", async () => {
    const accountIds = ["broken", "healthy"];
    const taskReleases = new Map(accountIds.map((accountId) => [accountId, createDeferred()]));
    const startAccount = vi.fn(
      async ({ abortSignal, accountId }: ChannelGatewayContext<TestAccount>) =>
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener(
            "abort",
            () => {
              void taskReleases.get(accountId)?.promise.then(resolve);
            },
            { once: true },
          );
        }),
    );
    const stopAccount = vi.fn(async ({ accountId }: ChannelGatewayContext<TestAccount>) => {
      if (accountId === "broken") {
        throw new Error("stop hook failed");
      }
    });
    installTestRegistry(
      createTestPlugin({
        listAccountIds: () => accountIds,
        resolveAccount: () => ({ enabled: true, configured: true }),
        startAccount,
        stopAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    await flushMicrotasks();
    const stopTask = manager.stopChannel("discord");
    let stopSettled = false;
    void stopTask.then(
      () => {
        stopSettled = true;
      },
      () => {
        stopSettled = true;
      },
    );
    try {
      await flushMicrotasks();
      expect(stopSettled).toBe(false);

      taskReleases.get("healthy")?.resolve();
      await flushMicrotasks();
      expect(stopSettled).toBe(false);

      taskReleases.get("broken")?.resolve();
      await expect(stopTask).rejects.toThrow("stop hook failed");
      const accounts = manager.getRuntimeSnapshot().channelAccounts.discord;
      expect(stopAccount.mock.calls.map(([context]) => context.accountId)).toEqual(accountIds);
      expect(accounts?.broken).toMatchObject({
        running: true,
        restartPending: false,
        lastError: "stop hook failed",
      });
      expect(accounts?.healthy).toMatchObject({ running: false, lastError: null });

      await manager.startChannel("discord", "broken");
      expect(startAccount).toHaveBeenCalledTimes(2);
    } finally {
      for (const release of taskReleases.values()) {
        release.resolve();
      }
    }
  });

  it("retains the admitted teardown owner for a failed stop retry after account removal", async () => {
    const originalConfig: OpenClawConfig = {
      channels: { discord: { accounts: { alpha: { enabled: true } } } },
    };
    let config = originalConfig;
    let stopFails = true;
    const stopAccount = vi.fn(async (_context: ChannelGatewayContext<TestAccount>) => {
      if (stopFails) {
        throw new Error("first stop failed");
      }
    });
    installTestRegistry(
      createTestPlugin({
        listAccountIds: (cfg) => Object.keys(cfg.channels?.discord?.accounts ?? {}),
        resolveAccount: (cfg, id) => {
          const account = cfg.channels?.discord?.accounts?.[id ?? DEFAULT_ACCOUNT_ID];
          if (!account) {
            throw new Error(`Account ${id} no longer exists`);
          }
          return account;
        },
        startAccount: async ({ abortSignal }) => await waitForAbort(abortSignal),
        stopAccount,
      }),
    );
    const manager = createManager({ getRuntimeConfig: () => config });
    await manager.startChannels();
    await flushMicrotasks();
    await expect(manager.stopChannel("discord", "alpha", { manual: false })).rejects.toThrow(
      "first stop failed",
    );
    config = { channels: { discord: { accounts: {} } } };
    stopFails = false;
    await expect(
      manager.stopChannel("discord", "alpha", { manual: false }),
    ).resolves.toBeUndefined();
    expect(stopAccount).toHaveBeenCalledTimes(2);
    expect(stopAccount.mock.calls[1]?.[0].cfg).toBe(originalConfig);
    expect(stopAccount.mock.calls[1]?.[0].account).toBe(
      originalConfig.channels?.discord?.accounts?.alpha,
    );
  });

  it.each(["hook-timeout", "task-timeout"] as const)(
    "releases retired channel slots for explicit replacement after %s",
    async (failure) => {
      const stopEntered = createDeferred();
      const releaseStop = createDeferred();
      const releaseTask = createDeferred();
      const started: ChannelGatewayContext<TestAccount>[] = [];
      const stopped: ChannelGatewayContext<TestAccount>[] = [];
      let cleanupFails = true;
      const registry = installTestRegistry(
        createTestPlugin({
          listAccountIds: () => ["target", "sibling"],
          startAccount: async (context) => {
            started.push(context);
            context.setStatus(channelReadyPatch({ accountId: context.accountId }));
            if (
              context.accountId === "target" &&
              started.filter((entry) => entry.accountId === "target").length === 1 &&
              failure === "task-timeout"
            ) {
              await releaseTask.promise;
              return;
            }
            await waitForAbort(context.abortSignal);
          },
          stopAccount: async (context) => {
            stopped.push(context);
            if (context.accountId !== "target" || !cleanupFails) {
              return;
            }
            stopEntered.resolve();
            if (failure === "hook-timeout") {
              await releaseStop.promise;
            }
          },
        }),
      );
      const manager = createManager({ getPluginRegistry: () => registry });
      try {
        await manager.startChannels();
        await flushMicrotasks();
        const predecessor = started.find((context) => context.accountId === "target");
        const sibling = started.find((context) => context.accountId === "sibling");
        expect(predecessor).toBeDefined();
        expect(sibling).toBeDefined();
        const stopping = manager
          .stopChannel("discord", "target", { manual: false, strict: true, routeHandoff: true })
          .catch((error: unknown) => error);
        await stopEntered.promise;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await stopping).toBeInstanceOf(Error);
        expect(predecessor?.abortSignal.aborted).toBe(true);

        expect(
          await manager.startChannel("discord", "target", { preserveManualStop: true }),
        ).toEqual(new Map([["target", { status: "handed-off" }]]));
        await flushMicrotasks();
        expect(started.filter((context) => context.accountId === "target")).toHaveLength(2);
        expect(started.filter((context) => context.accountId === "sibling")).toHaveLength(1);
        expect(sibling?.abortSignal.aborted).toBe(false);
        predecessor?.setStatus(channelBlockedPatch("late predecessor", { accountId: "target" }));
        stopped[0]?.setStatus(channelBlockedPatch("late stop", { accountId: "target" }));
        releaseStop.resolve();
        releaseTask.resolve();
        await flushMicrotasks(30);
        expect(manager.getRuntimeSnapshot().channelAccounts.discord?.target).toMatchObject({
          running: true,
          lifecycle: "ready",
          terminalDisconnect: undefined,
        });
      } finally {
        cleanupFails = false;
        releaseStop.resolve();
        releaseTask.resolve();
        await flushMicrotasks(30);
        await manager.stopChannel("discord");
      }
    },
  );

  it("replaces pending preparation without accepting its late rejection", async () => {
    const preparing = createDeferred();
    const releasePreparation = createDeferred();
    let firstPreparation = true;
    const startAccount = vi.fn(async (context: ChannelGatewayContext<TestAccount>) => {
      context.setStatus(channelReadyPatch({ accountId: context.accountId }));
      await waitForAbort(context.abortSignal);
    });
    installTestRegistry(
      createTestPlugin({
        startAccount,
        isConfigured: async () => {
          if (!firstPreparation) {
            return true;
          }
          firstPreparation = false;
          preparing.resolve();
          await releasePreparation.promise;
          throw new Error("retired preparation failed");
        },
      }),
    );
    const manager = createManager();
    const original = manager.startChannel("discord", DEFAULT_ACCOUNT_ID).catch(() => undefined);
    let replacement: ReturnType<ChannelManager["startChannel"]> | undefined;
    try {
      await preparing.promise;
      await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, {
        manual: false,
        strict: true,
        routeHandoff: true,
      });
      replacement = manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
      await waitForImmediate();
      expect(startAccount).toHaveBeenCalledOnce();
      expect(await replacement).toEqual(new Map([[DEFAULT_ACCOUNT_ID, { status: "handed-off" }]]));
      releasePreparation.resolve();
      await original;
      expect(readAccount(manager)).toMatchObject({
        running: true,
        configured: true,
        lifecycle: "ready",
        lastError: null,
      });
    } finally {
      releasePreparation.resolve();
      await Promise.allSettled([original, replacement]);
      await manager.stopChannel("discord");
    }
  });

  it("retains pending-start cleanup ownership after a strict stop timeout", async () => {
    const preparing = createDeferred();
    const releasePreparation = createDeferred();
    const stopping = createDeferred();
    const releaseStop = createDeferred();
    const startAccount = vi.fn(async ({ abortSignal }: ChannelGatewayContext<TestAccount>) => {
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const stopAccount = vi
      .fn(async () => {})
      .mockImplementationOnce(async () => {
        stopping.resolve();
        await releaseStop.promise;
      });
    installTestRegistry(
      createTestPlugin({
        startAccount,
        stopAccount,
        isConfigured: async () => {
          preparing.resolve();
          await releasePreparation.promise;
          return true;
        },
      }),
    );
    const manager = createManager();
    const starting = manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    let stopped: Promise<unknown> | undefined;
    let joinedStop: Promise<void> | undefined;
    try {
      await preparing.promise;
      stopped = manager
        .stopChannel("discord", DEFAULT_ACCOUNT_ID, { manual: false, strict: true })
        .catch((error: unknown) => error);
      await stopping.promise;
      releasePreparation.resolve();
      await starting;
      expect(startAccount).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await stopped).toBeInstanceOf(Error);
      let joined = false;
      joinedStop = manager
        .stopChannel("discord", DEFAULT_ACCOUNT_ID, { manual: false, strict: true })
        .then(() => {
          joined = true;
        });
      await flushMicrotasks();
      expect(joined).toBe(false);
      expect(stopAccount).toHaveBeenCalledOnce();
      releaseStop.resolve();
      await expect(joinedStop).resolves.toBeUndefined();
      expect(stopAccount).toHaveBeenCalledOnce();
      await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
      await flushMicrotasks();
      expect(startAccount).toHaveBeenCalledOnce();
    } finally {
      releasePreparation.resolve();
      releaseStop.resolve();
      await Promise.allSettled([starting, stopped, joinedStop]);
    }
  });

  it("serializes overlapping stops until the last teardown settles", async () => {
    const releaseTask = createDeferred();
    const stopHooks = [createDeferred(), createDeferred()];
    const startAccount = vi.fn(async () => await releaseTask.promise);
    const stopAccount = vi.fn(async () => {
      const callIndex = stopAccount.mock.calls.length - 1;
      await stopHooks[callIndex]?.promise;
      if (callIndex === 1) {
        throw new Error("second stop failed");
      }
    });
    installTestRegistry(createTestPlugin({ startAccount, stopAccount }));
    const manager = createManager();

    await manager.startChannels();
    const firstStop = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, { manual: false });
    const secondStop = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, { manual: false });
    const secondFailure = expect(secondStop).rejects.toThrow("second stop failed");

    releaseTask.resolve();
    stopHooks[0]?.resolve();
    await expect(firstStop).resolves.toBeUndefined();
    await flushMicrotasks();
    expect(stopAccount).toHaveBeenCalledTimes(2);

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(startAccount).toHaveBeenCalledTimes(1);

    stopHooks[1]?.resolve();
    await secondFailure;
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(readAccount(manager)).toMatchObject({
      running: true,
      restartPending: false,
      lastError: "second stop failed",
    });

    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(stopAccount).toHaveBeenCalledTimes(3);
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(startAccount).toHaveBeenCalledTimes(2);
  });

  it("keeps a timed-out stop hook failure authoritative after late task settlement", async () => {
    const releaseTask = createDeferred();
    const startAccount = vi.fn(async () => {
      await releaseTask.promise;
      throw new Error("late task failure");
    });
    let stopShouldFail = true;
    const stopAccount = vi.fn(async () => {
      if (stopShouldFail) {
        throw new Error("stop hook failed");
      }
    });
    let accountIds = [DEFAULT_ACCOUNT_ID];
    installTestRegistry(
      createTestPlugin({ startAccount, stopAccount, listAccountIds: () => accountIds }),
    );
    const manager = createManager();

    await manager.startChannels();
    const stopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, { manual: false });
    const stopFailure = expect(stopTask).rejects.toThrow("stop hook failed");
    await vi.advanceTimersByTimeAsync(5_000);
    await stopFailure;

    releaseTask.resolve();
    await flushMicrotasks();
    expect(readAccount(manager)).toMatchObject({
      running: true,
      restartPending: false,
      lastError: "stop hook failed",
    });

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(startAccount).toHaveBeenCalledTimes(1);

    accountIds = [];
    await manager.startChannels();
    accountIds = [DEFAULT_ACCOUNT_ID];
    await manager.startChannels();
    expect(startAccount).toHaveBeenCalledTimes(1);

    stopShouldFail = false;
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(startAccount).toHaveBeenCalledTimes(2);
  });

  it("bounds idle-stop account preparation and fences teardown after its timeout", async () => {
    const preparing = createDeferred();
    const release = createDeferred();
    const stopAccount = vi.fn(async () => undefined);
    const plugin = createTestPlugin({ stopAccount });
    plugin.config.resolveAccountAsync = async () => {
      preparing.resolve();
      await release.promise;
      return { enabled: true, configured: true };
    };
    installTestRegistry(plugin);
    const manager = createManager();
    const stopping = manager
      .stopChannel("discord", DEFAULT_ACCOUNT_ID, { strict: true })
      .catch((error: unknown) => error);
    await preparing.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await stopping).toBeInstanceOf(Error);
    release.resolve();
    await flushMicrotasks();
    expect(stopAccount).not.toHaveBeenCalled();
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(stopAccount).toHaveBeenCalledOnce();
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

  it.each(["thaw", "health-monitor"] as const)(
    "keeps %s recovery limited to listed accounts while an unlisted sibling stays active",
    async (recovery) => {
      const admitted = new Map<string, ChannelGatewayContext<TestAccount>>();
      const starts: string[] = [];
      const stops: string[] = [];
      installTestRegistry(
        createTestPlugin({
          listAccountIds: () => ["listed"],
          startAccount: async (context) => {
            admitted.set(context.accountId, context);
            starts.push(context.accountId);
            context.setStatus({
              accountId: context.accountId,
              connected: true,
              lastTransportActivityAt: Date.now(),
            });
            await waitForAbort(context.abortSignal);
          },
          stopAccount: async (context) => {
            stops.push(context.accountId);
          },
        }),
      );
      const manager = createManager();
      await manager.startChannels();
      await manager.startChannel("discord", "recovered");
      const listedSignal = admitted.get("listed")?.abortSignal;
      const recoveredSignal = admitted.get("recovered")?.abortSignal;

      if (recovery === "thaw") {
        const errors: string[] = [];
        expect(
          await restartRunningChannelAccounts(manager, {
            shouldContinue: () => true,
            onError: (message) => errors.push(message),
          }),
        ).toEqual([]);
        expect(errors).toEqual([]);
      } else {
        const monitor = startChannelHealthMonitor({
          scheduler: createTestGatewayScheduler("fake-timers"),
          channelManager: manager,
          timing: { monitorStartupGraceMs: 2, channelConnectGraceMs: 0, staleEventThresholdMs: 1 },
        });
        try {
          await vi.advanceTimersByTimeAsync(2);
          await monitor.waitForIdle();
        } finally {
          monitor.shutdown();
        }
      }

      expect(starts).toEqual(["listed", "recovered", "listed"]);
      expect(stops).toEqual(["listed"]);
      expect(listedSignal?.aborted).toBe(true);
      expect(admitted.get("listed")?.abortSignal.aborted).toBe(false);
      expect(recoveredSignal?.aborted).toBe(false);
      expect(manager.getRuntimeSnapshot().channelAccounts.discord).toMatchObject({
        listed: { running: true },
        recovered: { running: true },
      });
    },
  );

  it.each(["thaw", "health-monitor"] as const)(
    "does not recreate an account removed while %s awaits its stop",
    async (recovery) => {
      let accountIds = ["removed"];
      const stopStarted = createDeferred();
      const releaseStop = createDeferred();
      const startAccount = vi.fn(async (context: ChannelGatewayContext<TestAccount>) => {
        context.setStatus({
          accountId: context.accountId,
          connected: true,
          lastTransportActivityAt: Date.now(),
        });
        await waitForAbort(context.abortSignal);
      });
      installTestRegistry(
        createTestPlugin({
          listAccountIds: () => accountIds,
          resolveAccount: () => ({ enabled: true, configured: true }),
          startAccount,
          stopAccount: async () => {
            stopStarted.resolve();
            await releaseStop.promise;
          },
        }),
      );
      const manager = createManager();
      await manager.startChannels();
      const errors: string[] = [];
      const monitor =
        recovery === "health-monitor"
          ? startChannelHealthMonitor({
              scheduler: createTestGatewayScheduler("fake-timers"),
              channelManager: manager,
              timing: {
                monitorStartupGraceMs: 2,
                channelConnectGraceMs: 0,
                staleEventThresholdMs: 1,
              },
            })
          : undefined;
      const thaw =
        recovery === "thaw"
          ? restartRunningChannelAccounts(manager, {
              shouldContinue: () => true,
              onError: (message) => errors.push(message),
            })
          : undefined;
      try {
        if (monitor) {
          await vi.advanceTimersByTimeAsync(2);
        }
        await stopStarted.promise;
        accountIds = [];
        releaseStop.resolve();
        if (thaw) {
          expect(await thaw).toEqual([]);
        }
        await monitor?.waitForIdle();

        expect(errors).toEqual([]);
        expect(startAccount).toHaveBeenCalledOnce();
        expect(firstStartAccountContext(startAccount).abortSignal.aborted).toBe(true);
        expect(manager.getRuntimeSnapshot().channelAccounts.discord?.removed).toBeUndefined();
      } finally {
        releaseStop.resolve();
        monitor?.shutdown();
        await thaw;
      }
    },
  );

  it("retries only the failed account after a partial host-thaw restart", async () => {
    let failStop = true;
    const errors: string[] = [];
    const starts: string[] = [];
    const stops: string[] = [];
    installTestRegistry(
      createTestPlugin({
        listAccountIds: () => ["healthy", "broken"],
        startAccount: async (context) => {
          starts.push(context.accountId);
          await waitForAbort(context.abortSignal);
        },
        stopAccount: async (context) => {
          stops.push(context.accountId);
          if (context.accountId === "broken" && failStop) {
            throw new Error("stop failed");
          }
        },
      }),
    );
    const manager = createManager();
    await manager.startChannels();
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    starts.length = 0;
    stops.length = 0;

    const failedTargets = await restartRunningChannelAccounts(manager, {
      shouldContinue: () => true,
      onError: (message) => errors.push(message),
    });
    expect(failedTargets).toEqual([{ channelId: "discord", accountId: "broken" }]);
    expect(starts).toEqual(["healthy"]);
    expect(stops).toEqual(["healthy", "broken"]);
    expect(errors).toEqual(["[discord:broken] host-thaw restart failed: Error: stop failed"]);

    failStop = false;
    const second = await restartRunningChannelAccounts(
      manager,
      { shouldContinue: () => true, onError: (message) => errors.push(message) },
      { kind: "deferred-retry", targets: failedTargets },
    );
    expect(second).toEqual([]);
    expect(starts).toEqual(["healthy", "broken"]);
    expect(stops).toEqual(["healthy", "broken", "broken"]);
  });

  it("resnapshots running accounts when a new thaw arrives during a failed retry", async () => {
    let failBrokenStop = true;
    const starts: string[] = [];
    const stops: string[] = [];
    installTestRegistry(
      createTestPlugin({
        listAccountIds: () => ["healthy", "broken"],
        startAccount: async (context) => {
          starts.push(context.accountId);
          await waitForAbort(context.abortSignal);
        },
        stopAccount: async (context) => {
          stops.push(context.accountId);
          if (context.accountId === "broken" && failBrokenStop) {
            throw new Error("stop failed");
          }
        },
      }),
    );
    const manager = createManager();
    await manager.startChannels();
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    starts.length = 0;
    stops.length = 0;

    const pendingTargets = await restartRunningChannelAccounts(manager, {
      shouldContinue: () => true,
      onError: () => {},
    });
    expect(pendingTargets).toEqual([{ channelId: "discord", accountId: "broken" }]);
    expect(starts).toEqual(["healthy"]);

    failBrokenStop = false;
    starts.length = 0;
    stops.length = 0;
    const next = await restartRunningChannelAccounts(
      manager,
      { shouldContinue: () => true, onError: () => {} },
      { kind: "new-thaw", pendingTargets },
    );

    expect(next).toEqual([]);
    expect(starts).toEqual(["broken", "healthy"]);
    expect(stops).toEqual(["broken", "healthy"]);
  });

  it("discards a deferred thaw target removed from the current account list", async () => {
    let accountIds = ["removed"];
    let failStart = false;
    const startAccount = vi.fn(
      async (context: ChannelGatewayContext<TestAccount>) =>
        await waitForAbort(context.abortSignal),
    );
    installTestRegistry(
      createTestPlugin({
        listAccountIds: () => accountIds,
        isConfigured: async () => {
          if (failStart) {
            throw new Error("start preflight failed");
          }
          return true;
        },
        startAccount,
      }),
    );
    const manager = createManager();
    await manager.startChannels();
    await vi.waitFor(() => expect(startAccount).toHaveBeenCalledOnce());

    failStart = true;
    const failedTargets = await restartRunningChannelAccounts(manager, {
      shouldContinue: () => true,
      onError: () => {},
    });
    expect(failedTargets).toEqual([{ channelId: "discord", accountId: "removed" }]);

    accountIds = [];
    failStart = false;
    const errors: string[] = [];
    const second = await restartRunningChannelAccounts(
      manager,
      { shouldContinue: () => true, onError: (message) => errors.push(message) },
      { kind: "deferred-retry", targets: failedTargets },
    );

    expect(second).toEqual([]);
    expect(errors).toEqual([]);
    expect(startAccount).toHaveBeenCalledOnce();
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.removed).toBeUndefined();
  });

  it("does not retain an account that becomes unconfigured during host-thaw recovery", async () => {
    let configured = true;
    const startAccount = vi.fn(
      async (context: ChannelGatewayContext<TestAccount>) =>
        await waitForAbort(context.abortSignal),
    );
    installTestRegistry(
      createTestPlugin({
        includeDescribeAccount: false,
        resolveAccount: () => ({
          enabled: true,
          configured,
        }),
        isConfigured: (account) => account.configured !== false,
        startAccount,
      }),
    );
    const manager = createManager();
    await manager.startChannels();
    await vi.waitFor(() => expect(startAccount).toHaveBeenCalledOnce());

    configured = false;
    const errors: string[] = [];
    const failedTargets = await restartRunningChannelAccounts(manager, {
      shouldContinue: () => true,
      onError: (message) => errors.push(message),
    });

    expect(failedTargets).toEqual([]);
    expect(errors).toEqual([]);
    expect(startAccount).toHaveBeenCalledOnce();
    expect(readAccount(manager)).toMatchObject({
      running: false,
      configured: false,
    });
  });

  it("completes a timed-out channel restart in one host-thaw pass", async () => {
    const startAccount = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      abortSignal.addEventListener("abort", () => {}, { once: true });
      await new Promise<void>(() => {});
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();
    await manager.startChannels();

    const restartTask = restartRunningChannelAccounts(manager, {
      shouldContinue: () => true,
      onError: () => {},
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await restartTask;

    const account = readAccount(manager);
    expect(startAccount).toHaveBeenCalledTimes(2);
    expect(account?.running).toBe(true);
    expect(account?.restartPending).toBe(false);
  });

  it("does not repeat a thaw recovery start after the pending account is removed", async () => {
    let accountIds = [DEFAULT_ACCOUNT_ID];
    const releaseTask = createDeferred();
    const startAccount = vi.fn(async () => await releaseTask.promise);
    installTestRegistry(
      createTestPlugin({
        listAccountIds: () => accountIds,
        resolveAccount: () => ({ enabled: true, configured: true }),
        startAccount,
      }),
    );
    const manager = createManager();
    await manager.startChannels();
    const startChannel = manager.startChannel;
    const recoveryStart = vi.spyOn(manager, "startChannel").mockImplementation(async (...args) => {
      const outcome = await startChannel(...args);
      accountIds = [];
      return outcome;
    });
    const errors: string[] = [];
    try {
      const restartTask = restartRunningChannelAccounts(manager, {
        shouldContinue: () => true,
        onError: (message) => errors.push(message),
      });
      await vi.advanceTimersByTimeAsync(5_000);

      const pendingTargets = await restartTask;
      expect(pendingTargets).toEqual([{ channelId: "discord", accountId: DEFAULT_ACCOUNT_ID }]);
      expect(recoveryStart).toHaveBeenCalledOnce();
      expect(startAccount).toHaveBeenCalledOnce();
      expect(
        await restartRunningChannelAccounts(
          manager,
          { shouldContinue: () => true, onError: (message) => errors.push(message) },
          { kind: "deferred-retry", targets: pendingTargets },
        ),
      ).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(recoveryStart).toHaveBeenCalledOnce();
    } finally {
      releaseTask.resolve();
      await flushMicrotasks();
    }
  });

  it("stops thaw restarts once admission closes mid-pass", async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    installTestRegistry(
      createTestPlugin({
        listAccountIds: () => ["first", "second"],
        startAccount: async (context) => {
          starts.push(context.accountId);
          await waitForAbort(context.abortSignal);
        },
        stopAccount: async (context) => {
          stops.push(context.accountId);
        },
      }),
    );
    const manager = createManager();
    await manager.startChannels();
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    starts.length = 0;
    stops.length = 0;

    let open = true;
    await restartRunningChannelAccounts(manager, {
      shouldContinue: () => {
        if (stops.length > 0) {
          // Simulate a suspension committing while the first stop was awaited.
          open = false;
        }
        return open;
      },
      onError: () => {},
    });

    expect(stops).toEqual(["first"]);
    expect(starts).toEqual([]);
  });

  it("accepts explicit channel-authored ready recovery within the same task", async () => {
    let publishReady: (() => void) | undefined;
    let publishStopped: (() => void) | undefined;
    let blockedLastStartAt: number | null | undefined;
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      ctx.setStatus({
        accountId: ctx.accountId,
        terminalDisconnect: true,
        lifecycle: "blocked",
        lastError: "relink required",
      });
      blockedLastStartAt = ctx.getStatus().lastStartAt;
      publishReady = () => ctx.setStatus(channelReadyPatch({ accountId: ctx.accountId }));
      publishStopped = () =>
        ctx.setStatus({
          accountId: ctx.accountId,
          running: false,
          connected: false,
          lifecycle: "stopped",
        });
      await waitForAbort(ctx.abortSignal);
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await vi.waitFor(() => expect(publishReady).toBeDefined());
    expect(healthOf(readAccount(manager)).reason).toBe("blocked");

    publishReady?.();

    const recovered = readAccount(manager);
    expect(startAccount).toHaveBeenCalledOnce();
    expect(recovered).toMatchObject({
      running: true,
      connected: true,
      lifecycle: "ready",
      terminalDisconnect: undefined,
      lastError: null,
      lastStartAt: blockedLastStartAt,
    });
    expect(healthOf(recovered)).toEqual({ healthy: true, reason: "healthy" });

    publishStopped?.();

    const stopped = readAccount(manager);
    expect(stopped).toMatchObject({
      running: false,
      connected: false,
      lifecycle: "stopped",
      terminalDisconnect: undefined,
    });
    expect(healthOf(stopped)).toEqual({ healthy: false, reason: "not-running" });
  });

  it("keeps terminal diagnosis sticky across activity and connected backfill patches", async () => {
    let publishDerivedSignals: (() => void) | undefined;
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      ctx.setStatus({
        accountId: ctx.accountId,
        terminalDisconnect: true,
        lifecycle: "blocked",
        lastError: "relink required",
      });
      publishDerivedSignals = () => {
        ctx.setStatus({
          accountId: ctx.accountId,
          ...createTransportActivityStatusPatch(),
        });
        ctx.setStatus({ accountId: ctx.accountId, connected: true });
      };
      await waitForAbort(ctx.abortSignal);
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await vi.waitFor(() => expect(publishDerivedSignals).toBeDefined());
    publishDerivedSignals?.();

    expect(readAccount(manager)).toMatchObject({
      connected: true,
      lifecycle: "blocked",
      terminalDisconnect: true,
      lastError: "relink required",
      lastTransportActivityAt: expect.any(Number),
    });
  });

  it("recovers a manually restarted channel from a transient failure after terminal disconnect", async () => {
    const handoffStates: ChannelAccountSnapshot[] = [];
    const handoffSignals: AbortSignal[] = [];
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      handoffStates.push({ ...ctx.getStatus() });
      handoffSignals.push(ctx.abortSignal);
      if (handoffStates.length === 1) {
        ctx.setStatus({
          accountId: ctx.accountId,
          terminalDisconnect: true,
          lifecycle: "blocked",
          lastError: "relink required",
        });
        return;
      }
      if (handoffStates.length === 2) {
        throw new Error("transient reconnect failure");
      }
      ctx.setStatus({ accountId: ctx.accountId, connected: true });
      await waitForAbort(ctx.abortSignal);
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(20);

    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(readAccount(manager)).toMatchObject({
      terminalDisconnect: true,
      running: false,
      lifecycle: "blocked",
      lastError: "relink required",
      restartPending: false,
    });
    expect(healthOf(readAccount(manager)).reason).toBe("terminal-disconnect");
    expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { manual: true });
    await advanceTimersUntil(
      () => startAccount.mock.calls.length === 3,
      "expected a transient failure after manual restart to recover automatically",
      { stepMs: 10, maxMs: 100 },
    );
    await flushMicrotasks();

    expect(handoffStates.map(({ lifecycle }) => lifecycle)).toEqual([
      "starting",
      "starting",
      "starting",
    ]);
    expect(handoffStates[1]?.terminalDisconnect).toBeUndefined();
    expect(handoffStates[2]?.terminalDisconnect).toBeUndefined();
    expect(handoffSignals[0]?.aborted).toBe(true);
    expect(handoffSignals[1]?.aborted).toBe(true);
    expect(handoffSignals[2]?.aborted).toBe(false);
    expect(hoisted.sleepWithAbort).toHaveBeenCalledTimes(1);
    expect(hoisted.sleepWithAbort.mock.calls[0]?.[0]).toBe(10);
    expect(manager.isManuallyStopped("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
    expect(readAccount(manager)).toMatchObject({
      connected: true,
      running: true,
      lifecycle: "ready",
      restartPending: false,
      lastError: null,
      reconnectAttempts: 1,
    });
    expect(readAccount(manager)?.terminalDisconnect).toBeUndefined();
    expect(healthOf(readAccount(manager)).reason).not.toBe("terminal-disconnect");
  });

  it("does not restart when a timed-out recovery stop settles as terminal", async () => {
    const releaseFirstTask = createDeferred();
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      ctx.abortSignal.addEventListener("abort", () => {}, { once: true });
      await releaseFirstTask.promise;
      ctx.setStatus({ accountId: DEFAULT_ACCOUNT_ID, terminalDisconnect: true });
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    const stopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, { manual: false });
    await vi.advanceTimersByTimeAsync(5_000);
    await stopTask;
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);

    releaseFirstTask.resolve();
    await waitForMicrotaskCondition(
      () => readAccount(manager)?.restartPending === false,
      "expected terminal recovery completion to clear restart state",
    );

    const account = readAccount(manager);
    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(account?.terminalDisconnect).toBe(true);
    expect(account?.restartPending).toBe(false);
    expect(account?.reconnectAttempts).toBe(0);
    expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();
  });

  it("keeps recovery timeout diagnostics when a stale task reports connected after abort", async () => {
    let emitLateStatus: (() => void) | undefined;
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      ctx.setStatus({
        accountId: DEFAULT_ACCOUNT_ID,
        connected: true,
        lastError: null,
      });
      await new Promise<void>(() => {
        ctx.abortSignal.addEventListener(
          "abort",
          () => {
            emitLateStatus = () =>
              ctx.setStatus({
                accountId: DEFAULT_ACCOUNT_ID,
                connected: true,
                lastError: null,
              });
          },
          { once: true },
        );
      });
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    const recoveryStopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, {
      manual: false,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await recoveryStopTask;
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);

    emitLateStatus?.();
    const account = readAccount(manager);
    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(account?.running).toBe(false);
    expect(account?.connected).toBe(false);
    expect(account?.restartPending).toBe(true);
    expect(account?.lifecycle).toBe("recovering");
    expect(account?.reconnectAttempts).toBe(0);
    expect(account?.lastError).toContain("channel stop timed out");
  });

  it.each(["superseded", "terminal"] as const)(
    "ends retry ingress with the recovery lifetime (%s)",
    async (mode) => {
      const terminal = mode === "terminal";
      const replacement = createDeferred();
      let starts = 0;
      const registry = installTestRegistry(
        createTestPlugin({
          startAccount: async ({ abortSignal, setStatus }) => {
            const stopped = waitForAbort(abortSignal);
            const generation = ++starts;
            if (generation === 2) {
              if (terminal) {
                setStatus(
                  channelBlockedPatch("startup blocked", { accountId: DEFAULT_ACCOUNT_ID }),
                );
                await Promise.race([stopped, replacement.promise]);
                if (abortSignal.aborted) {
                  return;
                }
              } else {
                throw new Error("startup failed");
              }
            }
            if (generation === 3) {
              await replacement.promise;
            }
            registerPluginHttpRoute({
              path: "/plugins/reload/retry",
              auth: "plugin",
              pluginId: "discord",
              handler: vi.fn(),
              throwOnFailure: true,
            });
            setStatus(channelReadyPatch({ accountId: DEFAULT_ACCOUNT_ID }));
            await stopped;
          },
        }),
      );
      const manager = createManager({ getPluginRegistry: () => registry });
      try {
        await manager.startChannels();
        await manager.stopChannel("discord", undefined, { manual: false, routeHandoff: true });
        await manager.startChannels();
        await flushMicrotasks(30);
        if (terminal) {
          expect(registry.httpRoutes).toEqual([]);
          expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();
          replacement.resolve();
          await flushMicrotasks(30);
          expect(registry.httpRoutes.map((route) => route.handoff)).toEqual([undefined]);
          expect(readAccount(manager)).toMatchObject({
            lifecycle: "ready",
            terminalDisconnect: undefined,
          });
          return;
        }
        expect(registry.httpRoutes.map((route) => route.handoff)).toEqual([true]);
        await manager.stopChannel("discord", undefined, { manual: false, routeHandoff: true });
        expect(registry.httpRoutes.map((route) => route.handoff)).toEqual([true]);
        await manager.startChannels();
        expect(starts).toBe(3);
        expect(registry.httpRoutes.map((route) => route.handoff)).toEqual([true]);
        replacement.resolve();
        await flushMicrotasks();
        expect(registry.httpRoutes.map((route) => route.handoff)).toEqual([undefined]);
      } finally {
        replacement.resolve();
        await manager.stopChannel("discord");
      }
    },
  );

  it("terminal pending startup preserves its pending sibling handoff", async () => {
    const siblingReady = createDeferred();
    const starts = new Map<string, number>();
    const sharedHandler = vi.fn();
    const registry = installTestRegistry(
      createTestPlugin({
        listAccountIds: () => ["blocked", "healthy"],
        startAccount: async ({ accountId, abortSignal, setStatus }) => {
          const stopped = waitForAbort(abortSignal);
          const generation = (starts.get(accountId) ?? 0) + 1;
          starts.set(accountId, generation);
          if (generation === 2 && accountId === "blocked") {
            setStatus(channelBlockedPatch("startup validation failed", { accountId }));
            await stopped;
            return;
          }
          if (generation === 2 && accountId === "healthy") {
            await siblingReady.promise;
          }
          for (const key of [accountId, "shared"]) {
            registerPluginHttpRoute({
              path: `/plugins/terminal/${key}`,
              auth: "plugin",
              pluginId: "discord",
              source: key,
              handler: sharedHandler,
              reuseExistingSameOwner: true,
              throwOnFailure: true,
            });
          }
          setStatus(channelReadyPatch({ accountId }));
          await stopped;
        },
      }),
    );
    const manager = createManager({ getPluginRegistry: () => registry });
    const route = (key: string) =>
      registry.httpRoutes.find(({ path: routePath }) => routePath === `/plugins/terminal/${key}`);
    try {
      await manager.startChannels();
      await manager.stopChannel("discord", "blocked", { manual: false, routeHandoff: true });
      await manager.stopChannel("discord", "healthy", { manual: false, routeHandoff: true });
      await manager.startChannel("discord", "healthy");
      await manager.startChannel("discord", "blocked");
      await flushMicrotasks(30);
      expect(route("blocked")).toBeUndefined();
      expect(route("shared")?.handoff).toBe(true);
      expect(route("healthy")?.handoff).toBe(true);
      expect(manager.getRuntimeSnapshot().channelAccounts.discord?.blocked).toMatchObject({
        running: true,
        lifecycle: "blocked",
        terminalDisconnect: true,
      });
      expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();
      siblingReady.resolve();
      await flushMicrotasks(30);
      expect(route("shared")?.handler).toBe(sharedHandler);
      expect(route("shared")?.handoff).toBeUndefined();
      expect(starts.get("healthy")).toBe(2);
    } finally {
      siblingReady.resolve();
      await manager.stopChannel("discord");
    }
  });

  it("preserves admitted ingress when releasing handoffs after a stop failure", async () => {
    const replacement = createDeferred();
    const starts = new Map<string, number>();
    let failStop = true;
    const registry = installTestRegistry(
      createTestPlugin({
        listAccountIds: () => ["failed", "started"],
        startAccount: async ({ accountId, abortSignal, setStatus }) => {
          const generation = (starts.get(accountId) ?? 0) + 1;
          starts.set(accountId, generation);
          if (generation > 1) {
            await replacement.promise;
          }
          registerPluginHttpRoute({
            path: `/plugins/reload/${accountId}`,
            auth: "plugin",
            pluginId: "discord",
            handler: vi.fn(),
            throwOnFailure: true,
          });
          setStatus(channelReadyPatch({ accountId }));
          await waitForAbort(abortSignal);
        },
        stopAccount: async ({ accountId }) => {
          if (accountId === "failed" && failStop) {
            failStop = false;
            throw new Error("teardown failed");
          }
        },
      }),
    );
    const manager = createManager({ getPluginRegistry: () => registry });
    try {
      await manager.startChannels();
      await expect(
        manager.stopChannel("discord", undefined, { manual: false, routeHandoff: true }),
      ).rejects.toThrow("teardown failed");
      expect(
        await manager.startChannel("discord", undefined, { preserveManualStop: true }),
      ).toEqual(
        new Map([
          ["failed", { status: "handed-off" }],
          ["started", { status: "handed-off" }],
        ]),
      );
      manager.releaseChannelRouteHandoffs("discord");
      expect(
        registry.httpRoutes.map((route) => ({ path: route.path, handoff: route.handoff })),
      ).toEqual([
        { path: "/plugins/reload/failed", handoff: true },
        { path: "/plugins/reload/started", handoff: true },
      ]);
      replacement.resolve();
      await flushMicrotasks();
      expect(
        registry.httpRoutes.map((route) => ({ path: route.path, handoff: route.handoff })),
      ).toEqual([
        { path: "/plugins/reload/failed", handoff: undefined },
        { path: "/plugins/reload/started", handoff: undefined },
      ]);
    } finally {
      replacement.resolve();
      await manager.stopChannel("discord");
    }
  });

  it("retires unclaimed webhook paths on readiness after a timed-out stop", async () => {
    const firstRegistered = createDeferred<(next: ChannelAccountSnapshot) => void>();
    const stoppedStatus = createDeferred<(next: ChannelAccountSnapshot) => void>();
    const finishStop = createDeferred();
    const completeIngress = createDeferred();
    let starts = 0;
    const registry = installTestRegistry(
      createTestPlugin({
        startAccount: async ({ abortSignal, setStatus }) => {
          const generation = ++starts;
          const register = (suffix: string) =>
            registerPluginHttpRoute({
              path: `/plugins/reload/${generation}/${suffix}`,
              auth: "plugin",
              pluginId: "discord",
              handler: vi.fn(),
              throwOnFailure: true,
            });
          register("first");
          if (generation === 2) {
            setStatus({ accountId: DEFAULT_ACCOUNT_ID, lifecycle: "starting" });
            firstRegistered.resolve(setStatus);
            await completeIngress.promise;
          }
          register("second");
          setStatus(channelReadyPatch({ accountId: DEFAULT_ACCOUNT_ID }));
          await waitForAbort(abortSignal);
        },
        stopAccount: async ({ setStatus }) => {
          if (starts === 1) {
            stoppedStatus.resolve(setStatus);
            await finishStop.promise;
          }
        },
      }),
    );
    const manager = createManager({ getPluginRegistry: () => registry });
    try {
      await manager.startChannels();
      const stop = manager.stopChannel("discord", undefined, {
        manual: false,
        routeHandoff: true,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await stop;
      await manager.startChannels();
      const setReplacementStatus = await firstRegistered.promise;
      (await stoppedStatus.promise)(
        channelBlockedPatch("late stop diagnosis", { accountId: DEFAULT_ACCOUNT_ID }),
      );
      expect(readAccount(manager)?.terminalDisconnect).toBeUndefined();
      setReplacementStatus({ accountId: DEFAULT_ACCOUNT_ID, lifecycle: "starting" });
      expect(
        registry.httpRoutes.filter((route) => route.handoff).map((route) => route.path),
      ).toEqual(["/plugins/reload/1/first", "/plugins/reload/1/second"]);
      completeIngress.resolve();
      await flushMicrotasks();
      expect(registry.httpRoutes.map((route) => route.path)).toEqual([
        "/plugins/reload/2/first",
        "/plugins/reload/2/second",
      ]);
    } finally {
      completeIngress.resolve();
      finishStop.resolve();
      await manager.stopChannel("discord");
    }
  });

  it("keeps stopped webhook routes retryable until replacement ingress is ready", async () => {
    const route = { path: "/plugins/reload", auth: "plugin" as const, pluginId: "discord" };
    const replacement = createDeferred();
    let starts = 0;
    const registry = installTestRegistry(
      createTestPlugin({
        startAccount: async ({ abortSignal }) => {
          const generation = ++starts;
          if (generation > 1) {
            await replacement.promise;
          }
          if (abortSignal.aborted) {
            return;
          }
          const unregister = registerPluginHttpRoute({
            ...route,
            throwOnFailure: true,
            handler: (_req, res) => {
              res.end(String(generation));
              return true;
            },
          });
          await waitForAbort(abortSignal);
          unregister();
        },
      }),
    );
    const manager = createManager({ getPluginRegistry: () => registry });
    const server = createTestGatewayServer({
      resolvedAuth: AUTH_NONE,
      overrides: {
        getRuntimeConfig: () => ({}),
        handlePluginRequest: createGatewayPluginRequestHandler({
          registry,
          log: createSubsystemLogger("gateway/webhook-reload-test"),
        }),
      },
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected a TCP listener");
    }
    const read = async () => {
      // Fake timers hold Undici's idle-socket validation; route handoff does not require reuse.
      const response = await fetch(`http://127.0.0.1:${address.port}${route.path}`, {
        headers: { Connection: "close" },
      });
      return {
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        body: await response.text(),
      };
    };
    try {
      await manager.startChannels();
      expect(await read()).toMatchObject({ status: 200, body: "1" });
      await manager.stopChannel("discord", undefined, { manual: false, routeHandoff: true });
      expect(await read()).toMatchObject({ status: 503, retryAfter: "1" });
      await manager.startChannels();
      expect(await read()).toMatchObject({ status: 503, retryAfter: "1" });
      const repeatedStop = manager.stopChannel("discord", undefined, {
        manual: false,
        routeHandoff: true,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await repeatedStop;
      expect(await read()).toMatchObject({ status: 503, retryAfter: "1" });
      expect(await manager.startChannel("discord", DEFAULT_ACCOUNT_ID)).toEqual(
        new Map([[DEFAULT_ACCOUNT_ID, { status: "handed-off" }]]),
      );
      expect(await read()).toMatchObject({ status: 503, retryAfter: "1" });
      replacement.resolve();
      await flushMicrotasks();
      expect(await read()).toMatchObject({ status: 200, body: "3" });
      await manager.stopChannel("discord");
      expect(await read()).toMatchObject({ status: 404 });
      await manager.startChannels();
      expect(await read()).toMatchObject({ status: 200, body: "4" });
      await manager.stopChannel("discord", undefined, { manual: false, routeHandoff: true });
      expect(await read()).toMatchObject({ status: 503, retryAfter: "1" });
      manager.pruneInactiveChannelAccountState(new Set());
      expect(await read()).toMatchObject({ status: 404 });
    } finally {
      replacement.resolve();
      await manager.stopChannel("discord");
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects late startup registration while the next ingress handoff remains parked", async () => {
    const pending = createDeferred();
    const lateAttempt = createDeferred<string>();
    let starts = 0;
    const registry = installTestRegistry(
      createTestPlugin({
        startAccount: async ({ abortSignal }) => {
          const generation = ++starts;
          if (generation === 2) {
            await pending.promise;
          }
          try {
            registerPluginHttpRoute({
              path: "/plugins/late-reload",
              auth: "plugin",
              pluginId: "discord",
              handler: vi.fn(),
              throwOnFailure: true,
            });
            if (generation === 2) {
              lateAttempt.resolve("registered after retirement");
              return;
            }
            await waitForAbort(abortSignal);
          } catch (error) {
            lateAttempt.resolve(String(error));
          }
        },
      }),
    );
    const manager = createManager({ getPluginRegistry: () => registry });
    await manager.startChannels();
    await manager.stopChannel("discord", undefined, { manual: false, routeHandoff: true });
    await manager.startChannels();
    const stop = manager.stopChannel("discord", undefined, { manual: false, routeHandoff: true });
    await vi.advanceTimersByTimeAsync(5_000);
    await stop;
    pending.resolve();
    expect(await lateAttempt.promise).toContain("lease is no longer active");
    await flushMicrotasks();
    expect(registry.httpRoutes.map((route) => route.handoff)).toEqual([true]);
  });

  it.each(["removed", "disabled", "resolved-disabled", "manual"] as const)(
    "removes %s ingress while its timed-out predecessor still needs cleanup",
    async (action) => {
      const pending = createDeferred();
      let disabled = false;
      const registry = installTestRegistry(
        createTestPlugin({
          resolveAccount: () => ({ enabled: action !== "resolved-disabled" || !disabled }),
          startAccount: async () => {
            registerPluginHttpRoute({
              path: "/plugins/removed-reload",
              auth: "plugin",
              pluginId: "discord",
              handler: vi.fn(),
              throwOnFailure: true,
            });
            await pending.promise;
          },
        }),
      );
      const manager = createManager({
        getPluginRegistry: () => registry,
        getRuntimeConfig: () => ({
          channels: { discord: { enabled: action === "resolved-disabled" || !disabled } },
        }),
      });
      try {
        await manager.startChannels();
        if (action === "manual") {
          const stop = manager.stopChannel("discord");
          await vi.advanceTimersByTimeAsync(5_000);
          await stop;
        }
        const stop = manager.stopChannel("discord", undefined, {
          manual: false,
          routeHandoff: true,
        });
        await vi.advanceTimersByTimeAsync(5_000);
        await stop;
        if (action !== "manual") {
          expect(registry.httpRoutes.map((route) => route.handoff)).toEqual([true]);
        }
        if (action === "manual") {
          await manager.startChannel("discord", undefined, { preserveManualStop: true });
        } else if (action === "resolved-disabled") {
          disabled = true;
          pending.resolve();
          await flushMicrotasks(30);
          expect(await manager.startChannel("discord")).toEqual(
            new Map([[DEFAULT_ACCOUNT_ID, { status: "skipped", reason: "disabled" }]]),
          );
        } else if (action === "disabled") {
          disabled = true;
          await manager.startChannels();
        } else {
          manager.pruneInactiveChannelAccountState(new Set());
        }
        expect(registry.httpRoutes).toEqual([]);
      } finally {
        pending.resolve();
        await flushMicrotasks();
      }
    },
  );

  it("scopes stop routes to their Gateway and releases them when teardown rejects", async () => {
    const routeRegistry = createEmptyPluginRegistry();
    const stopStarted = createDeferred();
    const releaseStop = createDeferred();
    const failure = new Error("stop failed");
    let unregister: (() => void) | undefined;
    const registry = installTestRegistry(
      createTestPlugin({
        startAccount: async ({ abortSignal }) => await waitForAbort(abortSignal),
        stopAccount: async () => {
          unregister = registerPluginHttpRoute({
            path: "/plugins/stopping",
            auth: "plugin",
            handler: vi.fn(),
            throwOnFailure: true,
          });
          stopStarted.resolve();
          await releaseStop.promise;
          throw failure;
        },
      }),
    );
    routeRegistry.channels = registry.channels;
    const manager = createManager({ getPluginRegistry: () => routeRegistry });
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    const stopping = manager
      .stopChannel("discord", DEFAULT_ACCOUNT_ID)
      .catch((error: unknown) => error);
    try {
      await stopStarted.promise;
      expect(routeRegistry.httpRoutes.map((route) => route.path)).toEqual(["/plugins/stopping"]);
      expect(registry.httpRoutes).toHaveLength(0);
      releaseStop.resolve();
      expect(await stopping).toBe(failure);
      expect(routeRegistry.httpRoutes).toHaveLength(0);
    } finally {
      releaseStop.resolve();
      await stopping;
      unregister?.();
    }
  });

  it.each([
    { abandonedHook: "start", replacementFails: false },
    { abandonedHook: "stop", replacementFails: true },
  ])(
    "preserves HTTP recovery after an abandoned $abandonedHook resumes (replacementFails=$replacementFails)",
    async ({ abandonedHook, replacementFails }) => {
      const releaseAbandoned = createDeferred();
      const abandonedStarted = createDeferred();
      const lateErrors: unknown[] = [];
      let abandonedTask: Promise<void> | undefined;
      let unregisterAbandoned: (() => void) | undefined;
      let unregisterLate: (() => void) | undefined;
      const route = {
        path: "/plugins/discord",
        auth: "plugin" as const,
        pluginId: "discord",
        source: "account-route",
        throwOnFailure: true,
      };
      const routeHandlers = ["abandoned", "replacement", "resumed-abandoned"].map((body) =>
        vi.fn((_req: IncomingMessage, res: ServerResponse) => {
          res.statusCode = 200;
          res.end(body);
          return true;
        }),
      );
      const runAbandonedCallback = () => {
        abandonedTask = (async () => {
          abandonedStarted.resolve();
          await releaseAbandoned.promise;
          try {
            unregisterLate = registerPluginHttpRoute({
              ...route,
              registry,
              replaceExisting: true,
              handler: routeHandlers[2]!,
            });
          } catch (error) {
            lateErrors.push(error);
          } finally {
            unregisterAbandoned?.();
          }
        })();
        return abandonedTask;
      };
      let startCount = 0;
      const startAccount = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
        const first = startCount++ === 0;
        const unregister = registerPluginHttpRoute({
          ...route,
          handler: routeHandlers[first ? 0 : 1]!,
        });
        if (first) {
          unregisterAbandoned = unregister;
          if (abandonedHook === "start") {
            await runAbandonedCallback();
            return;
          }
        }
        try {
          await waitForAbort(abortSignal);
        } finally {
          unregister();
        }
      });
      let stopCount = 0;
      const stopAccount = vi.fn(async () => {
        if (++stopCount === 1 && abandonedHook === "stop") {
          await runAbandonedCallback();
        }
      });
      const replacementError = new Error("replacement preflight failed");
      let preflightCount = 0;
      const isConfigured = vi.fn(async () => {
        if (++preflightCount > 1 && replacementFails) {
          throw replacementError;
        }
        return true;
      });
      const registry = installTestRegistry(
        createTestPlugin({ startAccount, stopAccount, isConfigured }),
      );
      const manager = createManager({ getPluginRegistry: () => registry });
      const server = createTestGatewayServer({
        resolvedAuth: AUTH_NONE,
        overrides: {
          handlePluginRequest: createGatewayPluginRequestHandler({
            registry,
            log: createSubsystemLogger("gateway/server-channels-route-test"),
          }),
        },
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected Gateway HTTP server to listen on a TCP port");
      }
      const readIngress = async () => {
        const response = await fetch(`http://127.0.0.1:${address.port}/plugins/discord`);
        return { status: response.status, body: await response.text() };
      };

      try {
        await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
        expect(await readIngress()).toEqual({ status: 200, body: "abandoned" });
        const stopping = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, {
          manual: false,
          routeHandoff: abandonedHook === "stop",
        });
        await abandonedStarted.promise;
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(5_000);
        await stopping;

        if (abandonedHook === "start") {
          await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
          expect(startAccount).toHaveBeenCalledTimes(1);
          expect(registry.httpRoutes[0]?.handler).toBe(routeHandlers[0]);
        }
        if (replacementFails) {
          await expect(manager.startChannel("discord", DEFAULT_ACCOUNT_ID)).rejects.toBe(
            replacementError,
          );
        } else {
          await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
        }
        const expectedIngress = {
          status: replacementFails ? 404 : 200,
          body: replacementFails ? expect.any(String) : "replacement",
        };
        expect(await readIngress()).toEqual(expectedIngress);

        releaseAbandoned.resolve();
        await abandonedTask;
        await flushMicrotasks();
        expect(await readIngress()).toEqual(expectedIngress);
        expect(lateErrors).toHaveLength(1);
        expect(lateErrors[0]).toMatchObject({
          message: "plugin runtime HTTP route lease is no longer active",
        });
        expect(startAccount).toHaveBeenCalledTimes(replacementFails ? 1 : 2);
        expect(readAccount(manager)).toMatchObject({
          running: !replacementFails,
          lastError: replacementFails ? replacementError.message : null,
        });
      } finally {
        releaseAbandoned.resolve();
        await abandonedTask;
        unregisterLate?.();
        await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      expect(registry.httpRoutes).toHaveLength(0);
    },
  );

  it("keeps the second recovery task running when the stale task rejects", async () => {
    const releaseFirstTask = createDeferred();
    let startCount = 0;
    const startAccount = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      startCount += 1;
      abortSignal.addEventListener("abort", () => {}, { once: true });
      if (startCount === 1) {
        await releaseFirstTask.promise;
        throw new Error("late stale worker exit");
      }
      await new Promise<void>(() => {});
    });
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    const recoveryStopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, {
      manual: false,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await recoveryStopTask;

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(startAccount).toHaveBeenCalledTimes(2);

    releaseFirstTask.resolve();
    await flushMicrotasks();

    const account = readAccount(manager);
    expect(startAccount).toHaveBeenCalledTimes(2);
    expect(account?.running).toBe(true);
    expect(account?.restartPending).toBe(false);
    expect(account?.lastError).toBeNull();
    expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();
  });

  it("waits for an explicit start after recovery stop timeout", async () => {
    const releaseFirstTask = createDeferred();
    let startCount = 0;
    const startAccount = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      startCount += 1;
      abortSignal.addEventListener("abort", () => {}, { once: true });
      if (startCount === 1) {
        await releaseFirstTask.promise;
        return;
      }
      await new Promise<void>(() => {});
    });
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    const recoveryStopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, {
      manual: false,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await recoveryStopTask;

    releaseFirstTask.resolve();
    await waitForMicrotaskCondition(() => {
      const account = readAccount(manager);
      return account?.running === false && account.restartPending === false;
    }, "expected timed-out recovery stop to settle without restarting");

    const account = readAccount(manager);
    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(account?.running).toBe(false);
    expect(account?.restartPending).toBe(false);
    expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    await waitForMicrotaskCondition(
      () => startAccount.mock.calls.length === 2,
      "expected explicit post-timeout start to restart the channel",
    );

    expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();
  });

  it("consumes startup failures during immediate recovery restart", async () => {
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);
    try {
      const releaseFirstTask = createDeferred();
      let isConfiguredCalls = 0;
      const startAccount = vi.fn(
        async ({ abortSignal }: { abortSignal: AbortSignal }) =>
          await new Promise<void>((resolve) => {
            abortSignal.addEventListener("abort", () => {}, { once: true });
            void releaseFirstTask.promise.then(resolve);
          }),
      );
      installTestRegistry(
        createTestPlugin({
          startAccount,
          isConfigured: () => {
            isConfiguredCalls += 1;
            if (isConfiguredCalls > 1) {
              throw new Error("restart config missing");
            }
            return true;
          },
        }),
      );
      const manager = createManager();

      await manager.startChannels();
      const recoveryStopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, {
        manual: false,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await recoveryStopTask;

      await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
      releaseFirstTask.resolve();
      await waitForMicrotaskCondition(
        () => readAccount(manager)?.lastError === "restart config missing",
        "expected immediate recovery restart failure to be recorded",
      );
      await flushMicrotasks();

      const account = readAccount(manager);
      expect(startAccount).toHaveBeenCalledTimes(1);
      expect(account?.running).toBe(false);
      expect(account?.restartPending).toBe(false);
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
    }
  });

  it("lets manual stops cancel recovery restart after recovery stop times out", async () => {
    const releaseFirstTask = createDeferred();
    const startAccount = vi.fn(
      async ({ abortSignal }: { abortSignal: AbortSignal }) =>
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => {}, { once: true });
          void releaseFirstTask.promise.then(resolve);
        }),
    );
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    const recoveryStopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, {
      manual: false,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await recoveryStopTask;

    const manualStopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await vi.advanceTimersByTimeAsync(5_000);
    await manualStopTask;
    releaseFirstTask.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();

    const account = readAccount(manager);
    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(account?.running).toBe(false);
    expect(account?.restartPending).toBe(false);
    expect(manager.isManuallyStopped("discord", DEFAULT_ACCOUNT_ID)).toBe(true);
    expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    await waitForMicrotaskCondition(
      () => hoisted.sleepWithAbort.mock.calls.length === 1,
      "expected later ordinary exit to use restart backoff",
    );

    expect(startAccount).toHaveBeenCalledTimes(2);
    expect(hoisted.sleepWithAbort.mock.calls[0]?.[0]).toBe(10);
  });

  it("lets explicit starts win after a manual timeout during recovery stop", async () => {
    const releaseFirstTask = createDeferred();
    let startCount = 0;
    const startAccount = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      startCount += 1;
      abortSignal.addEventListener("abort", () => {}, { once: true });
      if (startCount === 1) {
        await releaseFirstTask.promise;
        return;
      }
      await new Promise<void>(() => {});
    });
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    const recoveryStopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, {
      manual: false,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await recoveryStopTask;

    const manualStopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await vi.advanceTimersByTimeAsync(5_000);
    await manualStopTask;
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(startAccount).toHaveBeenCalledOnce();
    releaseFirstTask.resolve();
    await waitForMicrotaskCondition(
      () => startAccount.mock.calls.length === 2,
      "expected explicit start to clear manual stop and restart after old task exits",
    );

    const account = readAccount(manager);
    expect(account?.running).toBe(true);
    expect(account?.restartPending).toBe(false);
    expect(manager.isManuallyStopped("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
    expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();
  });

  it("preserves runtime linkage when the plugin has no link resolver", async () => {
    const account = { enabled: true, configured: true };
    const startAccount = vi.fn(stayRunning);
    const plugin = createTestPlugin({ account, startAccount });
    plugin.status = {
      defaultRuntime: {
        accountId: DEFAULT_ACCOUNT_ID,
        linked: true,
        running: false,
        lastError: null,
      },
    };
    installTestRegistry(plugin);
    const manager = createManager();

    await manager.startChannel("discord");

    expect(readAccount(manager)?.linked).toBe(true);
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    manager.markChannelLoggedOut("discord", true);
    expect(readAccount(manager)).toMatchObject({
      linked: false,
      running: false,
      lifecycle: "stopped",
      lastError: "logged out",
    });
    account.enabled = false;
    await manager.startChannel("discord");
    expect(readAccount(manager)?.linked).toBe(false);

    account.enabled = true;
    await manager.startChannel("discord");
    expect(startAccount).toHaveBeenCalledOnce();
    expect(readAccount(manager)?.linked).toBe(false);
  });

  it("applies described config fields into runtime snapshots", () => {
    installTestRegistry(
      createTestPlugin({
        describeAccount: (resolved) => ({
          accountId: DEFAULT_ACCOUNT_ID,
          enabled: resolved.enabled !== false,
          configured: false,
          mode: "webhook",
        }),
      }),
    );
    const manager = createManager();
    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.configured).toBe(false);
    expect(account?.mode).toBe("webhook");
  });

  it("cannot retain an unlinked explanation after a successful linked start", async () => {
    let linkState: ChannelAccountLinkState = "not-linked";
    const startAccount = vi.fn(stayRunning);
    installTestRegistry(
      createTestPlugin({
        id: "whatsapp",
        startAccount,
        isConfigured: () => true,
        isLinked: () => linkState,
        unlinkedReason: () => "not authenticated",
      }),
    );
    const manager = createManager({ channelIds: ["whatsapp"] });

    await manager.startChannel("whatsapp");
    const unlinkedAccount = manager.getRuntimeSnapshot().channelAccounts.whatsapp?.default;
    expect(unlinkedAccount).toMatchObject({
      configured: true,
      linked: false,
      running: false,
      stateReason: "not authenticated",
      lastError: null,
    });
    expect(
      formatGatewayChannelsStatusLines({
        channelAccounts: { whatsapp: unlinkedAccount ? [unlinkedAccount] : [] },
      }).join("\n"),
    ).toContain("reason:not authenticated");

    linkState = "linked";
    await manager.startChannel("whatsapp");
    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.whatsapp?.default;
    const output = formatGatewayChannelsStatusLines({
      channelAccounts: { whatsapp: account ? [account] : [] },
    }).join("\n");
    expect(startAccount).toHaveBeenCalledOnce();
    expect(account).toMatchObject({
      configured: true,
      linked: true,
      running: true,
      lastError: null,
    });
    expect(account).not.toHaveProperty("stateReason");
    expect(output).toContain("configured, linked, running");
    expect(output).not.toContain("error:not linked");
  });

  it("keeps configured true when the linkage read is indeterminate", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(
      createTestPlugin({
        id: "whatsapp",
        startAccount,
        isConfigured: () => true,
        isLinked: () => "unknown",
        describeAccount: () => ({
          accountId: DEFAULT_ACCOUNT_ID,
          configured: true,
          linked: false,
        }),
      }),
    );
    const manager = createManager({ channelIds: ["whatsapp"] });

    await manager.startChannel("whatsapp");

    expect(startAccount).not.toHaveBeenCalled();
    expect(manager.getRuntimeSnapshot().channelAccounts.whatsapp?.default).toMatchObject({
      configured: true,
      running: false,
      lastError: null,
    });
    expect(manager.getRuntimeSnapshot().channelAccounts.whatsapp?.default).not.toHaveProperty(
      "linked",
    );
  });

  it("creates formatted runtime and log sinks for channels loaded after manager construction", async () => {
    const startAccount = vi.fn(async (_ctx: ChannelGatewayContext<TestAccount>) => {});
    installTestRegistry(createTestPlugin({ id: "slack", startAccount }));
    const channelLogs = {} as Record<ChannelId, SubsystemLogger>;
    const channelRuntimeEnvs = {} as Record<ChannelId, RuntimeEnv>;
    const manager = createChannelManager({
      scheduler: createTestGatewayScheduler(),
      getRuntimeConfig: () => ({}),
      getPluginRegistry: requireActivePluginChannelRegistry,
      channelLogs,
      channelRuntimeEnvs,
    });

    await manager.startChannel("slack");

    expect(startAccount).toHaveBeenCalledTimes(1);
    const ctx = firstStartAccountContext(startAccount);
    expect(ctx?.log).toBe(channelLogs.slack);
    expect(ctx?.runtime).toBe(channelRuntimeEnvs.slack);
    expect((ctx?.log as SubsystemLogger | undefined)?.subsystem).toBe("channels/slack");
  });

  it("recovers suppressed autostart without undoing manual stops", async () => {
    const startAccount = vi.fn(stayRunning);
    installTestRegistry(
      createTestPlugin({
        startAccount,
        listAccountIds: () => [DEFAULT_ACCOUNT_ID, "work"],
      }),
    );
    const tryRecover = vi.fn(() => true);
    const manager = createManager({
      tryRecoverAutostartSuppression: tryRecover,
      getRuntimeConfig: () => ({
        channels: { discord: { healthMonitor: { enabled: false } } },
      }),
    });
    manager.setAutostartSuppression({
      reason: "crash-loop-breaker",
      message: "safe mode",
    });

    await manager.startChannels();
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { manual: true });
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await manager.recoverAutostartSuppression();
    await flushMicrotasks();

    expect(tryRecover).toHaveBeenCalledOnce();
    expect(manager.getAutostartSuppression()).toBeNull();
    expect(startAccount.mock.calls.map(([ctx]) => ctx.accountId)).toEqual([
      DEFAULT_ACCOUNT_ID,
      "work",
    ]);
    expect(manager.isHealthMonitorEnabled("discord", "work")).toBe(false);
    expect(manager.isManuallyStopped("discord", DEFAULT_ACCOUNT_ID)).toBe(true);
  });

  it("does not start recovered accounts after gateway close begins during handoff", async () => {
    const accountStartReady = createDeferred();
    const startAccount = vi.fn(async () => {});
    let closing = false;
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({
      deferStartupAccountStartsUntil: accountStartReady.promise,
      isClosing: () => closing,
      tryRecoverAutostartSuppression: () => true,
    });
    manager.setAutostartSuppression({
      reason: "crash-loop-breaker",
      message: "safe mode",
    });

    const recovery = manager.recoverAutostartSuppression();
    await flushMicrotasks();
    closing = true;
    accountStartReady.resolve();
    await recovery;
    await flushMicrotasks();

    expect(manager.getAutostartSuppression()).toBeNull();
    expect(startAccount).not.toHaveBeenCalled();
  });

  it("keeps suppression when persisted recovery is not proven", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({ tryRecoverAutostartSuppression: () => false });
    manager.setAutostartSuppression({
      reason: "crash-loop-breaker",
      message: "safe mode",
    });

    await expect(manager.recoverAutostartSuppression()).resolves.toBe(false);

    expect(manager.getAutostartSuppression()?.reason).toBe("crash-loop-breaker");
    expect(startAccount).not.toHaveBeenCalled();
  });

  it("suppresses ambient channel autostart while allowing manual starts", async () => {
    const startAccount = vi.fn(async (_ctx: ChannelGatewayContext<TestAccount>) => {});
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({
      ambientAutostartSuppressedChannelIds: new Set(["discord"]),
    });

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(startAccount).not.toHaveBeenCalled();
    expect(readAccount(manager)?.lastError).toBe(
      "ambient channel credentials suppressed; configure the channel or start the gateway with --ambient-channels",
    );

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { manual: true });
    await flushMicrotasks();

    expect(startAccount).toHaveBeenCalledTimes(1);
  });

  it("preserves a failed replacement pause across cancelled retries until publication", async () => {
    const startAccount = vi.fn(stayRunning);
    const plugin = createTestPlugin({ startAccount });
    const inspection = { name: "captured account" };
    const inspectAccount = vi.fn(() => inspection);
    plugin.config.inspectAccount = inspectAccount;
    let registry = installTestRegistry(plugin);
    const manager = createManager({ getPluginRegistry: () => registry });
    const firstPause = manager.pauseChannelStarts(["discord"]);
    firstPause("rollback");
    await manager.startChannel("discord", "default");
    await waitForImmediate();
    expect(startAccount).toHaveBeenCalledOnce();
    const failedPause = manager.pauseChannelStarts(["discord"]);
    inspection.name = "edited after pause";
    inspectAccount.mockImplementation(() => {
      throw new Error("paused plugin must not be inspected");
    });
    const cancelledRetry = manager.pauseChannelStarts(["discord"]);
    cancelledRetry("rollback");
    const context = firstStartAccountContext(startAccount);
    context.setStatus({ accountId: "default", enabled: false, configured: false });
    const disabled = manager.getRuntimeSnapshot();
    expect(disabled.reloadingChannels?.has("discord")).toBe(true);
    expect(disabled.channelAccounts.discord?.default).toMatchObject({
      name: "captured account",
      enabled: false,
      configured: false,
      running: false,
      stateReason: "disabled",
    });
    context.setStatus({ accountId: "default", enabled: true, configured: true });
    await manager.stopChannel("discord", "default");
    expect(readAccount(manager)).toMatchObject({
      name: "captured account",
      enabled: true,
      configured: true,
      running: false,
      lifecycle: "stopped",
    });
    await expect(manager.startChannel("discord", "default")).rejects.toThrow(
      "plugins are reloading; retry",
    );
    const publishedRetry = manager.pauseChannelStarts(["discord"]);
    registry = installTestRegistry(createTestPlugin({ startAccount }));
    publishedRetry("published");
    // Late settlement cannot reinstate an old pause or release a newer one.
    publishedRetry("rollback");
    cancelledRetry("rollback");
    await manager.startChannel("discord", "default");
    await waitForImmediate();
    expect(startAccount).toHaveBeenCalledTimes(2);
    const latestPause = manager.pauseChannelStarts(["discord"]);
    failedPause("published");
    await expect(manager.startChannel("discord", "default")).rejects.toThrow(
      "plugins are reloading; retry",
    );
    latestPause("rollback");
  });

  it.each(["list-accounts", "runtime"] as const)(
    "preserves pending-start ownership across %s replacement",
    async (phase) => {
      const preparing = createDeferred();
      const release = createDeferred();
      const cleanupStarted = createDeferred();
      const releaseCleanup = createDeferred();
      if (phase === "runtime") {
        hoisted.startChannelApprovalHandlerBootstrap.mockResolvedValueOnce(async () => {
          cleanupStarted.resolve();
          await releaseCleanup.promise;
        });
      }
      const originalStart = vi.fn(async ({ abortSignal }: ChannelGatewayContext<TestAccount>) => {
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      });
      const replacementStart = vi.fn(stayRunning);
      const originalPlugin = createTestPlugin({ startAccount: originalStart });
      let registry = installTestRegistry(
        originalPlugin,
        createTestPlugin({ id: "slack", startAccount: replacementStart }),
      );
      const manager = createManager({
        channelIds: ["discord", "slack"],
        getPluginRegistry: () => registry,
        startupTrace: {
          measure: async (name, run) => {
            const result = await run();
            if (name === `channels.discord.${phase}`) {
              preparing.resolve();
              await release.promise;
            }
            return result;
          },
        },
      });
      const original = manager.startChannel("discord");
      const completion = original.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      let replacements: Array<ReturnType<ChannelManager["startChannel"]>> = [];
      await preparing.promise;
      const target = "discord";
      const resume = manager.pauseChannelStarts([target]);
      try {
        await expect(manager.startChannel(target, "default")).rejects.toThrow(
          "plugins are reloading; retry",
        );
        await manager.stopChannel("discord", undefined, { manual: false });
        registry = installTestRegistry(
          createTestPlugin({ startAccount: replacementStart }),
          createTestPlugin({ id: "slack", startAccount: replacementStart }),
        );
        resume("published");
        replacements = [
          manager.startChannel("discord", "default"),
          manager.startChannel("discord", "default"),
        ];
        await flushMicrotasks();
        release.resolve();
        if (phase === "runtime") {
          await cleanupStarted.promise;
          await waitForImmediate();
          expect(replacementStart).not.toHaveBeenCalled();
          releaseCleanup.resolve();
        }
        expect(await completion).toMatchObject({
          error: { message: expect.stringContaining("plugins are reloading; retry") },
        });
        const outcomes = await Promise.all(replacements);
        expect(outcomes.map((result) => result.get("default"))).toContainEqual({
          status: "handed-off",
        });
        await waitForImmediate();
        expect(originalStart).toHaveBeenCalledTimes(0);
        expect(replacementStart).toHaveBeenCalledTimes(1);
      } finally {
        resume("rollback");
        release.resolve();
        releaseCleanup.resolve();
        await Promise.allSettled([original, ...replacements]);
      }
    },
  );

  it.each(["resolve", "configured"] as const)(
    "preserves a manual stop during %s preparation with a queued start",
    async (phase) => {
      const preparing = createDeferred();
      const startupGate = createDeferred();
      const prepare = async () => {
        preparing.resolve();
        await startupGate.promise;
        return true;
      };
      const startAccount = vi.fn(stayRunning);
      const plugin = createTestPlugin({ startAccount });
      if (phase === "resolve") {
        plugin.config.resolveAccountAsync = async () => {
          await prepare();
          return { enabled: true, configured: true };
        };
      } else {
        plugin.config.isConfigured = prepare;
      }
      installTestRegistry(plugin);
      const manager = createManager();
      const starts = [manager.startChannel("discord", DEFAULT_ACCOUNT_ID)];
      await preparing.promise;
      starts.push(manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { manual: true }));
      await flushMicrotasks();
      await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
      startupGate.resolve();
      await Promise.all(starts);
      expect(startAccount).not.toHaveBeenCalled();
      expect(manager.isManuallyStopped("discord", DEFAULT_ACCOUNT_ID)).toBe(true);

      await manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { manual: true });
      await flushMicrotasks();
      expect(startAccount).toHaveBeenCalledOnce();
      expect(manager.isManuallyStopped("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
    },
  );

  it("passes the full runtime path to bundled channel startup", async () => {
    const fullRuntime = {
      ...createRuntimeChannel(),
      marker: "full-channel-runtime",
    } as PluginRuntime["channel"] & { marker: string };
    const resolveChannelRuntime = vi.fn(() => fullRuntime);
    const startAccount = vi.fn(async (_ctx: ChannelGatewayContext<TestAccount>) => {});

    installTestRegistry({
      plugin: createTestPlugin({ startAccount }),
      origin: "bundled",
    });
    const manager = createManager({ resolveChannelRuntime });
    manager.getRuntimeSnapshot();
    expect(resolveChannelRuntime).not.toHaveBeenCalled();

    await manager.startChannels();

    expect(resolveChannelRuntime).toHaveBeenCalledTimes(1);
    expect(startAccount).toHaveBeenCalledTimes(1);
    const ctx = firstStartAccountContext(startAccount);
    expect((ctx?.channelRuntime as { marker?: string } | undefined)?.marker).toBe(
      "full-channel-runtime",
    );
    expect(typeof (ctx?.channelRuntime as PluginRuntime["channel"] | undefined)?.inbound.run).toBe(
      "function",
    );
  });

  it("keeps the active registration runtime after an inactive prepared load", async () => {
    const activeRuntime = {
      ...createRuntimeChannel(),
      marker: "active-registration",
    } as PluginRuntime["channel"] & { marker: string };
    const inactivePreparedRuntime = {
      ...createRuntimeChannel(),
      marker: "inactive-prepared",
    } as PluginRuntime["channel"] & { marker: string };
    const resolveChannelRuntime = vi.fn(() => inactivePreparedRuntime);
    const startAccount = vi.fn(async (_ctx: ChannelGatewayContext<TestAccount>) => {});

    installTestRegistry({
      plugin: createTestPlugin({ startAccount }),
      origin: "bundled",
      resolveChannelRuntime: () => activeRuntime,
    });
    const manager = createManager({ resolveChannelRuntime });

    await manager.startChannels();

    expect(resolveChannelRuntime).not.toHaveBeenCalled();
    const ctx = firstStartAccountContext(startAccount);
    expect((ctx.channelRuntime as { marker?: string } | undefined)?.marker).toBe(
      "active-registration",
    );
    expect(ctx.channelRuntime).not.toBe(activeRuntime);
  });

  it("does not resolve channelRuntime for disabled accounts", async () => {
    const channelRuntime = createRuntimeChannel();
    const resolveChannelRuntime = vi.fn(() => channelRuntime);
    const startAccount = vi.fn(async (_ctx: ChannelGatewayContext<TestAccount>) => {});

    installTestRegistry(
      createTestPlugin({
        startAccount,
        account: { enabled: false, configured: true },
      }),
    );
    const manager = createManager({ resolveChannelRuntime });

    await manager.startChannels();

    expect(resolveChannelRuntime).not.toHaveBeenCalled();
    expect(startAccount).not.toHaveBeenCalled();
  });

  it("injects a narrow Gateway approval resolver into the channel task runtime", async () => {
    const request = vi.fn(async () => ({ applied: true, approval: {} }));
    const { promise: accountStartReady, resolve: releaseAccountStart } = createDeferred();
    const nativeApprovalRuntime = {
      current: undefined as GatewayNativeApprovalRuntime | undefined,
    };
    let observerCount: number | undefined;
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      observerCount = getEventListeners(ctx.abortSignal, "abort").length;
      const stopped = waitForAbort(ctx.abortSignal);
      const approvalRuntime =
        ctx.channelRuntime?.runtimeContexts.get<ApprovalGatewayRequestRuntime>({
          channelId: "discord",
          accountId: DEFAULT_ACCOUNT_ID,
          capability: CHANNEL_APPROVAL_GATEWAY_RUNTIME_CONTEXT_CAPABILITY,
        });
      await approvalRuntime?.request(
        "approval.resolve",
        { id: "approval-1", kind: "exec", decision: "deny" },
        { clientDisplayName: "Discord approval" },
      );
      await expect(approvalRuntime?.request("config.get" as never, {})).rejects.toThrow(
        "channel approval runtime cannot dispatch config.get",
      );
      await stopped;
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({
      channelRuntime: createRuntimeChannel(),
      deferStartupAccountStartsUntil: accountStartReady,
      getNativeApprovalRuntime: () => nativeApprovalRuntime.current,
    });

    await manager.startChannels();
    expect(startAccount).not.toHaveBeenCalled();
    nativeApprovalRuntime.current = { request } as unknown as GatewayNativeApprovalRuntime;
    releaseAccountStart();
    await flushMicrotasks();

    // Scheduler retirement and approval disposal remain; the deferred-start waiter is gone.
    expect(observerCount).toBe(2);
    expect(request).toHaveBeenCalledWith(
      "approval.resolve",
      { id: "approval-1", kind: "exec", decision: "deny" },
      { clientDisplayName: "Discord approval" },
    );
    const context = startAccount.mock.calls[0]?.[0];
    if (!context) {
      throw new Error("Expected the approval account to start");
    }
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(getEventListeners(context.abortSignal, "abort")).toHaveLength(0);
  });

  it("keeps auto-restart running when scoped runtime cleanup throws", async () => {
    const baseChannelRuntime = createRuntimeChannel();
    const channelRuntime: PluginRuntime["channel"] = {
      ...baseChannelRuntime,
      runtimeContexts: {
        ...baseChannelRuntime.runtimeContexts,
        register: () => ({
          dispose: () => {
            throw new Error("cleanup boom");
          },
        }),
      },
    };
    const startAccount = vi.fn(
      async ({ channelRuntime: channelRuntimeLocal }: ChannelGatewayContext<TestAccount>) => {
        channelRuntimeLocal?.runtimeContexts.register({
          channelId: "discord",
          accountId: DEFAULT_ACCOUNT_ID,
          capability: "approval.native",
          context: { token: "tracked" },
        });
      },
    );

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({ channelRuntime });

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(30);

    expect(startAccount.mock.calls.length).toBeGreaterThan(1);
  });

  it("reports recorded status without operational preparation for async account plugins", async () => {
    const refuseSync = () => {
      throw new Error("diagnostics must not resolve operational account state");
    };
    const resolveAccountAsync = vi.fn(async () => ({ enabled: true, configured: true }));
    const plugin = createTestPlugin({
      resolveAccount: refuseSync,
      startAccount: async ({ abortSignal, setStatus }) => {
        setStatus(channelReadyPatch({ accountId: DEFAULT_ACCOUNT_ID }));
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });
    plugin.config.resolveAccountAsync = resolveAccountAsync;
    installTestRegistry(plugin);
    const manager = createManager();
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    await waitForImmediate();
    resolveAccountAsync.mockClear();

    expect(readAccount(manager)).toMatchObject({
      configured: true,
      running: true,
      lifecycle: "ready",
    });
    expect(resolveAccountAsync).not.toHaveBeenCalled();
  });

  it("keeps an explicitly admitted account visible when plugin enumeration omits it", async () => {
    const admitted = new Map<string, ChannelGatewayContext<TestAccount>>();
    const listAccountIds = vi.fn<() => string[]>(() => []);
    const describeAccount = vi.fn(() => ({
      accountId: "recovered",
      enabled: true,
      configured: false,
    }));
    const startAccount = vi.fn(async (context: ChannelGatewayContext<TestAccount>) => {
      admitted.set(context.accountId, context);
      await waitForAbort(context.abortSignal);
    });
    const plugin = createTestPlugin({
      listAccountIds,
      resolveAccount: () => ({ enabled: true, configured: true }),
      describeAccount,
      startAccount,
    });
    installTestRegistry(plugin);
    const manager = createManager();

    await expect(manager.startChannel("discord", "recovered")).resolves.toEqual(
      new Map([["recovered", { status: "handed-off" }]]),
    );
    expect(describeAccount).toHaveBeenCalledOnce();
    describeAccount.mockClear();

    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.recovered).toMatchObject({
      accountId: "recovered",
      enabled: true,
      configured: true,
      running: true,
      lifecycle: "starting",
    });
    expect(describeAccount).not.toHaveBeenCalled();
    expect(manager.getRuntimeSnapshot().channels.discord?.accountId).toBe(DEFAULT_ACCOUNT_ID);

    listAccountIds.mockReturnValue(["listed"]);
    const releasePause = manager.pauseChannelStarts(["discord"]);
    listAccountIds.mockImplementation(() => {
      throw new Error("paused account enumeration must not run");
    });
    listAccountIds.mockClear();
    try {
      expect(manager.isAccountListed("discord", "listed")).toBe(true);
      expect(manager.isAccountListed("discord", "recovered")).toBe(false);
      expect(manager.getRuntimeSnapshot().channelAccounts.discord?.recovered).toMatchObject({
        accountId: "recovered",
        configured: true,
        running: true,
      });
      expect(listAccountIds).not.toHaveBeenCalled();
    } finally {
      listAccountIds.mockReturnValue([]);
      releasePause("rollback");
    }

    await manager.startChannel("discord", "sibling");
    await manager.stopChannel("discord", "recovered");

    expect(admitted.get("recovered")?.abortSignal.aborted).toBe(true);
    expect(admitted.get("sibling")?.abortSignal.aborted).toBe(false);
    expect(manager.getRuntimeSnapshot().channelAccounts.discord).toMatchObject({
      sibling: { accountId: "sibling", enabled: true, configured: true, running: true },
    });
    expect(manager.getRuntimeSnapshot().channelAccounts.discord).not.toHaveProperty("recovered");
    expect(manager.getRuntimeSnapshot().channels.discord?.accountId).toBe(DEFAULT_ACCOUNT_ID);
  });

  it.each(["channel", "account"] as const)(
    "inspects and skips accounts disabled at %s scope without resolving inactive credentials",
    async (scope) => {
      const resolveAccount = vi.fn((_cfg: OpenClawConfig, accountId?: string | null) => {
        if (accountId === "missing") {
          throw new Error("unknown account");
        }
        throw new Error("inactive credential must not resolve");
      });
      const describeAccount = vi.fn(() => {
        throw new Error("runtime descriptor must not receive an inspection");
      });
      const startAccount = vi.fn(async () => {});
      const plugin = createTestPlugin({ resolveAccount, describeAccount, startAccount });
      plugin.config.inspectAccount = () => ({
        enabled: false,
        configured: true,
        tokenStatus: "configured_unavailable",
        name: "Disabled account",
        mode: "webhook",
      });
      installTestRegistry(plugin);
      const manager = createManager({
        getRuntimeConfig: () => ({
          channels: {
            discord:
              scope === "channel"
                ? { enabled: false }
                : { accounts: { default: { enabled: false } } },
          },
        }),
      });

      expect(readAccount(manager)).toMatchObject({
        accountId: "default",
        name: "Disabled account",
        mode: "webhook",
        enabled: false,
        configured: true,
        running: false,
        tokenStatus: "configured_unavailable",
        stateReason: "disabled",
      });
      await expect(
        manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { manual: true }),
      ).resolves.toEqual(
        new Map([[DEFAULT_ACCOUNT_ID, { status: "skipped", reason: "disabled" }]]),
      );
      expect(startAccount).not.toHaveBeenCalled();
      expect(resolveAccount).not.toHaveBeenCalled();
      expect(describeAccount).not.toHaveBeenCalled();
      await expect(manager.startChannel("discord", "missing", { manual: true })).rejects.toThrow(
        "unknown account",
      );
      expect(resolveAccount).toHaveBeenCalledExactlyOnceWith(expect.anything(), "missing");
    },
  );

  it("keeps only the degraded channel account cold", async () => {
    const discordStart = vi.fn(async (_context: ChannelGatewayContext<TestAccount>) => {});
    const slackStart = vi.fn(async () => {});
    const discordResolve = vi.fn((_cfg: OpenClawConfig, accountId?: string | null) => {
      if (accountId === "broken") {
        throw new Error("unresolved operational credential");
      }
      return { enabled: true, configured: true };
    });
    installTestRegistry(
      createTestPlugin({
        id: "discord",
        order: 1,
        listAccountIds: () => ["broken", "healthy"],
        resolveAccount: discordResolve,
        startAccount: discordStart,
      }),
      createTestPlugin({ id: "slack", order: 2, startAccount: slackStart }),
    );
    setActiveDegradedSecretOwners([
      {
        ownerKind: "account",
        ownerId: "discord:broken",
        state: "unavailable",
        paths: ["channels.discord.accounts.broken.token"],
        refKeys: ["env:default:BROKEN_TOKEN"],
        reason: "secret reference was not found",
      },
    ]);
    const manager = createManager({ channelIds: ["discord", "slack"] });

    await expect(manager.startChannels()).resolves.toBeUndefined();

    expect(discordStart.mock.calls.map(([context]) => context.accountId)).toEqual(["healthy"]);
    expect(discordResolve).toHaveBeenCalledOnce();
    expect(discordResolve).toHaveBeenCalledWith(expect.anything(), "healthy");
    expect(slackStart).toHaveBeenCalledTimes(1);
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.broken).toMatchObject({
      enabled: true,
      configured: true,
      running: false,
      lifecycle: "blocked",
      lastError:
        "Secret owner account:discord:broken is configured but unavailable (secret reference was not found).",
    });
    expect(discordResolve).not.toHaveBeenCalledWith(expect.anything(), "broken");
    await expect(manager.startChannel("discord", "broken", { manual: true })).rejects.toThrow(
      "Secret owner account:discord:broken is configured but unavailable",
    );
  });

  it("reinspects file credentials despite skip-unavailable and recovers only their account", async () => {
    const credentialPath = path.join(channelTempDirs.make("openclaw-channel-credential-"), "token");
    const credentialConfigPath = "channels.telegram.accounts.broken.tokenFile";
    const startAccount = vi.fn(stayRunning);
    installTestRegistry(
      createTestPlugin({
        id: "telegram",
        listAccountIds: () => ["broken", "healthy"],
        resolveAccount: (_cfg, accountId) => {
          const credential =
            accountId === "broken"
              ? tryReadSecretFileSync(
                  credentialPath,
                  "Telegram bot token",
                  {},
                  {
                    configPath: credentialConfigPath,
                  },
                )
              : { status: "available" as const, value: "healthy-token" };
          return {
            enabled: true,
            configured: true,
            ...(credential.status === "configured_unavailable"
              ? { credentialDiagnostics: [credential.diagnostic] }
              : {}),
          };
        },
        startAccount,
      }),
    );
    const manager = createManager({ channelIds: ["telegram"] });

    await expect(manager.startChannels()).resolves.toBeUndefined();

    expect(startAccount.mock.calls.map(([context]) => context.accountId)).toEqual(["healthy"]);
    expect(manager.getRuntimeSnapshot().channelAccounts.telegram?.broken).toMatchObject({
      configured: true,
      running: false,
      lastError:
        "Secret owner account:telegram:broken is configured but unavailable (credential file is unavailable).",
    });
    expect(listActiveDegradedSecretOwners()).toContainEqual(
      expect.objectContaining({
        ownerId: "telegram:broken",
        paths: [credentialConfigPath],
        refKeys: [],
      }),
    );

    await expect(
      manager.startChannel("telegram", "broken", { skipUnavailableAccounts: true }),
    ).rejects.toMatchObject({
      code: "SECRET_SURFACE_UNAVAILABLE",
      ownerId: "telegram:broken",
    });
    expect(startAccount.mock.calls.map(([context]) => context.accountId)).toEqual(["healthy"]);
    expect(listActiveDegradedSecretOwners()).toContainEqual(
      expect.objectContaining({ ownerId: "telegram:broken" }),
    );

    fs.writeFileSync(credentialPath, "repaired-token", { mode: 0o600 });
    await manager.startChannel("telegram", "broken", { skipUnavailableAccounts: true });

    expect(startAccount.mock.calls.map(([context]) => context.accountId)).toEqual([
      "healthy",
      "broken",
    ]);
    expect(listActiveDegradedSecretOwners()).not.toContainEqual(
      expect.objectContaining({ ownerId: "telegram:broken" }),
    );
    await manager.stopChannel("telegram");
  });

  it("does not start deferred channel accounts after stop wins the startup handoff", async () => {
    const releaseAccountStart = createDeferred();
    const measureMock = vi.fn(async (name: string, run: () => unknown) => await run());
    const startupTrace = {
      measure: async <T>(name: string, run: () => T | Promise<T>) =>
        (await measureMock(name, run)) as T,
    };
    const startAccount = vi.fn(async () => {});

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({
      startupTrace,
      deferStartupAccountStartsUntil: releaseAccountStart.promise,
    });

    await manager.startChannels();
    await flushMicrotasks();
    const stopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await flushMicrotasks();
    await stopTask;
    await flushMicrotasks();
    releaseAccountStart.resolve();
    await flushMicrotasks();

    expect(startAccount).not.toHaveBeenCalled();
    expect(measureMock.mock.calls.map(([name]) => name)).not.toContain(
      "channels.discord.start-account-handoff",
    );
    expect(readAccount(manager)?.running).not.toBe(true);
  });

  it("retires only the credential owner for an evicted channel account", async () => {
    let accountIds = ["removed", "retained"];
    installTestRegistry(
      createTestPlugin({
        listAccountIds: () => accountIds,
        startAccount: async () => {},
        resolveAccount: (_cfg, accountId) => ({
          enabled: true,
          configured: true,
          credentialDiagnostics: [
            {
              code: "CREDENTIAL_FILE_UNAVAILABLE" as const,
              path: `channels.discord.accounts.${accountId}.tokenFile`,
              reason: "not-found",
            },
          ],
        }),
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    expect(listActiveDegradedSecretOwners().map((owner) => owner.ownerId)).toEqual([
      "discord:removed",
      "discord:retained",
    ]);

    accountIds = ["retained"];
    await expect(manager.startChannel("discord")).rejects.toMatchObject({
      ownerId: "discord:retained",
    });

    expect(listActiveDegradedSecretOwners().map((owner) => owner.ownerId)).toEqual([
      "discord:retained",
    ]);
  });

  it("prunes only credential owners and account state for inactive channel plugins", async () => {
    installTestRegistry(
      ...(["discord", "slack"] as const).map((channelId) =>
        createTestPlugin({
          id: channelId,
          listAccountIds: () => ["Ops Team"],
          startAccount: async () => {},
          resolveAccount: (_cfg, accountId) => ({
            enabled: true,
            configured: true,
            credentialDiagnostics: [
              {
                code: "CREDENTIAL_FILE_UNAVAILABLE" as const,
                path: `channels.${channelId}.accounts.${accountId}.tokenFile`,
                reason: "not-found",
              },
            ],
          }),
        }),
      ),
    );
    const manager = createManager({ channelIds: ["discord", "slack"] });

    await manager.startChannels();
    expect(listActiveDegradedSecretOwners().map((owner) => owner.ownerId)).toEqual([
      "discord:ops-team",
      "slack:ops-team",
    ]);

    manager.pruneInactiveChannelAccountState(new Set(["slack"]));

    expect(listActiveDegradedSecretOwners().map((owner) => owner.ownerId)).toEqual([
      "slack:ops-team",
    ]);
    expect(manager.resolveRuntimeAccountId("discord", "ops-team")).toBeUndefined();
    expect(manager.resolveRuntimeAccountId("slack", "ops-team")).toBe("Ops Team");
  });

  it("resolves only an unambiguous authoritative runtime account for a normalized owner", async () => {
    let accountIds = ["Ops Team"];
    installTestRegistry(
      createTestPlugin({
        id: "line",
        listAccountIds: () => accountIds,
        startAccount: async () => {},
        resolveAccount: (_cfg, accountId) => ({
          enabled: true,
          configured: true,
          credentialDiagnostics: [
            {
              code: "CREDENTIAL_FILE_UNAVAILABLE" as const,
              path: `channels.line.accounts.${accountId}.channelAccessTokenFile`,
              reason: "not-found",
            },
          ],
        }),
      }),
    );
    const manager = createManager({ channelIds: ["line"] });

    await manager.startChannels();

    expect(manager.resolveRuntimeAccountId("line", "ops-team")).toBe("Ops Team");
    expect(manager.resolveRuntimeAccountId("line", "missing")).toBeUndefined();

    accountIds = ["Ops Team", "ops-team"];
    await manager.startChannels();

    expect(manager.resolveRuntimeAccountId("line", "ops-team")).toBeUndefined();
  });

  it("uses normalized account config for health monitor overrides", () => {
    installTestRegistry(createTestPlugin());

    const manager = createManager({
      getRuntimeConfig: () => ({
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
      getRuntimeConfig: () => ({
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

  it("monitors a healthy sibling without resolving disabled or blocked credentials", async () => {
    const resolveAccount = vi.fn((_cfg: OpenClawConfig, accountId?: string | null) => {
      if (accountId !== "healthy") {
        throw new Error("unresolved SecretRef");
      }
      return { enabled: true, configured: true };
    });
    const startAccount = vi.fn(
      async ({ setStatus, abortSignal }: ChannelGatewayContext<TestAccount>) => {
        setStatus({
          accountId: "healthy",
          running: true,
          connected: true,
          lastTransportActivityAt: Date.now(),
        });
        await waitForAbort(abortSignal);
      },
    );
    const plugin = createTestPlugin({
      listAccountIds: () => ["broken", "disabled", "healthy"],
      resolveAccount,
      startAccount,
    });
    plugin.config.inspectAccount = (_cfg, accountId) => ({
      enabled: accountId !== "disabled",
      configured: true,
    });
    installTestRegistry(plugin);
    setActiveDegradedSecretOwners([
      {
        ownerKind: "account",
        ownerId: "discord:broken",
        state: "unavailable",
        paths: ["channels.discord.accounts.broken.token"],
        refKeys: ["env:default:BROKEN_TOKEN"],
        reason: "secret reference was not found",
      },
    ]);
    const manager = createManager();
    await manager.startChannel("discord", "healthy");
    const restart = vi.spyOn(manager, "startChannel");
    const monitor = startChannelHealthMonitor({
      scheduler: createTestGatewayScheduler("fake-timers"),
      channelManager: manager,
      timing: { monitorStartupGraceMs: 2, channelConnectGraceMs: 0, staleEventThresholdMs: 1 },
    });
    try {
      await vi.advanceTimersByTimeAsync(2);
      await monitor.waitForIdle();
      expect(restart).toHaveBeenCalledExactlyOnceWith("discord", "healthy");
      expect(startAccount).toHaveBeenCalledTimes(2);
      expect(resolveAccount.mock.calls.map(([, accountId]) => accountId)).toEqual([
        "healthy",
        "healthy",
      ]);
      expect(manager.getRuntimeSnapshot().channelAccounts.discord).toMatchObject({
        broken: { enabled: true, configured: true, lifecycle: "blocked", running: false },
        disabled: { enabled: false, running: false },
        healthy: { enabled: true, running: true },
      });
    } finally {
      monitor.shutdown();
    }
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
      getRuntimeConfig: () => ({
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
  it("starts and stops approval bootstrap and task contexts with the account", async () => {
    const channelRuntime = createRuntimeChannel();
    const nativeApprovalRuntime = {
      request: vi.fn(),
      requestRoute: vi.fn(),
      routeCoordinator: {} as never,
      subscribe: vi.fn(),
    } as GatewayNativeApprovalRuntime;
    const stopBootstrap = vi.fn(async () => {});
    hoisted.startChannelApprovalHandlerBootstrap.mockResolvedValue(stopBootstrap);
    const key = {
      channelId: "discord",
      accountId: DEFAULT_ACCOUNT_ID,
      capability: "approval.native",
    };
    installTestRegistry(
      createTestPlugin({
        startAccount: async (ctx) => {
          expect(getGatewayNativeApprovalRuntime()).toBe(nativeApprovalRuntime);
          ctx.channelRuntime?.runtimeContexts.register({ ...key, context: { token: "tracked" } });
          await waitForAbort(ctx.abortSignal);
        },
      }),
    );
    const manager = createManager({
      channelRuntime,
      getNativeApprovalRuntime: () => nativeApprovalRuntime,
    });
    await manager.startChannels();
    expect(hoisted.startChannelApprovalHandlerBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        plugin: expect.objectContaining({ id: "discord" }),
        cfg: {},
        accountId: DEFAULT_ACCOUNT_ID,
        gatewayRuntime: nativeApprovalRuntime,
      }),
    );
    expect(channelRuntime.runtimeContexts.get(key)).toEqual({ token: "tracked" });
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(stopBootstrap).toHaveBeenCalledOnce();
    expect(channelRuntime.runtimeContexts.get(key)).toBeUndefined();
  });

  it("continues account startup when approval bootstrap fails", async () => {
    hoisted.startChannelApprovalHandlerBootstrap.mockRejectedValue(new Error("boom"));
    const startAccount = vi.fn(stayRunning);
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({ channelRuntime: createRuntimeChannel() });
    await manager.startChannels();
    expect(startAccount).toHaveBeenCalledOnce();
    expect(readAccount(manager)).toMatchObject({
      accountId: DEFAULT_ACCOUNT_ID,
      running: true,
      restartPending: false,
      lastError: null,
    });
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
