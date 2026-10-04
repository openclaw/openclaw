import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NODE_WORKER_IDLE_RETENTION_PROTOCOL_FEATURE } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { NodeWorkerCapacitySnapshot } from "../infra/node-runner-inventory.js";
import { nodeWorkerTurnMatchesIdentity } from "../worker/node-supervisor-protocol.js";
import type { WorkerProcessMessage } from "../worker/worker-process-protocol.js";
import type { NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import type { NodeWorkerChildAdapter } from "./node-worker-launch-transport.js";
import { createNodeWorkerSupervisor, mocks } from "./node-worker-supervisor.mock.test-support.js";
import {
  TEST_WORKER_ENDPOINT,
  testNodeWorkerEnvironmentIdentity,
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";
import type { NodeWorkerTurnReceipt } from "./node-worker-turn-store.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

function input(turnId: string, environmentId = "environment-1") {
  const value = testWorkerLaunchInput("/synthetic/workspace", turnId);
  value.idleRetention = true;
  value.descriptor.admission.environmentId = environmentId;
  return value;
}

function fixture(capacity = 1, container = false) {
  const launches = new Map<string, NodeWorkerLaunchReceipt>();
  const turns = new Map<string, NodeWorkerTurnReceipt>();
  const snapshots: NodeWorkerCapacitySnapshot[] = [];
  const children = new Map<string, ReturnType<typeof child>>();
  const nonterminal = () =>
    [...launches.values()].filter((row) => row.state === "pending" || row.state === "running");
  const requireLaunch = (id: string) => {
    const row = launches.get(id);
    if (!row) {
      throw new Error(`Missing synthetic launch ${id}`);
    }
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
    if (!row) {
      throw new Error("Missing synthetic turn");
    }
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
        if (!onMessage) {
          throw new Error("Child observation has not started");
        }
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
    if (!owner) {
      throw new Error("Missing synthetic child");
    }
    return owner.observe(active, receive);
  });
  const supervisor = createNodeWorkerSupervisor({
    bundleRoot: "/synthetic/bundles",
    env: { OPENCLAW_STATE_DIR: "/synthetic/state" },
    capacity,
    onCapacityChanged: (snapshot) => snapshots.push(snapshot),
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
    snapshots,
    launches,
    children,
    async launch(value: ReturnType<typeof input>) {
      const receipt = await supervisor.launch(value, TEST_WORKER_ENDPOINT);
      const owner = children.get(value.launchId);
      if (!owner) {
        throw new Error("Missing newly admitted child");
      }
      return { ...owner, receipt };
    },
  };
}

describe("node worker idle retention", () => {
  it("routes process observations after turn settlement and fences stale or retired owners", async () => {
    const f = fixture();
    try {
      const value = input("process-owner");
      const owner = await f.launch(value);
      await owner.complete(value.launchId, "background");
      const target = {
        ...testNodeWorkerEnvironmentIdentity(value),
        placementGeneration: value.placementGeneration,
        expectedBundleHash: value.expectedBundleHash,
        operation: { action: "list" as const },
      };
      mocks.send.mockClear();
      await expect(
        f.supervisor.observeProcesses({ ...target, ownerEpoch: target.ownerEpoch + 1 }),
      ).rejects.toThrow("owner changed");
      await expect(
        f.supervisor.observeProcesses({ ...target, expectedBundleHash: "b".repeat(64) }),
      ).rejects.toThrow("owner changed");
      expect(mocks.send).not.toHaveBeenCalled();
      const list = { sessionId: target.sessionId, processes: [], truncated: false };
      mocks.send.mockImplementationOnce(async (adapter, message) => {
        expect(adapter).toBe(owner.adapter);
        if (message.type !== "process") {
          throw new Error("Expected process request");
        }
        await owner.emit({ type: "process-result", requestId: message.requestId, result: list });
      });
      await expect(f.supervisor.observeProcesses(target)).resolves.toEqual(list);
      expect((await f.supervisor.status(value.launchId))?.state).toBe("completed");
      const dispatched = createDeferred();
      mocks.send.mockImplementationOnce(async () => {
        dispatched.resolve();
      });
      const pending = f.supervisor.observeProcesses(target);
      const rejected = expect(pending).rejects.toThrow(/owner ended|owner changed/);
      await dispatched.promise;
      await f.supervisor.close();
      await rejected;
    } finally {
      await f.supervisor.close();
    }
  });

  it.each(["completed", "failed", "closed", "aborted"] as const)(
    "releases prepared workspace custody when public launch is %s",
    async (outcome) => {
      const f = fixture();
      const lease = {
        workspaceDir: "/synthetic/workspace",
        homeDir: "/synthetic/home",
        release: vi.fn(),
      };
      const acquired = createDeferred<typeof lease>();
      const started = createDeferred();
      const startup = createDeferred();
      const controller = new AbortController();
      const failure = new Error("Synthetic admission failure");
      let closing: Promise<void> | undefined;
      mocks.acquirePreparedWorkspace.mockReturnValueOnce(acquired.promise);
      mocks.send.mockImplementationOnce(async () => {
        started.resolve();
        await startup.promise;
      });
      if (outcome === "failed") {
        mocks.launchClaim.mockRejectedValueOnce(failure);
      }
      const pending = f.supervisor.launch(
        input("prepared"),
        TEST_WORKER_ENDPOINT,
        controller.signal,
      );
      const settled = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(mocks.prepare).not.toHaveBeenCalled();
        if (outcome === "closed") {
          closing = f.supervisor.close();
        }
        if (outcome === "aborted") {
          controller.abort(failure);
        }
        acquired.resolve(lease);
        if (outcome === "completed") {
          await started.promise;
          expect(lease.release).not.toHaveBeenCalled();
          expect(mocks.prepare).toHaveBeenCalledWith(
            expect.objectContaining({
              workerEnv: expect.objectContaining({ HOME: lease.homeDir }),
            }),
          );
          startup.resolve();
          expect(await settled).toMatchObject({
            value: { launchId: "prepared", state: "running" },
          });
        } else if (outcome === "closed") {
          expect(await settled).toMatchObject({
            error: { message: "node worker supervisor is closed" },
          });
        } else {
          expect(await settled).toEqual({ error: failure });
        }
        await closing;
        expect(lease.release).toHaveBeenCalledOnce();
        expect(mocks.prepare).toHaveBeenCalledTimes(outcome === "completed" ? 1 : 0);
      } finally {
        acquired.resolve(lease);
        startup.resolve();
        await pending.catch(() => undefined);
        await f.supervisor.close();
      }
    },
  );

  it("reuses the physical child with fresh turn authority and clears its old expiry", async () => {
    const f = fixture();
    try {
      const first = input("first");
      const owner = await f.launch(first);
      await owner.complete(first.launchId, "idle");
      expect(f.snapshots.at(-1)).toEqual({ total: 1, available: 0, reclaimableIdle: 1 });
      expect(await f.supervisor.hasActiveWork()).toBe(false);
      await vi.advanceTimersByTimeAsync(119_999);
      const next = input("second");
      next.descriptor.admission.credential = "fresh-turn-credential";
      next.descriptor.assignment.agentRuntimeIdentityToken = "fresh-runtime-authority";
      next.descriptor.assignment.prompt = "fresh prompt";
      expect(await f.supervisor.launch(next, TEST_WORKER_ENDPOINT)).toMatchObject({
        worker: owner.receipt.worker,
      });
      expect(mocks.prepare).toHaveBeenCalledTimes(1);
      expect(mocks.send).toHaveBeenCalledWith(owner.adapter, {
        type: "turn",
        turnId: next.launchId,
        idleRetention: true,
        descriptor: { ...next.descriptor, connectionEndpoint: TEST_WORKER_ENDPOINT },
      });
      expect(f.snapshots.at(-1)).toEqual({ total: 1, available: 0, reclaimableIdle: 0 });
      expect(await f.supervisor.hasActiveWork()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(owner.adapter.kill).not.toHaveBeenCalled();
      await owner.complete(next.launchId, "idle");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(owner.adapter.dispose).toHaveBeenCalledOnce();
      expect(f.snapshots.at(-1)).toEqual({ total: 1, available: 1, reclaimableIdle: 0 });
    } finally {
      await f.supervisor.close();
    }
  });

  it("publishes idle only after settlement and starts TTL at background idle-ready", async () => {
    const f = fixture();
    const release = createDeferred();
    try {
      const value = input("background");
      const owner = await f.launch(value);
      const finish = mocks.turnFinish.getMockImplementation()!;
      const entered = createDeferred();
      mocks.turnFinish.mockImplementationOnce(async (params) => {
        entered.resolve();
        await release.promise;
        return finish(params);
      });
      const completing = owner.complete(value.launchId, "background");
      await entered.promise;
      expect(await f.supervisor.hasActiveWork()).toBe(true);
      expect(f.snapshots.at(-1)?.reclaimableIdle ?? 0).toBe(0);
      release.resolve();
      await completing;
      await vi.advanceTimersByTimeAsync(240_000);
      expect(owner.adapter.kill).not.toHaveBeenCalled();
      expect(await f.supervisor.hasActiveWork()).toBe(true);
      await owner.emit({ type: "idle-ready", turnId: "stale-turn" });
      expect(f.snapshots.at(-1)?.reclaimableIdle ?? 0).toBe(0);
      await owner.emit({ type: "idle-ready", turnId: value.launchId });
      expect(await f.supervisor.hasActiveWork()).toBe(false);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(owner.adapter.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(owner.adapter.dispose).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await f.supervisor.close();
    }
  });

  it.each(["before", "at"] as const)(
    "settles idle cleanup %s the admission deadline",
    async (timing) => {
      const f = fixture();
      const cleanup = createDeferred();
      try {
        const old = input("old", "old-environment");
        const owner = await f.launch(old);
        await owner.complete(old.launchId, "idle");
        if (timing === "before") {
          await vi.advanceTimersByTimeAsync(119_999);
        }
        owner.holdCleanup(cleanup.promise);
        const replacement = f.supervisor
          .launch(input("replacement", "new-environment"), TEST_WORKER_ENDPOINT)
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
        await owner.killed.promise;
        expect(mocks.prepare).toHaveBeenCalledTimes(1);
        expect(f.snapshots.at(-1)).toEqual({ total: 1, available: 0, reclaimableIdle: 0 });
        if (timing === "before") {
          await vi.advanceTimersByTimeAsync(9_999);
          expect(owner.adapter.kill).toHaveBeenCalledTimes(2);
          expect(mocks.prepare).toHaveBeenCalledTimes(1);
        } else {
          // Move wall time to the boundary without firing the deadline callback.
          vi.setSystemTime(10_000);
        }
        cleanup.resolve();
        if (timing === "before") {
          expect(await replacement).toMatchObject({
            value: { launchId: "replacement", state: "running" },
          });
          expect(mocks.prepare).toHaveBeenCalledTimes(2);
        } else {
          expect(await replacement).toEqual({
            error: expect.objectContaining({
              name: "NodeWorkerCapacityExhaustedError",
              message: "node worker capacity remained full for 10000 ms",
            }),
          });
          expect(owner.adapter.kill).toHaveBeenCalledOnce();
          expect(f.launches.get("old")?.state).toBe("interrupted");
          expect(f.launches.has("replacement")).toBe(false);
          expect(mocks.prepare).toHaveBeenCalledTimes(1);
          expect(f.snapshots.at(-1)).toEqual({ total: 1, available: 1, reclaimableIdle: 0 });
          expect(vi.getTimerCount()).toBe(0);
        }
        expect(owner.adapter.dispose).toHaveBeenCalledOnce();
      } finally {
        cleanup.resolve();
        await f.supervisor.close();
      }
    },
  );

  it.each(["deadline", "abort", "close"] as const)(
    "bounds admission by %s while retaining stalled idle cleanup",
    async (boundary) => {
      const f = fixture();
      const cleanup = createDeferred();
      const controller = new AbortController();
      const failure = new Error("Caller cancelled capacity admission");
      const outcomes: unknown[] = [];
      let admitted: Promise<void> | undefined;
      let closing: Promise<void> | undefined;
      try {
        const owner = await f.launch(input("old", "old-environment"));
        await owner.complete("old", "idle");
        owner.holdCleanup(cleanup.promise);
        admitted = f.supervisor
          .launch(input("replacement", "new-environment"), TEST_WORKER_ENDPOINT, controller.signal)
          .then(
            (value) => {
              outcomes.push({ value });
            },
            (error: unknown) => {
              outcomes.push({ error });
            },
          );
        await owner.killed.promise;
        if (boundary === "deadline") {
          await vi.advanceTimersByTimeAsync(9_999);
          expect(outcomes).toEqual([]);
          await vi.advanceTimersByTimeAsync(1);
        } else if (boundary === "abort") {
          controller.abort(failure);
        } else {
          closing = f.supervisor.close();
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(outcomes).toEqual([
          {
            error:
              boundary === "abort"
                ? failure
                : expect.objectContaining({
                    message:
                      boundary === "deadline"
                        ? "node worker capacity remained full for 10000 ms"
                        : "node worker supervisor is closed",
                  }),
          },
        ]);
        expect(mocks.prepare).toHaveBeenCalledTimes(1);
        expect(f.launches.get("old")?.state).toBe("running");
        expect(f.launches.has("replacement")).toBe(false);
        expect(f.snapshots.at(-1)).toEqual({ total: 1, available: 0, reclaimableIdle: 0 });
        let closed = false;
        closing = (closing ?? f.supervisor.close()).then(() => {
          closed = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(closed).toBe(false);
        cleanup.resolve();
        await closing;
        expect(f.snapshots.at(-1)).toEqual({ total: 1, available: 1, reclaimableIdle: 0 });
        expect(mocks.prepare).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        cleanup.resolve();
        await admitted;
        await (closing ?? f.supervisor.close());
      }
    },
  );

  it("rejects reuse when idle expiry revokes the owner during turn admission", async () => {
    const f = fixture();
    const release = createDeferred();
    try {
      const owner = await f.launch(input("first"));
      await owner.complete("first", "idle");
      mocks.send.mockClear();
      await vi.advanceTimersByTimeAsync(119_999);
      const claim = mocks.turnClaim.getMockImplementation()!;
      const entered = createDeferred();
      mocks.turnClaim.mockImplementationOnce(async (params, authority) => {
        entered.resolve();
        await release.promise;
        return claim(params, authority);
      });
      const rejection = expect(
        f.supervisor.launch(input("expired-reuse"), TEST_WORKER_ENDPOINT),
      ).rejects.toThrow("lost its physical owner before admission");
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1);
      expect(owner.adapter.dispose).toHaveBeenCalledOnce();
      release.resolve();
      await rejection;
      expect(mocks.send).not.toHaveBeenCalled();
      expect(await f.supervisor.status("expired-reuse")).toBeUndefined();
      expect(f.snapshots.at(-1)).toEqual({ total: 1, available: 1, reclaimableIdle: 0 });
    } finally {
      release.resolve();
      await f.supervisor.close();
    }
  });

  it("retains at most two idle children and reclaims the least recently used, never background", async () => {
    const f = fixture(4);
    try {
      const background = await f.launch(input("background", "background-env"));
      await background.complete("background", "background");
      const a = await f.launch(input("a", "a-env"));
      await a.complete("a", "idle");
      await vi.advanceTimersByTimeAsync(1);
      const b = await f.launch(input("b", "b-env"));
      await b.complete("b", "idle");
      await vi.advanceTimersByTimeAsync(1);
      await f.supervisor.launch(input("a-next", "a-env"), TEST_WORKER_ENDPOINT);
      await a.complete("a-next", "idle");
      await vi.advanceTimersByTimeAsync(1);
      const c = await f.launch(input("c", "c-env"));
      await c.complete("c", "idle");
      await vi.advanceTimersByTimeAsync(0);
      expect(b.adapter.dispose).toHaveBeenCalledOnce();
      expect(a.adapter.kill).not.toHaveBeenCalled();
      expect(c.adapter.kill).not.toHaveBeenCalled();
      expect(background.adapter.kill).not.toHaveBeenCalled();
      expect(f.snapshots.at(-1)).toEqual({ total: 4, available: 1, reclaimableIdle: 2 });
    } finally {
      await f.supervisor.close();
    }
  });

  it.each(["stop", "disconnect", "close"] as const)(
    "%s retires idle through physical cleanup and preserves the completed turn",
    async (operation) => {
      const f = fixture();
      try {
        const value = input("completed");
        const owner = await f.launch(value);
        await owner.complete(value.launchId, "idle");
        const identity = testNodeWorkerEnvironmentIdentity(value);
        await f.supervisor.stopEnvironment({ ...identity, ownerEpoch: identity.ownerEpoch - 1 });
        expect(owner.adapter.kill).not.toHaveBeenCalled();
        if (operation === "stop") {
          await f.supervisor.stopEnvironment(identity);
        } else if (operation === "disconnect") {
          await f.supervisor.retireIdle();
        } else {
          await f.supervisor.close();
        }
        expect(owner.adapter.dispose).toHaveBeenCalledOnce();
        expect(await f.supervisor.status(value.launchId)).toMatchObject({ state: "completed" });
        expect(await f.supervisor.hasActiveWork()).toBe(false);
      } finally {
        await f.supervisor.close();
      }
    },
  );

  it("disconnect invalidates pending idle acknowledgments without evicting background work", async () => {
    const f = fixture(2);
    try {
      const current = await f.launch(input("current", "current-env"));
      const background = await f.launch(input("background", "background-env"));
      await background.complete("background", "background");
      await f.supervisor.retireIdle();
      expect(background.adapter.kill).not.toHaveBeenCalled();
      expect(current.adapter.kill).not.toHaveBeenCalled();
      await current.complete("current", "idle");
      await background.emit({ type: "idle-ready", turnId: "background" });
      await vi.advanceTimersByTimeAsync(0);
      expect(current.adapter.dispose).toHaveBeenCalledOnce();
      expect(background.adapter.dispose).toHaveBeenCalledOnce();
    } finally {
      await f.supervisor.close();
    }
  });

  it.each(["explicit", "expiry", "limit"] as const)(
    "retries failed %s idle cleanup without freeing its slot or evicting background work",
    async (trigger) => {
      const capacity = trigger === "limit" ? 4 : 2;
      const f = fixture(capacity, true);
      try {
        const background = await f.launch(input("background", "background-env"));
        await background.complete("background", "background");
        const idle = await f.launch(input("idle", "idle-env"));
        await idle.complete("idle", "idle");
        mocks.remove.mockRejectedValueOnce(new Error("Synthetic container removal failure"));

        if (trigger === "explicit") {
          await expect(f.supervisor.retireIdle()).rejects.toThrow(
            "node worker idle cleanup failed",
          );
        } else if (trigger === "expiry") {
          await vi.advanceTimersByTimeAsync(120_000);
        } else {
          for (const turnId of ["second-idle", "third-idle"]) {
            const child = await f.launch(input(turnId, turnId));
            await child.complete(turnId, "idle");
          }
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(f.snapshots.at(-1)).toEqual({
          total: capacity,
          available: 0,
          reclaimableIdle: capacity - 2,
        });
        expect(f.launches.get("idle")).toMatchObject({
          state: "running",
          container: idle.receipt.container,
        });
        expect(idle.adapter.kill).not.toHaveBeenCalled();
        expect(background.adapter.kill).not.toHaveBeenCalled();
        expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(
          idle.receipt.container,
          expect.objectContaining({ launchId: "idle" }),
        );

        if (trigger === "explicit") {
          await f.supervisor.retireIdle();
        } else {
          await vi.advanceTimersByTimeAsync(120_000);
        }
        expect(
          mocks.remove.mock.calls.filter(([, owner]) => owner.launchId === "idle"),
        ).toHaveLength(2);
        expect(idle.adapter.dispose).toHaveBeenCalledOnce();
        expect(background.adapter.kill).not.toHaveBeenCalled();
        expect(f.snapshots.at(-1)).toEqual({
          total: capacity,
          available: capacity - 1,
          reclaimableIdle: 0,
        });
        expect(await f.supervisor.status("idle")).toMatchObject({ state: "completed" });
      } finally {
        await f.supervisor.close();
      }
    },
  );

  it.each(["old-gateway", "old-bundle"] as const)(
    "keeps %s retention background-only and preserves the old managed turn shape",
    async (compatibility) => {
      const f = fixture();
      try {
        const value = input("legacy");
        if (compatibility === "old-gateway") {
          delete value.idleRetention;
        } else {
          value.descriptor.admission.handshake.protocolFeatures =
            value.descriptor.admission.handshake.protocolFeatures.filter(
              (feature) => feature !== NODE_WORKER_IDLE_RETENTION_PROTOCOL_FEATURE,
            );
        }
        const owner = await f.launch(value);
        expect(mocks.send).toHaveBeenCalledWith(owner.adapter, {
          type: "turn",
          turnId: value.launchId,
          descriptor: { ...value.descriptor, connectionEndpoint: TEST_WORKER_ENDPOINT },
        });
        await owner.complete(value.launchId);
        await vi.advanceTimersByTimeAsync(240_000);
        expect(owner.adapter.kill).not.toHaveBeenCalled();
        expect(await f.supervisor.hasActiveWork()).toBe(true);
        expect(f.snapshots.every((snapshot) => !Object.hasOwn(snapshot, "reclaimableIdle"))).toBe(
          true,
        );
        const next = {
          ...value,
          launchId: "legacy-next",
          descriptor: structuredClone(value.descriptor),
        };
        next.descriptor.assignment.turnId = next.launchId;
        await f.supervisor.launch(next, TEST_WORKER_ENDPOINT);
        expect(mocks.send).toHaveBeenCalledWith(owner.adapter, {
          type: "turn",
          turnId: next.launchId,
          descriptor: { ...next.descriptor, connectionEndpoint: TEST_WORKER_ENDPOINT },
        });
        expect(
          await f.supervisor.cancel({ ...testNodeWorkerLaunchIdentity(value), ownerEpoch: 0 }),
        ).toBeUndefined();
        expect(owner.adapter.kill).not.toHaveBeenCalled();
      } finally {
        await f.supervisor.close();
      }
    },
  );
});
