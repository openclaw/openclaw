import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { markStartupOrphanedMainSessionsForRecovery } from "../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as gatewayWorkAdmission from "../process/gateway-work-admission.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import { GatewayInputRecovery } from "./agent-input-recovery.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  markGatewayStartupMainSessionOrphans,
  runGatewayStartupObservers,
} from "./server-startup-observers.js";
import { captureGatewayScopeMatcher } from "./session-runtime-scope.js";

const mocks = vi.hoisted(() => ({
  delivery: vi.fn<typeof import("./session-send-recovery.js").recoverSessionSendDeliveries>(),
  exec: vi.fn<typeof import("../agents/bash-tools.exec-notify.js").recoverExecExitNotifications>(),
}));
const markOrphans = vi.hoisted(() => vi.fn<typeof markStartupOrphanedMainSessionsForRecovery>());
const resumeDeletions = vi.hoisted(() =>
  vi.fn<typeof import("./server-agent-deletion-recovery.js").resumeAgentDeletions>(),
);

// mock-isolation: Control both storage-owner failure contracts without opening agent databases.
vi.mock("../agents/main-session-recovery/main-session-restart-recovery-marking.js", () => ({
  markStartupOrphanedMainSessionsForRecovery: markOrphans,
}));

// mock-isolation: Hold delivery recovery without reading persisted channel deliveries.
vi.mock("./session-send-recovery.js", () => ({
  recoverSessionSendDeliveries: mocks.delivery,
}));
// mock-isolation: Hold exec notification recovery without dispatching persisted notifications.
vi.mock("../agents/bash-tools.exec-notify.js", () => ({
  recoverExecExitNotifications: mocks.exec,
}));
// mock-isolation: Agent deletion and watch-notice persistence are independent startup owners.
vi.mock("./server-agent-deletion-recovery.js", () => ({
  resumeAgentDeletions: resumeDeletions,
}));
// mock-isolation: Watch-notice persistence is independent of recovery activation ordering.
vi.mock("../sessions/session-state-events.js", () => ({
  sweepSessionStateWatchNotices: vi.fn(async () => {}),
}));

function completedRecovery() {
  const settled = Promise.resolve();
  return { initial: settled, pending: new Map<string, Promise<void>>(), settled };
}

type ObserverOptions = Parameters<typeof runGatewayStartupObservers>[0];
function observerOptions(overrides: Partial<ObserverOptions> = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    registry: createEmptyPluginRegistry(),
    resolveGatewayContext: () => createContext(),
    loadSubagentRegistryActivation: () => completedRecovery,
    signal: new AbortController().signal,
    port: 0,
    config: {},
    workspaceDir: "/unused",
    getCron: () => undefined,
    createHookRunner: async (...args: Parameters<ObserverOptions["createHookRunner"]>) =>
      (await import("../plugins/hooks.js")).createHookRunner(...args),
    refreshLatestUpdateRestartSentinel: async () => {},
    log,
    logHooks: log,
    ...overrides,
  };
}

beforeEach(() => {
  markOrphans.mockReset();
  resumeDeletions.mockReset().mockResolvedValue(undefined);
  for (const mock of Object.values(mocks)) {
    mock.mockReset().mockImplementation(completedRecovery);
  }
});
afterEach(() => resetGatewayWorkAdmission());

