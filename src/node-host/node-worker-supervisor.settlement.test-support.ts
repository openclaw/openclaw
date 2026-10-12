import { vi } from "vitest";
import { WORKER_PUBLIC_INGRESS_PATH } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { toErrorObject } from "../infra/errors.js";
import { nodeWorkerTurnMatchesIdentity } from "../worker/node-supervisor-protocol.js";
import type { NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import type { NodeWorkerChildAdapter } from "./node-worker-launch-transport.js";
import type { NodeWorkerRunningChild } from "./node-worker-supervisor-ownership.js";
import {
  NodeWorkerCapacity,
  NodeWorkerContainerLifecycle,
  NodeWorkerJournalWorker,
  NodeWorkerLaunchStore,
  createNodeWorkerLaunchRecovery,
  createNodeWorkerSupervisor,
  mocks,
} from "./node-worker-supervisor.mock.test-support.js";
import {
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";
import type { NodeWorkerTurnReceipt } from "./node-worker-turn-store.js";

export async function fixture(
  unknownOutcome = false,
  admission?: { entered: () => void; ready: Promise<void> },
) {
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
    admission?.entered();
    await admission?.ready;
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
  mocks.send
    .mockRejectedValue(new Error("Synthetic child input is closed"))
    .mockResolvedValueOnce(undefined);
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
  const launching = supervisor
    .launch(input, {
      kind: "websocket",
      url: `wss://gateway.example.invalid${WORKER_PUBLIC_INGRESS_PATH}`,
    })
    .then((receipt) => {
      mocks.send.mockClear();
      return receipt;
    });
  if (!admission) {
    await launching;
  }
  return {
    supervisor,
    launching,
    identity,
    persistence,
    entered,
    emitResult,
    firstRemoval,
    removalEntered,
    retryRemoval,
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

export function recoveryFixture(container = false) {
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
  const finish: InstanceType<typeof NodeWorkerLaunchStore>["finish"] = async (params) => {
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
