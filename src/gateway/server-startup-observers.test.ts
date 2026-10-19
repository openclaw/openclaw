import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { runGatewayStartupObservers } from "./server-startup-observers.js";
import { captureGatewayScopeMatcher } from "./session-runtime-scope.js";

const mocks = vi.hoisted(() => ({
  prewarm: vi.fn(async () => {}),
  delivery: vi.fn(async () => {}),
  exec: vi.fn(async () => {}),
}));

// mock-isolation: Hold recovery I/O at the owner boundary without allocating native readers.
vi.mock("./server-history-prewarm.js", () => ({
  prewarmGatewaySessionHistory: mocks.prewarm,
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
  resumeAgentDeletions: vi.fn(async () => {}),
}));
// mock-isolation: Watch-notice persistence is independent of recovery activation ordering.
vi.mock("../sessions/session-state-events.js", () => ({
  sweepSessionStateWatchNotices: vi.fn(async () => {}),
}));

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset().mockResolvedValue(undefined);
  }
});
afterEach(() => resetGatewayWorkAdmission());

it.for(["prewarm", "delivery", "exec"] as const)(
  "activates healthy subagents while %s waits for another agent database",
  async (blocked, { signal }) => {
    const prepared = createDeferred();
    const activated = createDeferred();
    const refreshed = createDeferred();
    const entered = createDeferred();
    const context = createContext();
    const resolveGatewayContext = () => context;
    const sessionKey = "agent:main:startup-exec-recovery";
    const sessionId = "startup-exec-recovery";
    const storePath = "/synthetic/startup-exec-recovery";
    let operation: ReturnType<typeof createReplyOperation> | undefined;
    mocks[blocked].mockImplementation(async () => {
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
      await prepared.promise;
      operation?.complete();
    });
    const controller = new AbortController();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let settled = false;
    const observers = runGatewayStartupObservers({
      registry: createEmptyPluginRegistry(),
      resolveGatewayContext,
      loadSubagentRegistryActivation: () => async () => {
        activated.resolve();
      },
      createHookRunner: async (...args) =>
        (await import("../plugins/hooks.js")).createHookRunner(...args),
      refreshLatestUpdateRestartSentinel: async () => refreshed.resolve(),
      signal: controller.signal,
      port: 0,
      config: {},
      workspaceDir: "/unused",
      getCron: () => undefined,
      isClosing: () => controller.signal.aborted,
      log,
      logHooks: log,
    }).then(() => {
      settled = true;
    });
    try {
      await withinTest(Promise.all([activated.promise, refreshed.promise]), signal);
      if (blocked !== "prewarm") {
        await withinTest(entered.promise, signal);
        expect(settled).toBe(false);
      }
      if (blocked === "exec") {
        expect(operation).toBeDefined();
        expect(captureGatewayScopeMatcher(resolveGatewayContext)(operation!)).toBe(true);
        expect(captureGatewayScopeMatcher(() => context)(operation!)).toBe(false);
      }
      prepared.resolve();
      await observers;
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      prepared.resolve();
      await observers;
      operation?.complete();
      await operation?.ownerSettlement;
    }
  },
);
