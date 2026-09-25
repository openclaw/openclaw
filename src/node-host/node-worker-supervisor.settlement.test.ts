import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKER_PUBLIC_INGRESS_PATH } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { toErrorObject } from "../infra/errors.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { NodeWorkerCapacity } from "./node-worker-capacity.js";
import { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { nodeWorkerTurnMatchesIdentity } from "./node-worker-journal.types.js";
import { NodeWorkerLaunchStore, type NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import type { NodeWorkerChildAdapter } from "./node-worker-launch-transport.js";
import type { NodeWorkerRunningChild } from "./node-worker-supervisor-ownership.js";
import { createNodeWorkerLaunchRecovery } from "./node-worker-supervisor-recovery.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_ENDPOINT,
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";
import type { NodeWorkerTurnReceipt, NodeWorkerTurnStore } from "./node-worker-turn-store.js";

const mocks = vi.hoisted(() => ({
  launchClaim: vi.fn<NodeWorkerLaunchStore["claim"]>(),
  launchGet: vi.fn<NodeWorkerLaunchStore["get"]>(),
  launchMatching: vi.fn<NodeWorkerLaunchStore["getMatching"]>(),
  launchList: vi.fn<NodeWorkerLaunchStore["listNonterminal"]>(),
  launchCount: vi.fn<NodeWorkerLaunchStore["nonterminalCount"]>(),
  launchPrune: vi.fn<NodeWorkerLaunchStore["pruneExpiredTerminal"]>(),
  launchRunning: vi.fn<NodeWorkerLaunchStore["markRunning"]>(),
  launchFinish: vi.fn<NodeWorkerLaunchStore["finish"]>(),
  launchCancelled: vi.fn<NodeWorkerLaunchStore["finishCancelled"]>(),
  turnClaim: vi.fn<NodeWorkerTurnStore["claim"]>(),
  turnGet: vi.fn<NodeWorkerTurnStore["get"]>(),
  turnMatching: vi.fn<NodeWorkerTurnStore["getMatching"]>(),
  turnFinish: vi.fn<NodeWorkerTurnStore["finish"]>(),
  drain: vi.fn<NodeWorkerJournalWorker["drain"]>(async () => {}),
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
  start: vi.fn<typeof import("./node-worker-launch-transport.js").startNodeWorkerLaunchTransport>(),
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
    acquirePreparedWorkspace = () => undefined;
    applyRetainSnapshot = mocks.retain;
    processes = {
      hasActiveWork: () => false,
      stopEnvironment: async () => {},
      close: async () => {},
    };
  },
}));
vi.mock("./node-worker-process-identity.js", () => ({
  requireNodeWorkerProcessIdentity: () => ({ pid: 101, startTime: 1 }),
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
  startNodeWorkerLaunchTransport: mocks.start,
  sendNodeWorkerInput: mocks.send,
}));

afterEach(() => vi.resetAllMocks());

it("joins accepted workspace retention before sealing journals on close", async () => {
  const entered = createDeferred();
  const release = createDeferred<{ applied: boolean; deleted: number; hasMore: boolean }>();
  mocks.launchList.mockResolvedValue([]);
  mocks.launchCount.mockResolvedValue(0);
  mocks.launchPrune.mockResolvedValue(0);
  mocks.drain.mockResolvedValue(undefined);
  mocks.retain.mockImplementation(async () => {
    entered.resolve();
    return await release.promise;
  });
  const supervisor = createNodeWorkerSupervisor({
    env: { OPENCLAW_STATE_DIR: "/synthetic/state" },
  });
  const input = {
    version: 1 as const,
    gatewayNamespace: "gateway-1",
    controllerId: "controller-1",
    sequence: 1,
    retain: [],
  };
  const retained = supervisor.retainWorkspaces(input);
  await entered.promise;
  let closed = false;
  const closing = supervisor.close().then(() => {
    closed = true;
  });
  try {
    await nextTurn();
    expect(closed).toBe(false);
    expect(mocks.drain).not.toHaveBeenCalled();
    expect(await supervisor.hasActiveWork()).toBe(true);
    await expect(supervisor.retainWorkspaces(input)).rejects.toThrow("supervisor is closed");
    release.resolve({ applied: true, deleted: 0, hasMore: false });
    await Promise.all([retained, closing]);
    expect(closed).toBe(true);
    expect(await supervisor.hasActiveWork()).toBe(false);
  } finally {
    release.resolve({ applied: true, deleted: 0, hasMore: false });
    await Promise.allSettled([retained, closing]);
  }
});

it.each(["cancelled", "caller-abort", "cleanup-failure"] as const)(
  "joins pending admission cancellation through %s settlement",
  async (outcome) => {
    const input = testWorkerLaunchInput("/synthetic/workspace", "pending-cancel");
    const identity = testNodeWorkerLaunchIdentity(input);
    const entered = createDeferred();
    const releaseClaim = createDeferred();
    const finishing = createDeferred();
    const releaseFinish = createDeferred();
    const controller = new AbortController();
    const callerAbort = new Error("Caller revoked admission");
    const cleanupFailure = new Error("Physical reservation cleanup failed");
    const snapshots: number[] = [];
    let receipt: NodeWorkerLaunchReceipt | undefined;
    mocks.launchList.mockResolvedValue([]);
    mocks.launchPrune.mockResolvedValue(0);
    mocks.launchCount.mockImplementation(async () => (receipt?.state === "pending" ? 1 : 0));
    mocks.turnGet.mockResolvedValue(undefined);
    mocks.turnMatching.mockResolvedValue(undefined);
    mocks.launchClaim.mockImplementation(async (claim, supervisor) => {
      receipt = {
        ...claim,
        supervisor,
        worker: null,
        workerCleanupMode: null,
        workerLineageSettled: false,
        state: "pending",
        resultJson: null,
        errorText: null,
        completedAtMs: null,
        createdAtMs: 1,
        updatedAtMs: 1,
      };
      return { action: "start", receipt, nonterminalCount: 1 };
    });
    mocks.turnClaim.mockImplementation(async (_claim, authority) => {
      entered.resolve();
      await releaseClaim.promise;
      authority?.assertCurrent();
      throw new Error("Cancelled admission unexpectedly retained authority");
    });
    mocks.launchFinish.mockImplementation(async (params) => {
      const current = receipt;
      if (!current) {
        throw new Error("Physical reservation was never admitted");
      }
      finishing.resolve();
      await releaseFinish.promise;
      if (outcome === "cleanup-failure") {
        throw cleanupFailure;
      }
      receipt = { ...current, state: params.state };
      return receipt;
    });
    const supervisor = createNodeWorkerSupervisor({
      env: { OPENCLAW_STATE_DIR: "/synthetic/state" },
      capacity: 1,
      capacityWaitMs: 0,
      onCapacityChanged: (snapshot) => snapshots.push(snapshot.available),
    });
    const launching = supervisor.launch(input, TEST_WORKER_ENDPOINT, controller.signal);
    const launchResult = launching.catch((error: unknown) => error);
    let cancelling: Promise<unknown> | undefined;
    let cancellationSettled = false;
    try {
      await entered.promise;
      if (outcome === "caller-abort") {
        controller.abort(callerAbort);
      }
      cancelling = supervisor.cancel(identity).then(
        (value) => {
          cancellationSettled = true;
          return value;
        },
        (error: unknown) => {
          cancellationSettled = true;
          throw error;
        },
      );
      const cancelResult = cancelling.catch((error: unknown) => error);
      await nextTurn();
      expect(cancellationSettled).toBe(false);
      releaseClaim.resolve();
      await finishing.promise;
      await nextTurn();
      expect(cancellationSettled).toBe(false);
      expect(snapshots.at(-1)).toBe(0);
      expect(mocks.prepare).not.toHaveBeenCalled();
      releaseFinish.resolve();
      if (outcome === "cleanup-failure") {
        expect(await cancelResult).toBe(cleanupFailure);
        expect(await launchResult).toBe(cleanupFailure);
        expect(snapshots.at(-1)).toBe(0);
        expect(await supervisor.hasActiveWork()).toBe(true);
      } else {
        expect(await cancelResult).toBeUndefined();
        expect(await launchResult).toBeInstanceOf(Error);
        expect(receipt?.state).toBe("cancelled");
        expect(snapshots.at(-1)).toBe(1);
        expect(await supervisor.hasActiveWork()).toBe(false);
      }
    } finally {
      releaseClaim.resolve();
      releaseFinish.resolve();
      await Promise.allSettled([launching, cancelling]);
      await supervisor.close();
    }
  },
);

it("settles retained startup cancellation without joining its own admission", async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    f.emitResult.resolve();
    await f.entered.promise;
    f.persistence.resolve();
    await nextTurn();
    expect(await f.supervisor.status(f.identity.launchId)).toMatchObject({ state: "completed" });
    f.firstRemoval.resolve();
    f.retryRemoval.resolve();
    mocks.send.mockImplementation(async (_adapter, message) => {
      if (message.type === "turn") {
        controller.abort(new Error("Caller cancelled during retained dispatch"));
      } else {
        throw new Error("Synthetic child input is closed");
      }
    });
    const input = testWorkerLaunchInput("/synthetic/workspace", "retained-start-cancel");
    expect(await f.supervisor.launch(input, TEST_WORKER_ENDPOINT, controller.signal)).toMatchObject(
      {
        launchId: input.launchId,
        state: "cancelled",
      },
    );
    expect(f.snapshots.at(-1)).toBe(1);
    expect(await f.supervisor.hasActiveWork()).toBe(false);
  } finally {
    await f.dispose();
  }
});

