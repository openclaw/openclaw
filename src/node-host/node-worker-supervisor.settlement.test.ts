import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKER_PUBLIC_INGRESS_PATH } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { toErrorObject } from "../infra/errors.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { nodeWorkerTurnMatchesIdentity } from "./node-worker-journal.types.js";
import type { NodeWorkerLaunchReceipt, NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import type { NodeWorkerChildAdapter } from "./node-worker-launch-transport.js";
import type { NodeWorkerRunningChild } from "./node-worker-supervisor-ownership.js";
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
  drain: vi.fn<NodeWorkerTurnStore["drain"]>(),
  remove:
    vi.fn<
      typeof import("./node-worker-container-lifecycle.js").NodeWorkerContainerLifecycle.prototype.remove
    >(),
  observe:
    vi.fn<typeof import("./node-worker-launch-observation.js").observeNodeWorkerChildOutput>(),
  prepare:
    vi.fn<typeof import("./node-worker-launch-transport.js").prepareNodeWorkerLaunchTransport>(),
  start: vi.fn<typeof import("./node-worker-launch-transport.js").startNodeWorkerLaunchTransport>(),
  send: vi.fn<typeof import("./node-worker-launch-transport.js").sendNodeWorkerInput>(),
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
    drain = mocks.drain;
  },
}));
vi.mock("./node-worker-turn-store.js", () => ({
  NodeWorkerTurnStore: class {
    claim = mocks.turnClaim;
    get = mocks.turnGet;
    getMatching = mocks.turnMatching;
    finish = mocks.turnFinish;
    drain = mocks.drain;
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
  },
}));
vi.mock("./node-worker-process-identity.js", () => ({
  requireNodeWorkerProcessIdentity: () => ({ pid: 101, startTime: 1 }),
  inspectNodeWorkerProcessIdentity: () => "live",
}));
vi.mock("./node-worker-tree-control.js", () => {
  const unexpected = () => {
    throw new Error("Process-tree control is outside this pure fixture");
  };
  return {
    inspectOwnedNodeWorkerTree: unexpected,
    signalOwnedNodeWorkerTree: unexpected,
    waitForOwnedNodeWorkerTreeDeath: unexpected,
  };
});
vi.mock("./node-worker-launch-observation.js", () => ({
  observeNodeWorkerChildOutput: mocks.observe,
}));
vi.mock("./node-worker-launch-transport.js", () => ({
  prepareNodeWorkerLaunchTransport: mocks.prepare,
  startNodeWorkerLaunchTransport: mocks.start,
  sendNodeWorkerInput: mocks.send,
}));

afterEach(() => vi.resetAllMocks());

async function fixture(unknownOutcome = false) {
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
  mocks.turnGet.mockImplementation(async () => currentTurn());
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
    consumeStdout: async () => {
      throw new Error("Output belongs to the pure observation collaborator");
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
    container: { engine: "docker", containerId: "a".repeat(64), engineTarget: "synthetic-daemon" },
  });
  mocks.start.mockResolvedValue(undefined);
  mocks.send.mockRejectedValue(new Error("Synthetic child input is closed"));
  mocks.observe.mockImplementation(
    async (
      active: Parameters<
        typeof import("./node-worker-launch-observation.js").observeNodeWorkerChildOutput
      >[0] &
        Pick<NodeWorkerRunningChild, "turn">,
      onResult,
    ) => {
      if (!active.turn) {
        throw new Error("Synthetic observation has no admitted turn");
      }
      void active.turn.done.then(() => {
        turnSettled = true;
      });
      await emitResult.promise;
      await active.journalReady;
      try {
        await onResult({
          type: "result",
          turnId: identity.launchId,
          result: { status: "completed", transcriptLeafId: "leaf", transcriptNextSeq: 2 },
          retainWorker: true,
        });
      } catch {
        return { state: "failed", errorText: "Synthetic result persistence failed" };
      }
      await exited.promise;
      return { state: active.stopState ?? "completed" };
    },
  );
  const supervisor = createNodeWorkerSupervisor({
    bundleRoot: "/synthetic/bundles",
    env: { OPENCLAW_STATE_DIR: "/synthetic/state", NODE_DISABLE_COMPILE_CACHE: "1" },
    capacity: 1,
    containerEngine: { id: "docker", command: "synthetic-container", target: "synthetic-daemon" },
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

describe("node worker persistence settlement lifetime", () => {
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

  it.each(["during persistence", "after failed cleanup"] as const)(
    "retries owned container cleanup when cancellation starts %s",
    async (timing) => {
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
        expect(await retry).toMatchObject({ state: "failed" });
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
