import { vi } from "vitest";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-flow-registry.js";
import {
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryDeliveryRuntimeForTests,
} from "../../tasks/task-registry.js";

const runtimeTaskMocks = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  cancelSessionMock: vi.fn(),
  killSubagentRunAdminMock: vi.fn(),
}));

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: runtimeTaskMocks.cancelSessionMock,
  }),
}));

vi.mock("../../agents/subagent-control.js", () => ({
  killSubagentRunAdmin: (params: unknown) => runtimeTaskMocks.killSubagentRunAdminMock(params),
}));

export function getRuntimeTaskMocks() {
  return runtimeTaskMocks;
}

export function installRuntimeTaskDeliveryMock(): void {
  setTaskRegistryDeliveryRuntimeForTests({
    sendMessage: runtimeTaskMocks.sendMessageMock,
  });
}

export function resetRuntimeTaskTestState(
  taskRegistryOptions?: Parameters<typeof resetTaskRegistryForTests>[0],
): void {
  resetTaskRegistryDeliveryRuntimeForTests();
  resetTaskRegistryForTests(taskRegistryOptions);
  resetTaskFlowRegistryForTests({ persist: false });
  vi.clearAllMocks();
}
