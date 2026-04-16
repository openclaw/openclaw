import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedRuntime = {
  kind: "shared-runtime",
};

const createOpenClawA2ABrokerRuntimeMock = vi.fn(() => sharedRuntime);
const runA2ATaskRequestMock = vi.fn();
const applyA2ATaskProtocolCancelMock = vi.fn();
const applyA2ATaskProtocolUpdateMock = vi.fn();
const loadA2ATaskProtocolStatusByIdMock = vi.fn();

vi.mock("../../agents/a2a/openclaw-runtime.js", () => ({
  createOpenClawA2ABrokerRuntime: createOpenClawA2ABrokerRuntimeMock,
}));

vi.mock("../../agents/a2a/broker.js", () => ({
  runA2ATaskRequest: runA2ATaskRequestMock,
  applyA2ATaskProtocolCancel: applyA2ATaskProtocolCancelMock,
  applyA2ATaskProtocolUpdate: applyA2ATaskProtocolUpdateMock,
  loadA2ATaskProtocolStatusById: loadA2ATaskProtocolStatusByIdMock,
}));

vi.mock("../protocol/index.js", () => ({
  ErrorCodes: {
    INTERNAL: "internal",
    INVALID_REQUEST: "invalid_request",
    NOT_FOUND: "not_found",
  },
  errorShape: vi.fn(),
  validateA2ATaskCancelParams: vi.fn(() => true),
  validateA2ATaskRequestParams: vi.fn(() => true),
  validateA2ATaskStatusParams: vi.fn(() => true),
  validateA2ATaskUpdateParams: vi.fn(() => true),
}));

vi.mock("./validation.js", () => ({
  assertValidParams: vi.fn(() => true),
}));

describe("a2a handlers", () => {
  beforeEach(() => {
    vi.resetModules();
    createOpenClawA2ABrokerRuntimeMock.mockClear();
    runA2ATaskRequestMock.mockReset();
    applyA2ATaskProtocolCancelMock.mockReset();
    applyA2ATaskProtocolUpdateMock.mockReset();
    loadA2ATaskProtocolStatusByIdMock.mockReset();

    runA2ATaskRequestMock.mockResolvedValue({
      response: {
        method: "a2a.task.request",
        taskId: "task-1",
      },
    });
    applyA2ATaskProtocolCancelMock.mockResolvedValue({
      method: "a2a.task.cancel",
      taskId: "task-1",
    });
  });

  it("reuses one broker runtime across request and cancel handlers", async () => {
    const { a2aHandlers } = await import("./a2a.js");
    const respond = vi.fn();
    const context = {
      logGateway: {
        error: vi.fn(),
      },
    };

    await a2aHandlers["a2a.task.request"]({
      params: {
        request: {
          taskId: "task-1",
        },
      },
      respond,
      context,
    } as never);

    await a2aHandlers["a2a.task.cancel"]({
      params: {
        sessionKey: "agent:worker:main",
        cancel: {
          taskId: "task-1",
        },
      },
      respond,
      context,
    } as never);

    expect(createOpenClawA2ABrokerRuntimeMock).toHaveBeenCalledTimes(1);
    expect(runA2ATaskRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: sharedRuntime,
      }),
    );
    expect(applyA2ATaskProtocolCancelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: sharedRuntime,
      }),
    );
  });
});
