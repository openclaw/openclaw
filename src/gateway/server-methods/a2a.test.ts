import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedRuntime = {
  kind: "shared-runtime",
};

const createOpenClawA2ABrokerRuntimeMock = vi.fn(() => sharedRuntime);
const runA2ATaskRequestMock = vi.fn();
const applyA2ATaskProtocolCancelMock = vi.fn();
const applyA2ATaskProtocolUpdateMock = vi.fn();
const loadA2ATaskProtocolStatusByIdMock = vi.fn();
const errorShapeMock = vi.fn((code: string, message: string) => ({ code, message }));

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
  errorShape: errorShapeMock,
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
    errorShapeMock.mockClear();

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

  it("lazily creates and reuses one broker runtime across request and cancel handlers", async () => {
    const { a2aHandlers } = await import("./a2a.js");
    const respond = vi.fn();
    const context = {
      logGateway: {
        error: vi.fn(),
      },
    };

    expect(createOpenClawA2ABrokerRuntimeMock).not.toHaveBeenCalled();

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

  it("uses an injected runtime without touching the default runtime factory", async () => {
    const injectedRuntime = {
      kind: "injected-runtime",
    };
    const { createA2AHandlers } = await import("./a2a.js");
    const handlers = createA2AHandlers({
      runtime: injectedRuntime as never,
    });
    const respond = vi.fn();
    const context = {
      logGateway: {
        error: vi.fn(),
      },
    };

    await handlers["a2a.task.request"]({
      params: {
        request: {
          taskId: "task-1",
        },
      },
      respond,
      context,
    } as never);

    expect(createOpenClawA2ABrokerRuntimeMock).not.toHaveBeenCalled();
    expect(runA2ATaskRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: injectedRuntime,
      }),
    );
  });

  it("logs request failures with target session context", async () => {
    runA2ATaskRequestMock.mockRejectedValue(new Error("broker handshake timed out"));
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
          target: { sessionKey: "agent:worker:main" },
        },
      },
      respond,
      context,
    } as never);

    const failureMessage =
      "A2A request failed for target session agent:worker:main: broker handshake timed out";
    expect(context.logGateway.error).toHaveBeenCalledWith(failureMessage);
    expect(errorShapeMock).toHaveBeenCalledWith("internal", failureMessage);
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "internal",
      message: failureMessage,
    });
  });

  it("logs cancel failures with task and session context", async () => {
    applyA2ATaskProtocolCancelMock.mockRejectedValue(new Error("remote run already finished"));
    const { a2aHandlers } = await import("./a2a.js");
    const respond = vi.fn();
    const context = {
      logGateway: {
        error: vi.fn(),
      },
    };

    await a2aHandlers["a2a.task.cancel"]({
      params: {
        sessionKey: "agent:worker:main",
        cancel: {
          taskId: "task-9",
        },
      },
      respond,
      context,
    } as never);

    const failureMessage =
      "A2A cancel failed for task task-9 in session agent:worker:main: remote run already finished";
    expect(context.logGateway.error).toHaveBeenCalledWith(failureMessage);
    expect(errorShapeMock).toHaveBeenCalledWith("invalid_request", failureMessage);
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "invalid_request",
      message: failureMessage,
    });
  });

  it("returns status not-found errors with session scope", async () => {
    loadA2ATaskProtocolStatusByIdMock.mockResolvedValue(undefined);
    const { a2aHandlers } = await import("./a2a.js");
    const respond = vi.fn();
    const context = {
      logGateway: {
        error: vi.fn(),
      },
    };

    await a2aHandlers["a2a.task.status"]({
      params: {
        sessionKey: "agent:worker:main",
        taskId: "task-missing",
      },
      respond,
      context,
    } as never);

    const notFoundMessage = "A2A task task-missing was not found in session agent:worker:main";
    expect(errorShapeMock).toHaveBeenCalledWith("not_found", notFoundMessage);
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "not_found",
      message: notFoundMessage,
    });
  });
});