async function fixture(unknownOutcome = false) {
  mocks.inspectIdentity.mockReturnValue("live");
  const input = testWorkerLaunchInput("/synthetic/workspace", "settlement-turn");
  const identity = testNodeWorkerLaunchIdentity(input);
  const persistence = createDeferred();
  const entered = createDeferred();
  const emitResult = createDeferred();
  const exited = createDeferred();
  const firstRemoval = createDeferred();
  const removalEntered = createDeferred();
  const retryRemoval = createDeferred();
  const retryEntered = createDeferred();
  const snapshots: number[] = [];
  const onPersist: { call?: () => void } = {};
  let launch: NodeWorkerLaunchReceipt | undefined;
  let turn: NodeWorkerTurnReceipt | undefined;
  let refusal: Error | undefined;
  let turnSettled = false;
  const currentLaunch = () => {
    if (refusal) {
      throw refusal;
    }
    if (!launch) {
      throw new Error("Synthetic launch has not been claimed");
    }
    return launch;
  };
  const currentTurn = () => {
    if (refusal) {
      throw refusal;
    }
    if (!turn) {
      return undefined;
    }
    const owner = currentLaunch();
    return {
      ...turn,
      supervisor: owner.supervisor,
      worker: owner.worker,
      ...(owner.container ? { container: owner.container } : {}),
      state: turn.state === "running" && owner.state === "pending" ? "pending" : turn.state,
    } satisfies NodeWorkerTurnReceipt;
  };
  mocks.launchClaim.mockImplementation(async (claim, supervisor, _capacity, _now, authority) => {
    authority?.assertCurrent();
    launch = {
      ...claim,
      supervisor,
      worker: null,
      workerCleanupMode: null,
      workerLineageSettled: false,
      state: "pending",
      resultJson: null,
      errorText: null,
      completedAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    return { action: "start", receipt: launch, nonterminalCount: 1 };
  });
  mocks.launchGet.mockImplementation(async () => currentLaunch());
  mocks.launchMatching.mockImplementation(async () => currentLaunch());
  mocks.launchList.mockImplementation(async () => (launch ? [launch] : []));
  mocks.launchCount.mockImplementation(async () =>
    launch && (launch.state === "pending" || launch.state === "running") ? 1 : 0,
  );
  mocks.launchPrune.mockResolvedValue(0);
  mocks.launchRunning.mockImplementation(async (params) => {
    launch = {
      ...currentLaunch(),
      state: "running",
      worker: params.worker,
      workerCleanupMode: params.cleanupMode,
      container: params.container,
    };
    return launch;
  });
  mocks.launchFinish.mockImplementation(async (params) => {
    launch = { ...currentLaunch(), state: params.state };
    if (turn?.state === "running") {
      turn = { ...turn, state: params.state === "completed" ? "interrupted" : params.state };
    }
    return launch;
  });
  mocks.turnClaim.mockImplementation(async ({ claim, ownerLaunchId }, authority) => {
    authority?.assertCurrent();
    turn = { ...currentLaunch(), ...claim, ownerLaunchId, state: "running" };
    return { action: "start", receipt: currentTurn()! };
  });
  mocks.turnGet.mockImplementation(async (launchId) => {
    const receipt = currentTurn();
    return receipt?.launchId === launchId ? receipt : undefined;
  });
  mocks.turnMatching.mockImplementation(async (expected) => {
    const receipt = currentTurn();
    return receipt && nodeWorkerTurnMatchesIdentity(receipt, expected) ? receipt : undefined;
  });
  mocks.turnFinish.mockImplementation(async (params) => {
    if (mocks.turnFinish.mock.calls.length === 1) {
      onPersist.call?.();
      entered.resolve();
      try {
        await persistence.promise;
      } catch (error) {
        if (unknownOutcome) {
          refusal = toErrorObject(error, "Synthetic persistence failure");
        }
        throw error;
      }
    }
    const receipt = currentTurn();
    if (!receipt) {
      throw new Error("Synthetic turn disappeared");
    }
    turn = { ...receipt, state: params.state, resultJson: params.resultJson ?? null };
    return turn;
  });
  mocks.drain.mockImplementation(async () => {
    if (refusal) {
      throw refusal;
    }
  });
  mocks.remove.mockImplementation(async () => {
    if (mocks.remove.mock.calls.length === 1) {
      removalEntered.resolve();
      await firstRemoval.promise;
    } else {
      retryEntered.resolve();
      await retryRemoval.promise;
    }
  });
  const adapter: NodeWorkerChildAdapter = {
    pid: 202,
    supportsRawOutput: true,
    onStdout: () => {},
    onStderr: () => {},
    onExit: () => {},
    onError: () => {},
    consumeStdout: async (listener) => {
      await emitResult.promise;
      await listener(
        `${JSON.stringify({
          type: "result",
          turnId: identity.launchId,
          result: { status: "completed", transcriptLeafId: "leaf", transcriptNextSeq: 2 },
          retainWorker: true,
        })}\n`,
      );
      await exited.promise;
    },
    wait: async () => {
      await exited.promise;
      return { code: 0, signal: null };
    },
    kill: () => exited.resolve(),
    dispose: () => {},
  };
  mocks.prepare.mockResolvedValue({
    kind: "started",
    adapter,
    cleanupMode: null,
    container: { engine: "docker", containerId: "a".repeat(64), engineTarget: "b".repeat(64) },
  });
  mocks.start.mockResolvedValue(undefined);
  mocks.send.mockRejectedValue(new Error("Synthetic child input is closed"));
  const { observeNodeWorkerChild } = await vi.importActual<
    typeof import("./node-worker-launch-observation.js")
  >("./node-worker-launch-observation.js");
  mocks.observe.mockImplementation(
    (
      active: Parameters<typeof observeNodeWorkerChild>[0] & Pick<NodeWorkerRunningChild, "turn">,
      onResult,
      currentTurnId,
      cleanupContainer,
    ) => {
      if (!active.turn) {
        throw new Error("Synthetic observation has no admitted turn");
      }
      void active.turn.done.then(() => {
        turnSettled = true;
      });
      return observeNodeWorkerChild(active, onResult, currentTurnId, cleanupContainer);
    },
  );
  const supervisor = createNodeWorkerSupervisor({
    bundleRoot: "/synthetic/bundles",
    env: { OPENCLAW_STATE_DIR: "/synthetic/state", NODE_DISABLE_COMPILE_CACHE: "1" },
    capacity: 1,
    containerEngine: { id: "docker", command: "synthetic-container", target: "b".repeat(64) },
    onCapacityChanged: (snapshot) => snapshots.push(snapshot.available),
  });
  await supervisor.launch(input, {
    kind: "websocket",
    url: `wss://gateway.example.invalid${WORKER_PUBLIC_INGRESS_PATH}`,
  });
  return {
    supervisor,
    identity,
    persistence,
    entered,
    emitResult,
    firstRemoval,
    removalEntered,
    retryRemoval,
    retryEntered,
    snapshots,
    onPersist,
    readTurn: () => turn,
    turnSettled: () => turnSettled,
    readReceipt: currentTurn,
    async dispose() {
      persistence.resolve();
      emitResult.resolve();
      exited.resolve();
      firstRemoval.resolve();
      retryRemoval.resolve();
      try {
        await supervisor.close();
      } catch (error) {
        if (!refusal) {
          throw error;
        }
      }
    },
  };
}

function recoveryFixture(container = false) {
  const input = testWorkerLaunchInput("/synthetic/workspace", "recovery-turn");
  const engine = { id: "docker", command: "synthetic-container", target: "b".repeat(64) } as const;
  const original: NodeWorkerLaunchReceipt = {
    ...testNodeWorkerLaunchIdentity(input),
    gatewayNamespace: input.gatewayNamespace,
    state: "running",
    supervisor: { pid: 303, startTime: 1 },
    worker: { pid: 404, startTime: 2 },
    workerCleanupMode: container ? null : "owned-anchor",
    workerLineageSettled: !container,
    ...(container
      ? {
          container: {
            engine: engine.id,
            containerId: "c".repeat(64),
            engineTarget: engine.target,
          },
        }
      : {}),
    resultJson: null,
    errorText: null,
    completedAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  let receipt = original;
  let active = true;
  mocks.inspectIdentity.mockReturnValue("dead");
  mocks.inspectTree.mockReturnValue("dead");
  mocks.launchGet.mockImplementation(async () => receipt);
  mocks.launchMatching.mockImplementation(async () => receipt);
  mocks.launchCount.mockImplementation(async () => (receipt.state === "running" ? 1 : 0));
  const finish: NodeWorkerLaunchStore["finish"] = async (params, authority) => {
    authority?.assertCurrent();
    receipt = { ...receipt, state: params.state };
    return receipt;
  };
  mocks.launchFinish.mockImplementation(finish);
  mocks.remove.mockResolvedValue(undefined);
  const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({}));
  const recover = createNodeWorkerLaunchRecovery({
    store,
    capacity: new NodeWorkerCapacity(store, { capacity: 1 }),
    ...(container
      ? {
          containerLifecycle: new NodeWorkerContainerLifecycle(engine, "/synthetic/bundles", store),
        }
      : {}),
    recoveries: new Map(),
    isRecoveryActive: () => active,
  });
  return {
    original,
    store,
    recover,
    finish,
    close: () => {
      active = false;
    },
  };
}

describe("node worker persistence settlement lifetime", () => {
  it.each(["ownership read", "terminal admission"] as const)(
    "retains the stale launch when recovery closes during %s",
    async (boundary) => {
      const f = recoveryFixture(true);
      const entered = createDeferred();
      const release = createDeferred();
      if (boundary === "ownership read") {
        mocks.launchMatching.mockResolvedValueOnce(f.original).mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return f.original;
        });
      } else {
        mocks.launchFinish.mockImplementationOnce(async (...args) => {
          entered.resolve();
          await release.promise;
          return f.finish(...args);
        });
      }
      const recovering = f.recover(f.original, true, undefined, true);
      try {
        await entered.promise;
        f.close();
        release.resolve();
        expect(await recovering).toEqual(f.original);
        expect(await f.store.nonterminalCount()).toBe(1);
        if (boundary === "ownership read") {
          expect(mocks.remove).not.toHaveBeenCalled();
          expect(mocks.launchFinish).not.toHaveBeenCalled();
        }
      } finally {
        f.close();
        release.resolve();
        await recovering;
      }
    },
  );

  it.each(["before admission", "after admission", "unknown settlement"] as const)(
    "preserves recovery cancellation and terminal authority %s",
    async (boundary) => {
      const f = recoveryFixture();
      const entered = createDeferred();
      const release = createDeferred();
      const unknown = new SqliteWorkerError(
        "Synthetic transaction outcome is unknown",
        "outcome-unknown",
      );
      mocks.launchFinish.mockImplementationOnce(async (...args) => {
        const committed = boundary === "after admission" ? await f.finish(...args) : undefined;
        entered.resolve();
        await release.promise;
        if (boundary === "unknown settlement") {
          throw unknown;
        }
        return committed ?? f.finish(...args);
      });
      const recovering = f.recover(f.original, true, undefined, true);
      let cancellation: Promise<NodeWorkerLaunchReceipt> | undefined;
      try {
        await entered.promise;
        cancellation = f.recover(f.original, true, "cancelled", true);
        const settled = Promise.allSettled([recovering, cancellation]);
        release.resolve();
        if (boundary === "unknown settlement") {
          expect(await settled).toEqual([
            { status: "rejected", reason: unknown },
            { status: "rejected", reason: unknown },
          ]);
          expect(mocks.launchFinish).toHaveBeenCalledOnce();
          expect(await f.store.nonterminalCount()).toBe(1);
        } else {
          const state = boundary === "before admission" ? "cancelled" : "interrupted";
          expect(await settled).toEqual([
            { status: "fulfilled", value: expect.objectContaining({ state }) },
            { status: "fulfilled", value: expect.objectContaining({ state }) },
          ]);
          expect(mocks.launchFinish).toHaveBeenCalledTimes(boundary === "before admission" ? 2 : 1);
          expect(await f.store.nonterminalCount()).toBe(0);
        }
      } finally {
        release.resolve();
        await Promise.allSettled([recovering, cancellation]);
      }
    },
  );

  it("keeps receipt replay available after close without admitting a new launch", async () => {
    const f = await fixture();
    try {
      f.emitResult.resolve();
      await f.entered.promise;
      f.persistence.resolve();
      await nextTurn();
      const completed = await f.supervisor.status(f.identity.launchId);
      await f.dispose();
      const writes = mocks.turnFinish.mock.calls.length + mocks.launchFinish.mock.calls.length;
      expect(await f.supervisor.status(f.identity.launchId)).toEqual(completed);
      expect(await f.supervisor.cancel(f.identity)).toEqual(completed);
      await expect(
        f.supervisor.launch(
          testWorkerLaunchInput("/synthetic/workspace", "after-close-turn"),
          TEST_WORKER_ENDPOINT,
        ),
      ).rejects.toThrow("supervisor is closed");
      expect(mocks.turnFinish.mock.calls.length + mocks.launchFinish.mock.calls.length).toBe(
        writes,
      );
    } finally {
      await f.dispose();
    }
  });

  it("does not initialize recovery for a receipt read after closing an unused supervisor", async () => {
    const supervisor = createNodeWorkerSupervisor({
      env: { OPENCLAW_STATE_DIR: "/synthetic/state" },
    });
    mocks.launchList.mockRejectedValue(new Error("Recovery must stay closed"));
    mocks.turnGet.mockResolvedValue(undefined);
    await supervisor.close();
    expect(await supervisor.status("absent-turn")).toBeUndefined();
    expect(mocks.launchList).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("retries failed close cleanup before completing shutdown", async () => {
    const f = await fixture();
    const failure = new Error("Synthetic close cleanup failed");
    try {
      f.emitResult.resolve();
      await f.entered.promise;
      f.persistence.resolve();
      await nextTurn();
      const closing = f.supervisor.close();
      const rejected = expect(closing).rejects.toBe(failure);
      await f.removalEntered.promise;
      f.firstRemoval.reject(failure);
      await rejected;
      expect(f.snapshots.at(-1)).toBe(0);
      f.retryRemoval.resolve();
      await f.supervisor.close();
      expect(f.snapshots.at(-1)).toBe(1);
      expect(await f.supervisor.cancel(f.identity)).toMatchObject({ state: "completed" });
    } finally {
      await f.dispose();
    }
  });

  it("reconciles an observed replacement after a delayed running receipt", async () => {
    const f = await fixture();
    const readEntered = createDeferred();
    const releaseRead = createDeferred();
    try {
      mocks.launchFinish.mockRejectedValueOnce(new Error("Synthetic terminal journal failure"));
      mocks.turnMatching.mockImplementationOnce(async () => {
        const receipt = f.readReceipt();
        readEntered.resolve();
        await releaseRead.promise;
        return receipt;
      });
      const cancellation = f.supervisor.cancel(f.identity);
      await readEntered.promise;
      f.emitResult.resolve();
      await f.entered.promise;
      f.persistence.reject(new Error("Synthetic result journal failure"));
      f.firstRemoval.resolve();
      f.retryRemoval.resolve();
      await nextTurn();
      expect(f.turnSettled()).toBe(false);
      releaseRead.resolve();
      expect(await cancellation).toMatchObject({ state: "cancelled" });
      expect(f.turnSettled()).toBe(true);
      expect(f.snapshots.at(-1)).toBe(1);
    } finally {
      releaseRead.resolve();
      await f.dispose();
    }
  });

  it("retains turn completion after physical cleanup until terminal persistence succeeds", async () => {
    const f = await fixture();
    const failure = new Error("Synthetic terminal journal failure");
    try {
      mocks.launchFinish.mockRejectedValueOnce(failure);
      f.emitResult.resolve();
      await f.entered.promise;
      f.persistence.reject(new Error("Synthetic result journal failure"));
      f.firstRemoval.resolve();
      f.retryRemoval.resolve();
      await nextTurn();
      expect(mocks.launchFinish).toHaveBeenCalledOnce();
      expect(f.turnSettled()).toBe(false);
      expect(f.snapshots.at(-1)).toBe(0);
      mocks.launchFinish.mockRejectedValueOnce(failure);
      await expect(f.supervisor.cancel(f.identity)).rejects.toBe(failure);
      expect(f.turnSettled()).toBe(false);
      expect(await f.supervisor.status(f.identity.launchId)).toMatchObject({ state: "failed" });
      expect(f.turnSettled()).toBe(true);
      expect(f.snapshots.at(-1)).toBe(1);
    } finally {
      await f.dispose();
    }
  });

  it.each([
    { timing: "during persistence", expectedState: "cancelled" },
    { timing: "after failed cleanup", expectedState: "failed" },
  ] as const)(
    "retries owned container cleanup when cancellation starts $timing",
    async ({ timing, expectedState }) => {
      const f = await fixture();
      const cleanupFailure = new Error("Synthetic container cleanup failed");
      let cancellation: Promise<NodeWorkerLaunchReceipt | undefined> | undefined;
      try {
        f.emitResult.resolve();
        await f.entered.promise;
        if (timing === "during persistence") {
          cancellation = f.supervisor.cancel(f.identity);
          void cancellation.catch(() => undefined);
          await nextTurn();
        }
        f.persistence.reject(new Error("Synthetic known write failure"));
        await f.removalEntered.promise;
        await nextTurn();
        if (timing === "during persistence") {
          expect(mocks.send).toHaveBeenCalledOnce();
        }
        f.firstRemoval.reject(cleanupFailure);
        await nextTurn();
        if (cancellation) {
          await expect(cancellation).rejects.toBe(cleanupFailure);
        }
        expect(f.readTurn()?.state).toBe("running");
        expect(f.turnSettled()).toBe(false);
        expect(mocks.launchFinish).not.toHaveBeenCalled();
        expect(f.snapshots.at(-1)).toBe(0);
        const retry = f.supervisor.cancel(f.identity);
        await nextTurn();
        expect(mocks.remove).toHaveBeenCalledTimes(2);
        expect(mocks.launchFinish).not.toHaveBeenCalled();
        f.retryRemoval.resolve();
        expect(await retry).toMatchObject({ state: expectedState });
        expect(mocks.launchFinish.mock.lastCall?.[0].state).toBe(expectedState);
        expect(f.turnSettled()).toBe(true);
        expect(f.snapshots.at(-1)).toBe(1);
      } finally {
        await f.dispose();
      }
    },
  );

  it("lets successful persistence win over a reentrant cancellation", async () => {
    const f = await fixture();
    let cancellation: Promise<NodeWorkerLaunchReceipt | undefined> | undefined;
    try {
      f.onPersist.call = () => {
        cancellation = f.supervisor.cancel(f.identity);
      };
      f.emitResult.resolve();
      await f.entered.promise;
      await nextTurn();
      expect(cancellation).toBeDefined();
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
      f.persistence.resolve();
      expect(await cancellation).toMatchObject({ state: "completed" });
      expect(f.turnSettled()).toBe(true);
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(f.snapshots.at(-1)).toBe(0);
    } finally {
      await f.dispose();
    }
  });

  it("retains unknown-outcome refusal after rejected persistence", async () => {
    const f = await fixture(true);
    const failure = new SqliteWorkerError(
      "Synthetic transaction outcome is unknown",
      "outcome-unknown",
    );
    try {
      f.emitResult.resolve();
      await f.entered.promise;
      const cancellation = f.supervisor.cancel(f.identity);
      let cancelled = false;
      void cancellation.then(
        () => {
          cancelled = true;
        },
        () => {
          cancelled = true;
        },
      );
      await nextTurn();
      f.persistence.reject(failure);
      await f.removalEntered.promise;
      f.firstRemoval.reject(new Error("Synthetic container cleanup failed"));
      await nextTurn();
      expect(cancelled).toBe(true);
      await expect(cancellation).rejects.toBe(failure);
      expect(f.readTurn()?.state).toBe("running");
      expect(f.turnSettled()).toBe(false);
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.launchFinish).not.toHaveBeenCalled();
      expect(f.snapshots.at(-1)).toBe(0);
      f.retryRemoval.resolve();
      await expect(f.supervisor.close()).rejects.toThrow();
      await expect(f.supervisor.status(f.identity.launchId)).rejects.toBe(failure);
    } finally {
      await f.dispose();
    }
  });

  it.each(["before settlement", "during settlement"] as const)(
    "retains completion ownership across a delayed receipt read starting %s",
    async (timing) => {
      const f = await fixture();
      const readEntered = createDeferred();
      const releaseRead = createDeferred();
      try {
        if (timing === "during settlement") {
          f.emitResult.resolve();
          await f.entered.promise;
        }
        mocks.turnMatching.mockImplementationOnce(async () => {
          const receipt = f.readReceipt();
          readEntered.resolve();
          await releaseRead.promise;
          return receipt;
        });
        const cancellation = f.supervisor.cancel(f.identity);
        if (timing === "before settlement") {
          await readEntered.promise;
          f.emitResult.resolve();
          await f.entered.promise;
        }
        f.persistence.resolve();
        await readEntered.promise;
        await nextTurn();
        releaseRead.resolve();
        await nextTurn();
        expect(mocks.remove).not.toHaveBeenCalled();
        expect(await cancellation).toMatchObject({
          state: timing === "before settlement" ? "cancelled" : "completed",
        });
        expect(mocks.send).not.toHaveBeenCalled();
      } finally {
        releaseRead.resolve();
        await f.dispose();
      }
    },
  );
});
