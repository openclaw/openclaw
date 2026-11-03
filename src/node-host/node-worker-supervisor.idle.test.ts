import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NODE_WORKER_PROCESS_CHANGES_PROTOCOL_FEATURE } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { NodeWorkerMcpPolicy, type NodeWorkerMcpSession } from "./node-worker-mcp.js";
import {
  createRetainedWorkerFixture as fixture,
  retainedTurn as input,
} from "./node-worker-retained-child.test-support.js";
import { mocks } from "./node-worker-supervisor.mock.test-support.js";
import {
  TEST_WORKER_ENDPOINT,
  testNodeWorkerEnvironmentIdentity,
} from "./node-worker-supervisor.test-support.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

const fixtureMcpDescriptors = [
  {
    name: "fixture_lookup",
    description: "A fixture",
    command: "mcp.tools.call.v1",
    pluginId: "node-mcp",
    mcp: { server: "fixture", tool: "lookup" },
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
];

function barrier() {
  const deferred = createDeferred();
  return { ...deferred, [Symbol.dispose]: () => deferred.resolve() };
}

function settle<T>(pending: Promise<T>) {
  return pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe("node worker idle retention", () => {
  it.each([true, false])(
    "forwards retained owner changes without requiring a turn (supported=%s)",
    async (supported) => {
      await using f = fixture();
      const value = input("process-notifications");
      if (!supported) {
        value.descriptor.admission.handshake.protocolFeatures =
          value.descriptor.admission.handshake.protocolFeatures.filter(
            (feature) => feature !== NODE_WORKER_PROCESS_CHANGES_PROTOCOL_FEATURE,
          );
      }
      const owner = await f.retained(value, "background");
      expect(mocks.send.mock.calls[0]?.[1]).toMatchObject({
        type: "turn",
        ...(supported ? { processChanges: true } : {}),
      });
      if (!supported) {
        expect(mocks.send.mock.calls[0]?.[1]).not.toHaveProperty("processChanges");
      } else {
        await owner.emit({ type: "processes-changed" });
        expect(f.processChanges).toHaveBeenCalledExactlyOnceWith({
          environmentId: value.descriptor.admission.environmentId,
          sessionId: value.descriptor.admission.sessionId,
          ownerEpoch: value.descriptor.admission.ownerEpoch,
          placementGeneration: value.placementGeneration,
        });
      }
      await f.supervisor.close();
      expect(f.processChanges).toHaveBeenCalledTimes(supported ? 2 : 1);
      await owner.emit({ type: "processes-changed" });
      expect(f.processChanges).toHaveBeenCalledTimes(supported ? 2 : 1);
    },
  );

  it("calls only MCP handles granted to the current turn on a retained worker", async () => {
    const call = vi.fn<NodeWorkerMcpSession["callMcpTool"]>().mockResolvedValue({
      content: [{ type: "text", text: "result" }],
      structuredContent: { value: 42 },
      _meta: { private: "not part of the guest result" },
    });
    const signal = new AbortController().signal;
    await using f = fixture(1, false, () => ({
      callMcpTool: call,
      descriptors: fixtureMcpDescriptors,
      signal,
    }));
    const first = input("first-mcp-turn");
    first.descriptor.assignment.toolAuthority.mcpTools = [
      { id: "allowed", server: "fixture", tool: "lookup" },
    ];
    const owner = await f.launch(first);
    const request = {
      type: "mcp-call",
      turnId: first.launchId,
      requestId: "request-1",
      toolId: "allowed",
      arguments: { key: "chosen" },
    } as const;
    const reply = createDeferred();
    mocks.send.mockImplementationOnce(async (_adapter, result) => {
      expect(result).toEqual({
        type: "mcp-result",
        turnId: first.launchId,
        requestId: request.requestId,
        result: { content: [{ type: "text", text: "result" }], structuredContent: { value: 42 } },
      });
      reply.resolve();
    });
    await owner.emit(request);
    await reply.promise;
    await owner.emit(request);
    expect(call).toHaveBeenCalledExactlyOnceWith({
      server: "fixture",
      tool: "lookup",
      elicitationId: "allowed",
      arguments: { key: "chosen" },
      signal: expect.any(AbortSignal),
    });

    await owner.emit({ ...request, requestId: "malformed", arguments: { key: 123 } });
    expect(mocks.send).toHaveBeenLastCalledWith(
      owner.adapter,
      expect.objectContaining({
        requestId: "malformed",
        error: expect.stringContaining("invalid"),
      }),
    );
    expect(call).toHaveBeenCalledTimes(1);
    call.mockResolvedValueOnce({ content: [], structuredContent: [42] });
    await owner.emit({ ...request, requestId: "unsupported-result" });
    expect(mocks.send).toHaveBeenLastCalledWith(
      owner.adapter,
      expect.objectContaining({ requestId: "unsupported-result", error: expect.any(String) }),
    );
    const pending = createDeferred();
    call.mockImplementationOnce(async ({ signal: callSignal }) => {
      assert(callSignal);
      callSignal.addEventListener("abort", () => pending.resolve(), { once: true });
      await pending.promise;
      throw new Error("cancelled");
    });
    await owner.emit({ ...request, requestId: "blocked" });
    await owner.complete(first.launchId, "idle");
    await pending.promise;

    const second = input("next-mcp-turn");
    await f.supervisor.launch(second, TEST_WORKER_ENDPOINT);
    await owner.emit({ ...request, requestId: "late" });
    await owner.emit({ ...request, turnId: second.launchId, requestId: "ungranted" });
    expect(mocks.send).toHaveBeenLastCalledWith(owner.adapter, {
      type: "mcp-result",
      turnId: second.launchId,
      requestId: "ungranted",
      error: "Worker MCP execution is unavailable for this turn",
    });
    expect(call).toHaveBeenCalledTimes(3);
    await owner.complete(second.launchId);
  });

  it("revokes in-flight MCP calls on policy change without ending the worker turn", async () => {
    const policy = new NodeWorkerMcpPolicy();
    expect(policy.signal.aborted).toBe(true);
    policy.setAllowed(true);
    const aborted = createDeferred();
    const call = vi.fn<NodeWorkerMcpSession["callMcpTool"]>().mockResolvedValue({ content: [] });
    call.mockImplementationOnce(async ({ signal }) => {
      assert(signal);
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await aborted.promise;
      throw new Error("cancelled");
    });
    const session = () => ({
      callMcpTool: call,
      descriptors: fixtureMcpDescriptors,
      signal: policy.signal,
    });
    await using f = fixture(1, false, session);
    const first = input("policy-turn");
    const handles = [{ id: "allowed", server: "fixture", tool: "lookup" }];
    first.descriptor.assignment.toolAuthority.mcpTools = handles;
    const owner = await f.launch(first);
    const request = {
      type: "mcp-call",
      turnId: first.launchId,
      requestId: "in-flight",
      toolId: "allowed",
      arguments: { key: "example" },
    } as const;
    await owner.emit(request);
    expect(call).toHaveBeenCalledOnce();
    policy.setAllowed(false);
    await aborted.promise;
    await owner.emit({ ...request, requestId: "while-denied" });
    policy.setAllowed(true);
    await owner.emit({ ...request, requestId: "after-allow" });
    expect(call).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(
      owner.adapter,
      expect.objectContaining({ requestId: "after-allow", error: expect.any(String) }),
    );
    await owner.complete(first.launchId, "idle");

    const fresh = input("fresh-turn");
    fresh.descriptor.assignment.toolAuthority.mcpTools = handles;
    await f.supervisor.launch(fresh, TEST_WORKER_ENDPOINT, undefined, session());
    await owner.emit({ ...request, turnId: fresh.launchId });
    expect(call).toHaveBeenCalledTimes(2);
    await owner.complete(fresh.launchId);
  });

  it.each(["new", "retained"] as const)(
    "keeps the original MCP grant while a %s child waits for workspace admission",
    async (kind) => {
      await using f = fixture();
      const previous = input("previous");
      const retained = kind === "retained" ? await f.retained(previous) : undefined;
      const policy = new NodeWorkerMcpPolicy();
      policy.setAllowed(true);
      const callMcpTool = vi.fn<NodeWorkerMcpSession["callMcpTool"]>();
      const turn = input("queued");
      turn.descriptor.assignment.toolAuthority.mcpTools = [
        { id: "allowed", server: "fixture", tool: "lookup" },
      ];
      const gate = createEnteredGate();
      mocks.acquirePreparedWorkspace.mockImplementationOnce(async () => {
        await gate.wait();
        return undefined;
      });
      const pending = f.supervisor.launch(turn, TEST_WORKER_ENDPOINT, undefined, {
        signal: policy.signal,
        callMcpTool,
        descriptors: fixtureMcpDescriptors,
      });
      try {
        await awaitGateBeforeSettlement(gate.entered, pending, "Workspace admission did not start");
        policy.setAllowed(false);
        policy.setAllowed(true);
      } finally {
        gate.release();
      }
      await pending;
      const owner = retained ?? f.children.get(turn.launchId);
      assert(owner);
      await owner.emit({
        type: "mcp-call",
        turnId: turn.launchId,
        requestId: "stale",
        toolId: "allowed",
        arguments: { key: "example" },
      });
      expect(mocks.send).toHaveBeenLastCalledWith(
        owner.adapter,
        expect.objectContaining({
          requestId: "stale",
          error: "Worker MCP tool is unavailable for this turn",
        }),
      );
      expect(callMcpTool).not.toHaveBeenCalled();
      await owner.complete(turn.launchId);
    },
  );

  it("routes process observations after turn settlement and fences stale or retired owners", async () => {
    await using f = fixture();
    const value = input("process-owner");
    const owner = await f.retained(value, "background");
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
  });

  it("returns an empty process list after physical worker retirement is reconciled", async () => {
    await using f = fixture();
    const value = input("retired-process-owner");
    const owner = await f.launch(value);
    const target = {
      ...testNodeWorkerEnvironmentIdentity(value),
      placementGeneration: value.placementGeneration,
      expectedBundleHash: value.expectedBundleHash,
      operation: { action: "list" as const },
    };
    const observe = async () => f.supervisor.observeProcesses(target);
    await owner.emit({
      type: "result",
      turnId: value.launchId,
      result: { status: "completed", transcriptLeafId: "leaf-1", transcriptNextSeq: 2 },
      retainWorker: false,
    });
    await expect(observe()).rejects.toThrow(/owner changed|unavailable/);
    const finish = mocks.launchFinish.getMockImplementation();
    assert(finish, "Missing synthetic launch settlement");
    const terminal = createEnteredGate();
    mocks.launchFinish.mockImplementationOnce(async (...args) => {
      await terminal.wait();
      return finish(...args);
    });
    owner.adapter.kill("SIGTERM");
    try {
      await terminal.entered;
      await expect(observe()).rejects.toThrow(/owner changed|unavailable/);
    } finally {
      terminal.release();
    }
    expect((await f.supervisor.status(value.launchId))?.state).toBe("completed");
    await expect(observe()).resolves.toEqual({
      sessionId: target.sessionId,
      processes: [],
      truncated: false,
    });
    await expect(
      f.supervisor.observeProcesses({
        ...target,
        operation: { action: "stop", processId: "old-process", instanceId: "old-instance" },
      }),
    ).rejects.toThrow("unavailable");
  });

  it.each(["same environment", "other environment", "other gateway"] as const)(
    "checks unresolved launch ownership for %s before returning an empty process list",
    async (scope) => {
      await using f = fixture();
      const value = input("durable-process-owner");
      await f.retained(value);
      const identity = testNodeWorkerEnvironmentIdentity(value);
      await f.supervisor.stopEnvironment(identity);
      const terminal = f.launches.get(value.launchId);
      assert(terminal, "Missing synthetic terminal launch");
      f.launches.set(value.launchId, {
        ...terminal,
        state: "running",
        sessionId: "other-session",
        ...(scope === "other environment" ? { environmentId: "other-environment" } : {}),
        ...(scope === "other gateway" ? { gatewayNamespace: "other-gateway" } : {}),
      });
      try {
        const pending = f.supervisor.observeProcesses({
          ...identity,
          placementGeneration: value.placementGeneration,
          expectedBundleHash: value.expectedBundleHash,
          operation: { action: "list" },
        });
        if (scope === "same environment") {
          await expect(pending).rejects.toThrow("unavailable");
        } else {
          await expect(pending).resolves.toEqual({
            sessionId: identity.sessionId,
            processes: [],
            truncated: false,
          });
        }
      } finally {
        f.launches.set(value.launchId, terminal);
      }
    },
  );

  it.each(["environment stop", "supervisor close", "request abort"] as const)(
    "rejects an empty process observation after %s during journal lookup",
    async (retirement) => {
      await using f = fixture();
      await f.supervisor.initialize();
      const value = input("empty-process-owner");
      const identity = testNodeWorkerEnvironmentIdentity(value);
      const controller = new AbortController();
      const lookup = createEnteredGate();
      mocks.launchList.mockImplementationOnce(async () => {
        await lookup.wait();
        return [];
      });
      const pending = Promise.resolve().then(() =>
        f.supervisor.observeProcesses(
          {
            ...identity,
            placementGeneration: value.placementGeneration,
            expectedBundleHash: value.expectedBundleHash,
            operation: { action: "list" },
          },
          controller.signal,
        ),
      );
      try {
        await awaitGateBeforeSettlement(lookup.entered, pending, "Journal lookup did not start");
        if (retirement === "environment stop") {
          await f.supervisor.stopEnvironment(identity);
        } else if (retirement === "supervisor close") {
          await f.supervisor.close();
        } else {
          controller.abort(new Error("Synthetic observation aborted"));
        }
        lookup.release();
        await expect(pending).rejects.toThrow(/retired|unavailable|aborted/);
      } finally {
        lookup.release();
        await pending.catch(() => undefined);
      }
    },
  );

  it.each(["completed", "closed", "aborted"] as const)(
    "releases prepared workspace custody when public launch is %s",
    async (outcome) => {
      await using f = fixture();
      const lease = {
        workspaceDir: "/synthetic/workspace",
        homeDir: "/synthetic/home",
        release: vi.fn(),
      };
      const acquired = createDeferred<typeof lease>();
      const startupGate = createEnteredGate();
      const controller = new AbortController();
      const failure = new Error("Synthetic admission failure");
      let closing: Promise<void> | undefined;
      mocks.acquirePreparedWorkspace.mockReturnValueOnce(acquired.promise);
      mocks.send.mockImplementationOnce(startupGate.wait);
      const pending = f.supervisor.launch(
        input("prepared"),
        TEST_WORKER_ENDPOINT,
        controller.signal,
      );
      const settled = settle(pending);
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
          await startupGate.entered;
          expect(lease.release).not.toHaveBeenCalled();
          expect(mocks.prepare).toHaveBeenCalledWith(
            expect.objectContaining({
              workerEnv: expect.objectContaining({ HOME: lease.homeDir }),
            }),
          );
          startupGate.release();
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
        startupGate.release();
        await pending.catch(() => undefined);
      }
    },
  );

  it("reuses the physical child with fresh turn authority and clears its old expiry", async () => {
    await using f = fixture();
    const first = input("first");
    const owner = await f.retained(first);
    f.expectCapacity(0, 1);
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
      processChanges: true,
      descriptor: { ...next.descriptor, connectionEndpoint: TEST_WORKER_ENDPOINT },
    });
    f.expectCapacity(0);
    expect(await f.supervisor.hasActiveWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(owner.adapter.kill).not.toHaveBeenCalled();
    await owner.complete(next.launchId, "idle");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(owner.adapter.dispose).toHaveBeenCalledOnce();
    f.expectCapacity(1);
  });

  it("publishes idle only after settlement and starts TTL at background idle-ready", async () => {
    await using f = fixture();
    using release = barrier();
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
  });

  it.each(["before", "at"] as const)(
    "settles idle cleanup %s the admission deadline",
    async (timing) => {
      await using f = fixture();
      using cleanup = barrier();
      const old = input("old", "old-environment");
      const owner = await f.retained(old);
      if (timing === "before") {
        await vi.advanceTimersByTimeAsync(119_999);
      }
      owner.holdCleanup(cleanup.promise);
      const replacement = settle(
        f.supervisor.launch(input("replacement", "new-environment"), TEST_WORKER_ENDPOINT),
      );
      await owner.killed.promise;
      expect(mocks.prepare).toHaveBeenCalledTimes(1);
      f.expectCapacity(0);
      if (timing === "before") {
        await vi.advanceTimersByTimeAsync(9_999);
        expect(owner.adapter.kill).toHaveBeenCalledTimes(2);
        expect(mocks.prepare).toHaveBeenCalledTimes(1);
      } else {
        // Reach the admission boundary without firing unrelated retention timers.
        vi.spyOn(performance, "now").mockReturnValue(10_000);
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
        f.expectCapacity(1);
        expect(vi.getTimerCount()).toBe(0);
      }
      expect(owner.adapter.dispose).toHaveBeenCalledOnce();
    },
  );

  it.each(["deadline", "abort", "close"] as const)(
    "bounds admission by %s while retaining stalled idle cleanup",
    async (boundary) => {
      await using f = fixture();
      const cleanup = createDeferred();
      const controller = new AbortController();
      const failure = new Error("Caller cancelled capacity admission");
      const outcomes: unknown[] = [];
      let admitted: Promise<void> | undefined;
      let closing: Promise<void> | undefined;
      try {
        const owner = await f.retained(input("old", "old-environment"));
        owner.holdCleanup(cleanup.promise);
        admitted = settle(
          f.supervisor.launch(
            input("replacement", "new-environment"),
            TEST_WORKER_ENDPOINT,
            controller.signal,
          ),
        ).then((outcome) => {
          outcomes.push(outcome);
        });
        await owner.killed.promise;
        if (boundary === "deadline") {
          vi.setSystemTime(-60_000);
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
        f.expectCapacity(0);
        let closed = false;
        closing = (closing ?? f.supervisor.close()).then(() => {
          closed = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(closed).toBe(false);
        cleanup.resolve();
        await closing;
        f.expectCapacity(1);
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
    await using f = fixture();
    using release = barrier();
    const owner = await f.retained(input("first"));
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
    f.expectCapacity(1);
  });

  it("retains at most two idle children and reclaims the least recently used, never background", async () => {
    await using f = fixture(4);
    const background = await f.retained(input("background", "background-env"), "background");
    const a = await f.retained(input("a", "a-env"));
    await vi.advanceTimersByTimeAsync(1);
    const b = await f.retained(input("b", "b-env"));
    await vi.advanceTimersByTimeAsync(1);
    await f.supervisor.launch(input("a-next", "a-env"), TEST_WORKER_ENDPOINT);
    await a.complete("a-next", "idle");
    await vi.advanceTimersByTimeAsync(1);
    const c = await f.retained(input("c", "c-env"));
    await vi.advanceTimersByTimeAsync(0);
    expect(b.adapter.dispose).toHaveBeenCalledOnce();
    expect(a.adapter.kill).not.toHaveBeenCalled();
    expect(c.adapter.kill).not.toHaveBeenCalled();
    expect(background.adapter.kill).not.toHaveBeenCalled();
    f.expectCapacity(1, 2);
  });

  it.each(["explicit", "expiry", "limit"] as const)(
    "retries failed %s idle cleanup without freeing its slot or evicting background work",
    async (trigger) => {
      using warning = vi
        .spyOn(loggingState.rawConsole ?? console, "warn")
        .mockImplementation(() => {});
      setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
      try {
        const capacity = trigger === "limit" ? 4 : 2;
        await using f = fixture(capacity, true);
        const background = await f.retained(input("background", "background-env"), "background");
        const idle = await f.retained(input("idle", "idle-env"));
        mocks.remove.mockRejectedValueOnce(new Error("Synthetic container removal failure"));

        if (trigger === "explicit") {
          await expect(f.supervisor.retireIdle()).rejects.toThrow(
            "node worker idle cleanup failed",
          );
        } else if (trigger === "expiry") {
          await vi.advanceTimersByTimeAsync(120_000);
        } else {
          for (const turnId of ["second-idle", "third-idle"]) {
            await f.retained(input(turnId, turnId));
          }
          await vi.advanceTimersByTimeAsync(0);
        }
        f.expectCapacity(0, capacity - 2);
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
        expect(warning).toHaveBeenCalledTimes(trigger === "explicit" ? 0 : 1);

        if (trigger === "expiry") {
          mocks.remove.mockRejectedValueOnce(new Error("Synthetic retry removal failure"));
          await vi.advanceTimersByTimeAsync(120_000);
          expect(warning).toHaveBeenCalledTimes(2);
          expect(idle.adapter.kill).not.toHaveBeenCalled();
          expect(background.adapter.kill).not.toHaveBeenCalled();
          f.expectCapacity(0);
        }
        if (trigger === "explicit") {
          await f.supervisor.retireIdle();
        } else {
          await vi.advanceTimersByTimeAsync(120_000);
        }
        expect(
          mocks.remove.mock.calls.filter(([, owner]) => owner.launchId === "idle"),
        ).toHaveLength(trigger === "expiry" ? 3 : 2);
        expect(idle.adapter.dispose).toHaveBeenCalledOnce();
        expect(background.adapter.kill).not.toHaveBeenCalled();
        f.expectCapacity(capacity - 1);
        expect(await f.supervisor.status("idle")).toMatchObject({ state: "completed" });
        expect(warning).toHaveBeenCalledTimes(
          trigger === "explicit" ? 0 : trigger === "expiry" ? 2 : 1,
        );
        for (const [line] of warning.mock.calls) {
          expect(String(line)).toContain("Idle worker cleanup failed");
          expect(String(line)).toContain("cleanup will retry");
          expect(String(line)).not.toContain("Synthetic");
        }
      } finally {
        setLoggerOverride(null);
      }
    },
  );
});