it.each(["initial", "deletion", "delivery", "exec", "registry-load", "registry-activation"])(
  "keeps fresh input closed when %s recovery fails",
  async (stage) => {
    const error = new Error("saved input store unavailable");
    const fail = () => {
      throw error;
    };
    let loadSubagentRegistryActivation: ObserverOptions["loadSubagentRegistryActivation"] = () =>
      completedRecovery;
    switch (stage) {
      case "initial": {
        const failed = Promise.reject(error);
        void failed.catch(() => {});
        mocks.delivery.mockReturnValue({ initial: failed, pending: new Map(), settled: failed });
        break;
      }
      case "deletion":
        resumeDeletions.mockRejectedValue(error);
        break;
      case "delivery":
        mocks.delivery.mockImplementation(fail);
        break;
      case "exec":
        mocks.exec.mockImplementation(fail);
        break;
      case "registry-load":
        loadSubagentRegistryActivation = fail;
        break;
      case "registry-activation":
        loadSubagentRegistryActivation = () => fail;
        break;
    }
    const gate = new GatewayInputRecovery();
    const unlock = vi.fn(() => gate.releaseInitial());
    const options = observerOptions({
      loadSubagentRegistryActivation,
      trackInputRecovery: (progress) => gate.track(progress),
      unlockStartupMethods: unlock,
    });
    await runGatewayStartupObservers(options);
    expect(unlock).not.toHaveBeenCalled();
    expect(options.log.warn).toHaveBeenCalledWith(expect.stringContaining(error.message));
    await expect(gate.waitForAgentInputRecovery("main")).rejects.toBe(error);
  },
);

it("opens healthy agents after initial recovery while joining deferred recovery on shutdown", async ({
  signal,
}) => {
  const pending = createDeferred();
  const unlocked = createDeferred();
  const gate = new GatewayInputRecovery();
  const initial = Promise.resolve();
  mocks.delivery.mockReturnValue({
    initial,
    pending: new Map([["owner", pending.promise]]),
    settled: pending.promise,
  });
  const recovered = vi.fn();
  let settled = false;
  const controller = new AbortController();
  const observers = runGatewayStartupObservers(
    observerOptions({
      signal: controller.signal,
      trackInputRecovery: (progress) => gate.track(progress),
      unlockStartupMethods: () => {
        gate.releaseInitial();
        unlocked.resolve();
      },
      onSubagentRecoverySettled: recovered,
    }),
  ).then(() => {
    settled = true;
  });
  try {
    await withinTest(unlocked.promise, signal);
    expect(gate.isPending("main")).toBe(false);
    expect(gate.isPending("owner")).toBe(true);
    expect(recovered).not.toHaveBeenCalled();
    controller.abort();
    expect(settled).toBe(false);
    pending.resolve();
    await observers;
    expect(recovered).toHaveBeenCalledOnce();
    expect(gate.isPending("owner")).toBe(false);
  } finally {
    controller.abort();
    pending.resolve();
    await observers;
  }
});

it.each(["rejected", "failed-target"] as const)(
  "holds orphan admission through a config reload after a %s scan",
  async (outcome) => {
    const initial: OpenClawConfig = {};
    const latest: OpenClawConfig = { agents: { entries: { added: {} } } };
    let current = initial;
    const checked = new Set<string>();
    const retryStarted = createDeferred();
    const releaseRetry = createDeferred();
    const controller = new AbortController();
    const warn = vi.fn();
    let settled = false;
    markOrphans
      .mockImplementationOnce(async ({ assertCommitAllowed, startupCheckedStorePaths }) => {
        startupCheckedStorePaths?.add("completed-store");
        current = latest;
        expect(assertCommitAllowed).toThrow("Gateway restart recovery state changed");
        if (outcome === "rejected") {
          assertCommitAllowed?.();
        }
        return {
          marked: 1,
          skipped: 0,
          failedTargets: [{ agentId: "added", storePath: "/synthetic/added/sessions.json" }],
        };
      })
      .mockImplementationOnce(async ({ cfg, assertCommitAllowed, startupCheckedStorePaths }) => {
        expect(cfg).toBe(latest);
        expect(startupCheckedStorePaths).toBe(checked);
        expect(checked).toEqual(new Set(["completed-store"]));
        assertCommitAllowed?.();
        retryStarted.resolve();
        await releaseRetry.promise;
        return { marked: 1, skipped: 0 };
      });
    const marking = markGatewayStartupMainSessionOrphans(
      {
        getConfig: () => current,
        isRestartRecoverySuppressed: () => false,
        scheduler: controller,
        log: { warn },
      },
      checked,
    ).then(() => {
      settled = true;
    });
    try {
      expect(
        await Promise.race([
          retryStarted.promise.then(() => "retry"),
          marking.then(() => "admitted"),
        ]),
      ).toBe("retry");
      expect(settled).toBe(false);
      releaseRetry.resolve();
      await marking;
      expect(markOrphans).toHaveBeenCalledTimes(2);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      releaseRetry.resolve();
      await marking;
    }
  },
);

