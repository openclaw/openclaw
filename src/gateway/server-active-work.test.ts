import { afterEach, expect, it, vi } from "vitest";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { retireSessionControllerInput } from "../sessions/session-controller.mailbox.js";
import { requestRpcSourceCancellation } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { createGatewayServerActiveWorkInspectors } from "./server-active-work.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { claimRpcSourceForTest, createRpcSourceForTest } from "./test-helpers.rpc-source.js";

vi.mock("../cron/active-jobs.js", () => ({
  getActiveCronJobCount: vi.fn(() => 2),
}));

vi.mock("../cron/service/active-run-cancellation.js", () => ({
  getSuspensionVisibleCronTaskRunCount: vi.fn(() => 4),
}));

afterEach(() => {
  for (const source of rpcSourceTesting.values()) {
    retireSessionControllerInput(source.input);
  }
  rpcSourceTesting.reset();
});

it("filters completed chat entries while retaining persistence and watcher blockers", async () => {
  const active = createRpcSourceForTest({}, { sessionKey: "agent:main:active" });
  await claimRpcSourceForTest(active);
  const aborted = createRpcSourceForTest();
  requestRpcSourceCancellation(aborted);
  const cancelled = createRpcSourceForTest({}, { phase: "waiting" });
  requestRpcSourceCancellation(cancelled);
  rpcSourceTesting.reset([
    ["active", active],
    ["preparing", createRpcSourceForTest()],
    ["aborted", aborted],
    [
      "persisting",
      createRpcSourceForTest(
        { controlUiVisible: true, projectSessionTerminalPending: true },
        { phase: "consumed", sessionKey: "agent:main:persisting" },
      ),
    ],
    ["queued", createRpcSourceForTest({}, { phase: "waiting" })],
    ["cancelled", cancelled],
  ]);
  const context = {
    cron: { getSuspensionBlockerCount: () => 1 },
    terminalSessions: { size: 2 },
  } as unknown as Pick<GatewayRequestContext, "cron" | "terminalSessions">;

  const inspectors = createGatewayServerActiveWorkInspectors(context);

  expect(inspectors.getCronRuns?.()).toBe(5);
  expect(inspectors.getChatRuns?.()).toBe(1);
  expect(inspectors.getQueuedTurns?.()).toBe(2);
  expect(inspectors.getTerminalPersistence?.()).toBe(1);
  expect(inspectors.getTerminalSessions?.()).toBe(2);
  expect(inspectors.getChatRunHolders?.()).toEqual(["run=active session=agent:main:active"]);
  expect(inspectors.getTerminalPersistenceHolders?.()).toEqual([
    "run=persisting session=agent:main:persisting",
  ]);
});

it("counts only sources belonging to the exact Gateway owner", () => {
  const resolveGatewayContext = () => undefined;
  const resolveOtherGatewayContext = () => undefined;
  const own = createRpcSourceForTest({}, { storeScope: "/synthetic/shared", phase: "waiting" });
  const foreign = createRpcSourceForTest({}, { storeScope: "/synthetic/shared", phase: "waiting" });
  const unbound = createRpcSourceForTest({}, { phase: "waiting" });
  bindGatewayContextResolver(own.input, resolveGatewayContext);
  bindGatewayContextResolver(foreign.input, resolveOtherGatewayContext);
  rpcSourceTesting.reset([
    ["own", own],
    ["foreign", foreign],
    ["unbound", unbound],
  ]);
  const inspectors = createGatewayServerActiveWorkInspectors({
    cron: {},
    resolveGatewayContext,
  });
  expect(inspectors.getQueuedTurns?.()).toBe(1);
});
