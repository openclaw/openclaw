import assert from "node:assert/strict";
import { expect, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { NodeWorkerCapacitySnapshot } from "../infra/node-runner-inventory.js";
import { nodeWorkerTurnMatchesIdentity } from "../worker/node-supervisor-protocol.js";
import type { WorkerProcessMessage } from "../worker/worker-process-protocol.js";
import type { NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import type { NodeWorkerChildAdapter } from "./node-worker-launch-transport.js";
import type { NodeWorkerMcpSession } from "./node-worker-mcp.js";
import { createNodeWorkerSupervisor, mocks } from "./node-worker-supervisor.mock.test-support.js";
import {
  TEST_WORKER_ENDPOINT,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";
import type { NodeWorkerTurnReceipt } from "./node-worker-turn-store.js";

export function retainedTurn(turnId: string, environmentId = "environment-1") {
  const value = testWorkerLaunchInput("/synthetic/workspace", turnId);
  value.idleRetention = true;
  value.descriptor.admission.environmentId = environmentId;
  return value;
}

export function createRetainedWorkerFixture(
  capacity = 1,
  container = false,
  localMcp?: () => NodeWorkerMcpSession,
) {
  const launches = new Map<string, NodeWorkerLaunchReceipt>();
  const turns = new Map<string, NodeWorkerTurnReceipt>();
  const snapshots: NodeWorkerCapacitySnapshot[] = [];
  const processChanges = vi.fn();
  const children = new Map<string, ReturnType<typeof child>>();
  const nonterminal = () =>
    [...launches.values()].filter((row) => row.state === "pending" || row.state === "running");
  const requireLaunch = (id: string) => {
    const row = launches.get(id);
    assert(row, `Missing synthetic launch ${id}`);
    return row;
  };
  const readTurn = (id: string) => {
    const row = turns.get(id);
    if (!row) {
      return undefined;
    }
    const owner = requireLaunch(row.ownerLaunchId);
    return {
      ...row,
      worker: owner.worker,
      supervisor: owner.supervisor,
      ...(owner.container ? { container: owner.container } : {}),
    };
  };
  mocks.inspectIdentity.mockReturnValue("live");
  mocks.launchPrune.mockResolvedValue(0);
  mocks.launchList.mockImplementation(async () => nonterminal());
  mocks.launchCount.mockImplementation(async () => nonterminal().length);
  mocks.launchGet.mockImplementation(async (id) => launches.get(id));
  mocks.launchMatching.mockImplementation(async (expected) => {
    const row = launches.get(expected.launchId);
    return row && nodeWorkerTurnMatchesIdentity(row, expected) ? row : undefined;
  });
  mocks.launchClaim.mockImplementation(async (claim, supervisor, limit, _now, authority) => {
    authority?.assertCurrent();
    const count = nonterminal().length;
    if (count >= limit) {
      return { action: "at-capacity", nonterminalCount: count };
    }
    const receipt: NodeWorkerLaunchReceipt = {
      ...claim,
      supervisor,
      worker: null,
      workerCleanupMode: null,
      workerLineageSettled: false,
      state: "pending",
      resultJson: null,
      errorText: null,
      completedAtMs: null,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    };
    launches.set(claim.launchId, receipt);
    return { action: "start", receipt, nonterminalCount: count + 1 };
  });
  mocks.launchRunning.mockImplementation(async (params) => {
    const receipt = {
      ...requireLaunch(params.launchId),
      worker: params.worker,
      state: "running" as const,
      ...(params.container ? { container: params.container } : {}),
    };
    launches.set(params.launchId, receipt);
    return receipt;
  });
  mocks.launchFinish.mockImplementation(async (params) => {
    const receipt = { ...requireLaunch(params.launchId), state: params.state };
    launches.set(params.launchId, receipt);
    for (const turn of turns.values()) {
      if (turn.ownerLaunchId === params.launchId && turn.state === "running") {
        turn.state = params.state === "completed" ? "interrupted" : params.state;
      }
    }
    return receipt;
  });
  mocks.turnClaim.mockImplementation(async ({ claim, ownerLaunchId }, authority) => {
    authority?.assertCurrent();
    const receipt: NodeWorkerTurnReceipt = {
      ...requireLaunch(ownerLaunchId),
      ...claim,
      ownerLaunchId,
      state: "running",
    };
    turns.set(claim.launchId, receipt);
    return { action: "start", receipt };
  });
  mocks.turnGet.mockImplementation(async (id) => readTurn(id));
  mocks.turnMatching.mockImplementation(async (expected) => {
    const row = readTurn(expected.launchId);
    return row && nodeWorkerTurnMatchesIdentity(row, expected) ? row : undefined;
  });
  mocks.turnFinish.mockImplementation(async (params) => {
    const row = readTurn(params.expected.launchId);
    assert(row, "Missing synthetic turn");
    const receipt = { ...row, state: params.state, resultJson: params.resultJson ?? null };
    turns.set(row.launchId, receipt);
    return receipt;
  });
  mocks.drain.mockResolvedValue(undefined);
  mocks.acquirePreparedWorkspace.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  function child() {
    const exited = createDeferred();
    const killed = createDeferred();
    let cleanup: Promise<void> = Promise.resolve();
    let onMessage: ((frame: WorkerProcessMessage) => Promise<void>) | undefined;
    const adapter: NodeWorkerChildAdapter = {
      pid: 200 + children.size,
      supportsRawOutput: true,
      onStdout: () => {},
      onStderr: () => {},
      onExit: () => {},
      onError: () => {},
      consumeStdout: async () => {},
      wait: async () => {
        await exited.promise;
        return { code: 0, signal: null };
      },
      kill: vi.fn(() => {
        killed.resolve();
        exited.resolve();
      }),
      dispose: vi.fn(),
    };
    return {
      adapter,
      killed,
      holdCleanup(promise: Promise<void>) {
        cleanup = promise;
      },
      observe: (
        active: Parameters<typeof mocks.observe>[0],
        receive: NonNullable<typeof onMessage>,
      ): ReturnType<typeof mocks.observe> => {
        onMessage = receive;
        return exited.promise.then(async () => {
          await cleanup;
          return {
            kind: "confirmed" as const,
            outcome: { state: active.stopState ?? "completed" },
          };
        });
      },
      async emit(frame: WorkerProcessMessage) {
        assert(onMessage, "Child observation has not started");
        await onMessage(frame);
      },
      complete(turnId: string, retention?: "idle" | "background") {
        return this.emit({
          type: "result",
          turnId,
          result: { status: "completed", transcriptLeafId: "leaf-1", transcriptNextSeq: 2 },
          retainWorker: true,
          ...(retention ? { retention } : {}),
        });
      },
    };
  }
  mocks.prepare.mockImplementation(async ({ input: launchInput }) => {
    const owner = child();
    children.set(launchInput.launchId, owner);
    return {
      kind: "started",
      adapter: owner.adapter,
      cleanupMode: null,
      ...(container
        ? {
            container: {
              engine: "docker" as const,
              containerId: String(children.size).padStart(64, "0"),
              engineTarget: "b".repeat(64),
            },
          }
        : {}),
    };
  });
  mocks.observe.mockImplementation((active, receive) => {
    const owner = [...children.values()].find((value) => value.adapter === active.adapter);
    assert(owner, "Missing synthetic child");
    return owner.observe(active, receive);
  });
  const supervisor = createNodeWorkerSupervisor({
    bundleRoot: "/synthetic/bundles",
    env: { OPENCLAW_STATE_DIR: "/synthetic/state" },
    capacity,
    onCapacityChanged: (snapshot) => snapshots.push(snapshot),
    onProcessesChanged: processChanges,
    ...(container
      ? {
          containerEngine: {
            id: "docker" as const,
            command: "synthetic-container",
            target: "b".repeat(64),
          },
        }
      : {}),
  });
  return {
    supervisor,
    [Symbol.asyncDispose]: () => supervisor.close(),
    snapshots,
    processChanges,
    expectCapacity(available: number, reclaimableIdle = 0) {
      expect(snapshots.at(-1)).toEqual({ total: capacity, available, reclaimableIdle });
    },
    launches,
    children,
    async launch(value: ReturnType<typeof retainedTurn>) {
      const receipt = await supervisor.launch(value, TEST_WORKER_ENDPOINT, undefined, localMcp?.());
      const owner = children.get(value.launchId);
      assert(owner, "Missing newly admitted child");
      return { ...owner, receipt };
    },
    async retained(
      value: ReturnType<typeof retainedTurn>,
      retention: "idle" | "background" = "idle",
    ) {
      const owner = await this.launch(value);
      await owner.complete(value.launchId, retention);
      return owner;
    },
  };
}
