import { vi } from "vitest";
import type { NodeWorkerJournalWorker as JournalWorker } from "./node-worker-journal-worker.js";
import type { NodeWorkerLaunchStore as LaunchStore } from "./node-worker-launch-store.js";
import type { NodeWorkerTurnStore } from "./node-worker-turn-store.js";

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
  acquirePreparedWorkspace:
    vi.fn<
      typeof import("./node-worker-workspace.js").NodeWorkerWorkspaceRuntime.prototype.acquirePreparedWorkspace
    >(),
  retain:
    vi.fn<
      typeof import("./node-worker-workspace.js").NodeWorkerWorkspaceRuntime.prototype.applyRetainSnapshot
    >(),
  inspectIdentity:
    vi.fn<typeof import("./node-worker-process-identity.js").inspectNodeWorkerProcessIdentity>(),
  inspectTree: vi.fn<typeof import("./node-worker-tree-control.js").inspectOwnedNodeWorkerTree>(),
  remove:
    vi.fn<
      typeof import("./node-worker-container-lifecycle.js").NodeWorkerContainerLifecycle.prototype.remove
    >(),
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
vi.mock("./node-worker-workspace.js", () => ({
  NodeWorkerWorkspaceRuntime: class {
    acquirePreparedWorkspace = mocks.acquirePreparedWorkspace;
    applyRetainSnapshot = mocks.retain;
    processes = {
      hasActiveWork: () => false,
      stopEnvironment: async () => {},
      close: async () => {},
    };
  },
}));
vi.mock("./node-worker-process-identity.js", () => ({
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
const { NodeWorkerCapacity } = await import("./node-worker-capacity.js");
const { NodeWorkerContainerLifecycle } = await import("./node-worker-container-lifecycle.js");
const { NodeWorkerJournalWorker } = await import("./node-worker-journal-worker.js");
const { NodeWorkerLaunchStore } = await import("./node-worker-launch-store.js");
const { createNodeWorkerLaunchRecovery } = await import("./node-worker-supervisor-recovery.js");
const { createNodeWorkerSupervisor } = await import("./node-worker-supervisor.js");

export {
  NodeWorkerCapacity,
  NodeWorkerContainerLifecycle,
  NodeWorkerJournalWorker,
  NodeWorkerLaunchStore,
  createNodeWorkerLaunchRecovery,
  createNodeWorkerSupervisor,
  mocks,
};
