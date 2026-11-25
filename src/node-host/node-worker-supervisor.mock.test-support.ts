import { vi } from "vitest";
import type { NodeWorkerContainerLifecycle as ContainerLifecycle } from "./node-worker-container-lifecycle.js";
import type { NodeWorkerJournalWorker as JournalWorker } from "./node-worker-journal-worker.js";
import type { NodeWorkerLaunchStore as LaunchStore } from "./node-worker-launch-store.js";
import type { NodeWorkerTurnStore } from "./node-worker-turn-store.js";
import type { NodeWorkerWorkspaceQuiescence } from "./node-worker-workspace-quiescence.js";
import type { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const mocks = vi.hoisted(() => ({
  launchClaim: vi.fn<LaunchStore["claim"]>(),
  launchGet: vi.fn<LaunchStore["get"]>(),
  launchMatching: vi.fn<LaunchStore["getMatching"]>(),
  launchList: vi.fn<LaunchStore["listNonterminal"]>(),
  launchCount: vi.fn<LaunchStore["nonterminalCount"]>(),
  launchPrune: vi.fn<LaunchStore["pruneExpiredTerminal"]>(),
  launchRunning: vi.fn<LaunchStore["markRunning"]>(),
  launchFinish: vi.fn<LaunchStore["finish"]>(),
  launchCancelled: vi.fn<LaunchStore["finishCancelled"]>(),
  turnClaim: vi.fn<NodeWorkerTurnStore["claim"]>(),
  turnGet: vi.fn<NodeWorkerTurnStore["get"]>(),
  turnMatching: vi.fn<NodeWorkerTurnStore["getMatching"]>(),
  turnFinish: vi.fn<NodeWorkerTurnStore["finish"]>(),
  drain: vi.fn<JournalWorker["drain"]>(async () => {}),
  quiescenceClose: vi.fn<NodeWorkerWorkspaceQuiescence["close"]>(async () => {}),
  acquirePreparedWorkspace: vi.fn<NodeWorkerWorkspaceRuntime["acquirePreparedWorkspace"]>(),
  retain: vi.fn<NodeWorkerWorkspaceRuntime["applyRetainSnapshot"]>(),
  inspectIdentity:
    vi.fn<typeof import("./node-worker-process-identity.js").inspectNodeWorkerProcessIdentity>(),
  inspectTree: vi.fn<typeof import("./node-worker-tree-control.js").inspectOwnedNodeWorkerTree>(),
  remove: vi.fn<ContainerLifecycle["remove"]>(),
  observe: vi.fn<typeof import("./node-worker-launch-observation.js").observeNodeWorkerChild>(),
  prepare:
    vi.fn<typeof import("./node-worker-launch-transport.js").prepareNodeWorkerLaunchTransport>(),
  send: vi.fn<typeof import("./node-worker-launch-transport.js").sendNodeWorkerInput>(),
}));

vi.mock("./node-worker-journal-worker.js", () => ({
  NodeWorkerJournalWorker: class {
    drain = mocks.drain;
  },
}));
vi.mock("./node-worker-launch-store.js", () => ({
  NodeWorkerLaunchStore: class {
    claim = mocks.launchClaim;
    get = mocks.launchGet;
    getMatching = mocks.launchMatching;
    listNonterminal = mocks.launchList;
    nonterminalCount = mocks.launchCount;
    pruneExpiredTerminal = mocks.launchPrune;
    markRunning = mocks.launchRunning;
    finish = mocks.launchFinish;
    finishCancelled = mocks.launchCancelled;
  },
}));
vi.mock("./node-worker-turn-store.js", () => ({
  NodeWorkerTurnStore: class {
    claim = mocks.turnClaim;
    get = mocks.turnGet;
    getMatching = mocks.turnMatching;
    finish = mocks.turnFinish;
  },
}));
vi.mock("./node-worker-container-lifecycle.js", () => ({
  NodeWorkerContainerLifecycle: class {
    initialize = async () => {};
    inspect = async () => "live";
    remove = mocks.remove;
  },
}));
vi.mock("./node-worker-workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-worker-workspace.js")>();
  const { NodeWorkerWorkspaceProcesses } = await import("./node-worker-workspace-processes.js");
  return {
    ...actual,
    NodeWorkerWorkspaceRuntime: class {
      acquirePreparedWorkspace = mocks.acquirePreparedWorkspace;
      applyRetainSnapshot = mocks.retain;
      quiescence = { hasActiveWork: () => false, close: mocks.quiescenceClose };
      processes = new NodeWorkerWorkspaceProcesses();
    },
  };
});

// mock-isolation: These pure supervisor tests never inspect host processes or boot identity.
vi.mock("./node-worker-process-identity.js", () => ({
  getNodeWorkerBootIdentity: () => null,
  requireNodeWorkerProcessIdentity: (pid: number) => ({ pid, startTime: 1 }),
  inspectNodeWorkerProcessIdentity: mocks.inspectIdentity,
}));
vi.mock("./node-worker-tree-control.js", () => {
  const unexpected = () => {
    throw new Error("Process-tree control is outside this pure fixture");
  };
  return {
    inspectOwnedNodeWorkerTree: mocks.inspectTree,
    signalOwnedNodeWorkerTree: unexpected,
    signalOwnedNodeWorkerAnchor: unexpected,
    stopOwnedNodeWorkerTree: unexpected,
    waitForOwnedNodeWorkerTreeDeath: unexpected,
  };
});
vi.mock("./node-worker-launch-observation.js", () => ({
  observeNodeWorkerChild: mocks.observe,
}));
vi.mock("./node-worker-launch-transport.js", () => ({
  prepareNodeWorkerLaunchTransport: mocks.prepare,
  sendNodeWorkerInput: mocks.send,
}));

// Re-exports evaluate dependencies before Vitest installs these mocks.
export const { NodeWorkerCapacity } = await import("./node-worker-capacity.js");
export const { NodeWorkerContainerLifecycle } =
  await import("./node-worker-container-lifecycle.js");
export const { NodeWorkerJournalWorker } = await import("./node-worker-journal-worker.js");
export const { NodeWorkerLaunchStore } = await import("./node-worker-launch-store.js");
export const { createNodeWorkerLaunchRecovery } =
  await import("./node-worker-supervisor-recovery.js");
export const { createNodeWorkerSupervisor } = await import("./node-worker-supervisor.js");
export { mocks };
