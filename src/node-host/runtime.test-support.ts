import { beforeEach, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import type { NodeHostClient } from "./client.js";

const mocks = vi.hoisted(() => {
  const closeMcp = vi.fn(async () => undefined);
  return {
    closeMcp,
    closeWorkerSupervisor: vi.fn(async () => undefined),
    retireIdleWorkers: vi.fn<() => Promise<void>>(async () => undefined),
    workerHasActiveWork: vi.fn(async () => false),
    pluginHasActiveWork: vi.fn(() => false),
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

// mock-isolation: runtime lifecycle tests must not mutate the host PATH.
vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));
// mock-isolation: the controlled invocation promise exposes runtime cancellation and cleanup.
vi.mock("./invoke.js", () => ({ handleInvoke: mocks.handleInvoke }));
// mock-isolation: controlled MCP startup and close avoid launching real MCP services.
vi.mock("./mcp.js", () => ({ startNodeHostMcpManager: mocks.startMcp }));

vi.mock("./node-invoke-progress.js", () => ({
  createNodeInvokeProgressWriter: vi.fn(() => ({
    startHeartbeats: mocks.progressStartHeartbeats,
    write: mocks.progressWrite,
    stop: vi.fn(),
    flush: mocks.progressFlush,
  })),
}));

// mock-isolation: runtime lifecycle tests control worker activity and settlement without workers.
vi.mock("./node-worker-supervisor.js", () => ({
  createNodeWorkerSupervisor: vi.fn(() => ({
    initialize: async () => undefined,
    hasActiveWork: mocks.workerHasActiveWork,
    retireIdle: mocks.retireIdleWorkers,
    close: mocks.closeWorkerSupervisor,
  })),
}));

vi.mock("./node-worker-workspace.js", () => ({
  NodeWorkerWorkspaceRuntime: class {
    readonly exec = vi.fn();
    readonly checkAdmission = vi.fn(async () => undefined);
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

// mock-isolation: runtime lifecycle tests have no host skills to discover.
vi.mock("./skills.js", () => ({ scanNodeHostedSkills: vi.fn(() => []) }));

// Retain local bindings after mock registration for Vitest's export transform.
const { prepareNodeHostRuntime } = await import("./runtime.js");
export { mocks };

export const frame = { id: "invoke-1", nodeId: "node-1", command: "test.duplex", paramsJSON: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.closeMcp.mockResolvedValue(undefined);
  mocks.closeWorkerSupervisor.mockResolvedValue(undefined);
  mocks.workerHasActiveWork.mockResolvedValue(false);
  mocks.retireIdleWorkers.mockResolvedValue(undefined);
  mocks.pluginHasActiveWork.mockReturnValue(false);
  mocks.disconnectPlugins.mockResolvedValue(undefined);
});

export function createNodeHostClient(
  request: (...args: Parameters<NodeHostClient["request"]>) => Promise<unknown>,
): NodeHostClient {
  return {
    request: async <T>(...args: Parameters<NodeHostClient["request"]>) =>
      (await request(...args)) as T,
  };
}

export async function startRuntime(
  client: NodeHostClient = createNodeHostClient(async () => ({ bins: [] })),
) {
  const prepared = await prepareNodeHostRuntime({
    config: { nodeHost: { skills: { enabled: false }, workerRuns: { enabled: true } } },
    env: { PATH: "/usr/bin" },
    enableAgentRuns: true,
  });
  return prepared.start({ client });
}

export function holdInvoke() {
  let context: { pluginCommandIo?: OpenClawPluginNodeHostCommandIo; signal?: AbortSignal } = {};
  const held = createDeferred();
  mocks.handleInvoke.mockImplementationOnce(async (...args: unknown[]) => {
    context = args[4] as typeof context;
    await held.promise;
  });
  return {
    get io() {
      return context.pluginCommandIo;
    },
    get signal() {
      return context.signal;
    },
    release: () => held.resolve(),
  };
}
