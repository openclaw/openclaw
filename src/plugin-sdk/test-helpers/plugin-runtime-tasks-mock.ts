import { vi } from "vitest";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

type BoundTaskFlowRuntime = ReturnType<PluginRuntime["tasks"]["managedFlows"]["bindSession"]>;

function createTaskFlowSessionMock(): BoundTaskFlowRuntime {
  return {
    sessionKey: "agent:main:main",
    createManaged: vi.fn<BoundTaskFlowRuntime["createManaged"]>(),
    tryCreateManaged: vi.fn<BoundTaskFlowRuntime["tryCreateManaged"]>(),
    get: vi.fn<BoundTaskFlowRuntime["get"]>(),
    list: vi.fn<BoundTaskFlowRuntime["list"]>(() => []),
    findLatest: vi.fn<BoundTaskFlowRuntime["findLatest"]>(),
    resolve: vi.fn<BoundTaskFlowRuntime["resolve"]>(),
    getTaskSummary: vi.fn<BoundTaskFlowRuntime["getTaskSummary"]>(),
    setWaiting: vi.fn<BoundTaskFlowRuntime["setWaiting"]>(),
    resume: vi.fn<BoundTaskFlowRuntime["resume"]>(),
    finish: vi.fn<BoundTaskFlowRuntime["finish"]>(),
    fail: vi.fn<BoundTaskFlowRuntime["fail"]>(),
    requestCancel: vi.fn<BoundTaskFlowRuntime["requestCancel"]>(),
    cancel: vi.fn<BoundTaskFlowRuntime["cancel"]>(),
    runTask: vi.fn<BoundTaskFlowRuntime["runTask"]>(),
  };
}

function createAsyncReadSession(params: { sessionKey?: string }) {
  return {
    sessionKey: params.sessionKey ?? "agent:main:main",
    get: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    findLatest: vi.fn(async () => undefined),
    resolve: vi.fn(async () => undefined),
  };
}

function createAsyncFlowReadSession(params: { sessionKey?: string }) {
  return { ...createAsyncReadSession(params), getTaskSummary: vi.fn(async () => undefined) };
}

function readBinding<Bound>(factory: (params: { sessionKey?: string }) => Bound) {
  return { bindSession: vi.fn(factory), fromToolContext: vi.fn(factory) };
}

export function createPluginTasksRuntimeMock(): PluginRuntime["tasks"] {
  return {
    async: {
      runs: readBinding(createAsyncReadSession),
      flows: readBinding(createAsyncFlowReadSession),
      managedFlows: readBinding(createAsyncFlowReadSession),
    },
    runs: {
      bindSession: vi.fn<PluginRuntime["tasks"]["runs"]["bindSession"]>(),
      fromToolContext: vi.fn<PluginRuntime["tasks"]["runs"]["fromToolContext"]>(),
    },
    flows: {
      bindSession: vi.fn<PluginRuntime["tasks"]["flows"]["bindSession"]>(),
      fromToolContext: vi.fn<PluginRuntime["tasks"]["flows"]["fromToolContext"]>(),
    },
    managedFlows: {
      bindSession:
        vi.fn<PluginRuntime["tasks"]["managedFlows"]["bindSession"]>(createTaskFlowSessionMock),
      fromToolContext:
        vi.fn<PluginRuntime["tasks"]["managedFlows"]["fromToolContext"]>(createTaskFlowSessionMock),
    },
  };
}
