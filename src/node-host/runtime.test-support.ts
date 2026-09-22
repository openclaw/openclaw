import { beforeEach, vi } from "vitest";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import type { NodeHostClient } from "./client.js";

const mocks = vi.hoisted(() => {
  const closeMcp = vi.fn(async () => undefined);
  return {
    closeMcp,
    closeWorkerSupervisor: vi.fn(async () => undefined),
    workerHasActiveWork: vi.fn(async () => false),
    pluginHasActiveWork: vi.fn(() => false),
    initializeWorkerSupervisor: vi.fn(async () => undefined),
    disconnectPlugins: vi.fn<() => Promise<void>>(async () => undefined),
    handleInvoke: vi.fn(async () => undefined),
    progressStartHeartbeats: vi.fn(),
    progressWrite: vi.fn(async (_chunk: string) => undefined),
    progressFlush: vi.fn<() => Promise<void>>(async () => undefined),
    startMcp: vi.fn(async (_servers: unknown, _deps?: { signal?: AbortSignal }) => ({
      descriptors: [],
      callMcpTool: vi.fn(),
      close: closeMcp,
    })),
  };
});

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: vi.fn(),
}));

vi.mock("./invoke.js", () => ({
  handleInvoke: mocks.handleInvoke,
}));

vi.mock("./mcp.js", () => ({
  startNodeHostMcpManager: mocks.startMcp,
}));

vi.mock("./node-invoke-progress.js", () => ({
  createNodeInvokeProgressWriter: vi.fn(() => ({
    startHeartbeats: mocks.progressStartHeartbeats,
    write: mocks.progressWrite,
    stop: vi.fn(),
    flush: mocks.progressFlush,
  })),
}));

vi.mock("./node-worker-supervisor.js", () => ({
  createNodeWorkerSupervisor: vi.fn(() => ({
    initialize: mocks.initializeWorkerSupervisor,
    hasActiveWork: mocks.workerHasActiveWork,
    close: mocks.closeWorkerSupervisor,
  })),
}));

vi.mock("./node-worker-workspace.js", () => ({
  NodeWorkerWorkspaceRuntime: class {
    readonly exec = vi.fn();
  },
}));

vi.mock("./plugin-node-host.js", () => ({
  ensureNodeHostPluginRegistry: vi.fn(async () => undefined),
  hasRegisteredNodeHostCommandActiveWork: mocks.pluginHasActiveWork,
  notifyRegisteredNodeHostCommandDisconnect: mocks.disconnectPlugins,
  isRegisteredNodeHostCommandDuplex: vi.fn((command: string) => command === "test.duplex"),
  listRegisteredNodeHostCapsAndCommands: vi.fn(() => ({
    caps: ["terminal"],
    commands: ["test.duplex"],
    nodePluginTools: [],
  })),
}));

vi.mock("./skills.js", () => ({
  scanNodeHostedSkills: vi.fn(() => []),
}));

// Retain local bindings after mock registration for Vitest's export transform.
const { prepareNodeHostRuntime } = await import("./runtime.js");
const { listRegisteredNodeHostCapsAndCommands } = await import("./plugin-node-host.js");
export { mocks, prepareNodeHostRuntime, listRegisteredNodeHostCapsAndCommands };

export const frame = {
  id: "invoke-1",
  nodeId: "node-1",
  command: "test.duplex",
  paramsJSON: null,
  timeoutMs: 0,
  idempotencyKey: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.closeMcp.mockResolvedValue(undefined);
  mocks.closeWorkerSupervisor.mockResolvedValue(undefined);
  mocks.initializeWorkerSupervisor.mockResolvedValue(undefined);
  mocks.workerHasActiveWork.mockResolvedValue(false);
  mocks.pluginHasActiveWork.mockReturnValue(false);
  mocks.disconnectPlugins.mockResolvedValue(undefined);
});

export function createNodeHostClient(
  request: (...args: Parameters<NodeHostClient["request"]>) => Promise<unknown>,
): NodeHostClient {
  return {
    async request<T>(...args: Parameters<NodeHostClient["request"]>) {
      return (await request(...args)) as T;
    },
  };
}

export async function startRuntime(
  client: NodeHostClient = createNodeHostClient(async () => ({ bins: [] })),
) {
  const prepared = await prepareNodeHostRuntime({
    config: { nodeHost: { skills: { enabled: false }, workerRuns: { enabled: true } } },
    env: { PATH: "/usr/bin" },
    enableAgentRuns: true,
    enableWorkerRuns: true,
  });
  return prepared.start({ client });
}

export function holdInvoke(onCommand?: (io: OpenClawPluginNodeHostCommandIo) => void) {
  let io: OpenClawPluginNodeHostCommandIo | undefined;
  let signal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.handleInvoke.mockImplementationOnce(async (...args: unknown[]) => {
    const runtime = args[4] as {
      pluginCommandIo?: OpenClawPluginNodeHostCommandIo;
      signal?: AbortSignal;
    };
    io = runtime.pluginCommandIo;
    signal = runtime.signal;
    if (io) {
      onCommand?.(io);
    }
    await held;
  });
  return {
    get io() {
      return io;
    },
    get signal() {
      return signal;
    },
    release: () => release?.(),
  };
}
