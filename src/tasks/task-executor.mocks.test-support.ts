// Register these factories before importing task runtime modules.
import { vi } from "vitest";
import type { SubagentAdminKillParams } from "./task-registry-control.types.js";

const hoisted = vi.hoisted(() => {
  const sendMessageMock = vi.fn();
  const cancelSessionMock = vi.fn();
  const killSubagentRunAdminMock = vi.fn();
  return {
    sendMessageMock,
    cancelSessionMock,
    killSubagentRunAdminMock,
  };
});

vi.mock("./task-registry-delivery-runtime.js", () => ({
  sendMessage: hoisted.sendMessageMock,
  prepareTaskControlUiSessionUrl: async () => () => undefined,
}));

vi.mock("./task-registry-control.runtime.js", () => ({
  cancelBackgroundExecSession: () => false,
  cancelActiveCronTaskRun: () => false,
  getAcpSessionManager: () => ({ cancelSession: hoisted.cancelSessionMock }),
  killSubagentRunAdmin: async (params: SubagentAdminKillParams) => {
    const result = await hoisted.killSubagentRunAdminMock(params);
    params.onResult?.(result);
    return result;
  },
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: hoisted.cancelSessionMock,
  }),
}));

vi.mock("../agents/subagents/registry/subagent-control.js", () => ({
  killSubagentRunAdmin: (params: unknown) => hoisted.killSubagentRunAdminMock(params),
}));

vi.mock("../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (channel: string) => channel === "notifychat",
}));

export { hoisted };