it.for(["delivery", "exec"] as const)(
  "activates healthy subagents while %s waits for another agent database",
  async (blocked, { signal }) => {
    const prepared = createDeferred();
    const activated = createDeferred();
    const refreshed = createDeferred();
    const entered = createDeferred();
    const recovered = vi.fn();
    const registryRecovery = createDeferred();
    const unlock = vi.fn();
    const context = createContext();
    const resolveGatewayContext = () => context;
    const sessionKey = "agent:main:startup-exec-recovery";
    const sessionId = "startup-exec-recovery";
    const storePath = "/synthetic/startup-exec-recovery";
    let operation: ReturnType<typeof createReplyOperation> | undefined;
    mocks[blocked].mockImplementation(() => {
      if (blocked === "exec") {
        operation = createReplyOperation({
          sessionKey,
          sessionId,
          resetTriggered: false,
          target: captureSessionTarget({
            storeScope: storePath,
            sessionKey,
            incarnation: sessionId,
          }),
        });
      }
      entered.resolve();
      const settled = prepared.promise.then(() => {
        operation?.complete();
      });
      return { initial: settled, pending: new Map(), settled };
    });
    const controller = new AbortController();
    let settled = false;
    const options = observerOptions({
      resolveGatewayContext,
      loadSubagentRegistryActivation: () => () => {
        activated.resolve();
        return completedRecovery();
      },
      refreshLatestUpdateRestartSentinel: async () => refreshed.resolve(),
      signal: controller.signal,
      unlockStartupMethods: unlock,
      onSubagentRecoverySettled: recovered,
      startupTrace: {
        detail: () => {},
        mark: () => {},
        measure: async (name, run) => {
          const result = await run();
          if (name === "sidecars.subagent-recovery") {
            registryRecovery.resolve();
          }
          return result;
        },
      },
      isClosing: () => controller.signal.aborted,
    });
    const observers = runGatewayStartupObservers(options).then(() => {
      settled = true;
    });
    try {
      await withinTest(Promise.all([activated.promise, refreshed.promise]), signal);
      await withinTest(entered.promise, signal);
      expect(settled).toBe(false);
      if (blocked === "delivery") {
        await withinTest(registryRecovery.promise, signal);
        expect(recovered).not.toHaveBeenCalled();
        expect(unlock).not.toHaveBeenCalled();
        expect(settled).toBe(false);
      }
      if (blocked === "exec") {
        expect(operation).toBeDefined();
        expect(captureGatewayScopeMatcher(resolveGatewayContext)(operation!)).toBe(true);
        expect(captureGatewayScopeMatcher(() => context)(operation!)).toBe(false);
      }
      prepared.resolve();
      await observers;
      expect(unlock).toHaveBeenCalledOnce();
      expect(recovered).toHaveBeenCalledOnce();
      expect(options.log.warn).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      prepared.resolve();
      await observers;
      operation?.complete();
      await operation?.ownerSettlement;
    }
  },
);

it("joins recovery preparation when shutdown retires suspended startup admission", async ({
  signal,
}) => {
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.commit()).toBe(true);
  const parked = createDeferred();
  const runWithAdmission = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
  const spy = vi
    .spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission")
    .mockImplementation((run, origin, lifetime) => {
      const work = runWithAdmission(run, origin, lifetime);
      if (origin === "startup:subagent-recovery") {
        parked.resolve();
      }
      return work;
    });
  const controller = new AbortController();
  const activate = vi.fn(completedRecovery);
  const observers = runGatewayStartupObservers(
    observerOptions({
      loadSubagentRegistryActivation: () => activate,
      signal: controller.signal,
      isClosing: () => controller.signal.aborted,
    }),
  );
  try {
    await withinTest(parked.promise, signal);
    controller.abort();
    await observers;
    expect(activate).not.toHaveBeenCalled();
    expect(mocks.delivery).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    suspension?.release();
    spy.mockRestore();
    await observers;
  }
});
