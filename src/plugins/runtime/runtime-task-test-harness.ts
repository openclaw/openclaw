// Runtime task test harness helpers build mocked plugin runtimes for task-flow tests.
import { expect, vi } from "vitest";
import {
  type HeartbeatWakeRequest,
  requestHeartbeat,
  setHeartbeatWakeHandler,
} from "../../infra/heartbeat-wake.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";

const runtimeTaskMocks = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  cancelSessionMock: vi.fn(),
  killSubagentRunAdminMock: vi.fn(),
  heartbeatWakeMock: vi.fn(async (_request: HeartbeatWakeRequest) => ({
    status: "skipped" as const,
    reason: "disabled",
  })),
}));

vi.mock("../../tasks/task-registry-delivery-runtime.js", () => ({
  sendMessage: runtimeTaskMocks.sendMessageMock,
  resolveTaskControlUiSessionUrl: () => undefined,
}));

vi.mock("../../tasks/task-registry-control.runtime.js", () => ({
  cancelBackgroundExecSession: () => false,
  cancelActiveCronTaskRun: () => false,
  getAcpSessionManager: () => ({ cancelSession: runtimeTaskMocks.cancelSessionMock }),
  killSubagentRunAdmin: runtimeTaskMocks.killSubagentRunAdminMock,
}));

const HEARTBEAT_FLUSH_REASON = "runtime-task-test-flush";
let disposeHeartbeatWakeHandler: (() => void) | undefined;

export function getRuntimeTaskMocks() {
  return runtimeTaskMocks;
}

export function installRuntimeTaskDeliveryMock(): void {
  // Terminal task delivery requests heartbeat wakes. Consume them here: a wake left
  // pending with no handler is delivered to the next handler any later test file in
  // the shared worker installs, and that file then observes a foreign wake.
  disposeHeartbeatWakeHandler?.();
  disposeHeartbeatWakeHandler = setHeartbeatWakeHandler(runtimeTaskMocks.heartbeatWakeMock);
}

// Runtime task tests write durable rows into the worker's shared state store.
// Skipping the reset write leaves those rows behind, and the next
// ensureTaskRegistryReady() restores them into the process registry as active
// restart blockers for every later test file in the same worker.
export async function resetRuntimeTaskTestState(): Promise<void> {
  await flushHeartbeatWakeRequests();
  disposeHeartbeatWakeHandler?.();
  disposeHeartbeatWakeHandler = undefined;
  resetDetachedTaskLifecycleRuntimeForTests();
  resetTaskRegistryForTests();
  resetTaskFlowRegistryForTests();
  vi.clearAllMocks();
}

// A sentinel wake proves every earlier pending wake was delivered to this file's handler.
async function flushHeartbeatWakeRequests(): Promise<void> {
  if (!disposeHeartbeatWakeHandler) {
    return;
  }
  requestHeartbeat({
    source: "other",
    intent: "immediate",
    reason: HEARTBEAT_FLUSH_REASON,
    coalesceMs: 0,
  });
  await vi.waitFor(() => {
    expect(
      runtimeTaskMocks.heartbeatWakeMock.mock.calls.some(
        ([request]) => request.reason === HEARTBEAT_FLUSH_REASON,
      ),
    ).toBe(true);
  });
}
