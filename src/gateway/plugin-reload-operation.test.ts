import { beforeEach, expect, it, vi } from "vitest";
import type { PluginReloadRunTarget } from "../agents/plugin-reload-runs.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import type { PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import { createReplyOperation } from "../sessions/session-controller.js";
import { testing as sessionTesting } from "../sessions/session-controller.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { PluginReloadOperation } from "./plugin-reload-operation-store.types.js";
import { createPluginReloadOperationOwner } from "./plugin-reload-operation.js";

const state = vi.hoisted(() => ({
  records: new Map<string, PluginReloadOperation>(),
  events: [] as string[],
  targets: [] as PluginReloadRunTarget[],
}));
vi.mock("./plugin-reload-operation-store.js", () => ({
  readPluginReloadOperation: async (id: string) => state.records.get(id),
  savePluginReloadOperation: async (operation: PluginReloadOperation) => {
    state.events.push("save:" + operation.state);
    state.records.set(operation.id, structuredClone(operation));
  },
}));
vi.mock("../agents/plugin-reload-runs.js", () => ({
  capturePluginReloadRunTargets: () => state.targets,
}));
beforeEach(() => {
  state.records.clear();
  state.events.length = 0;
  state.targets = [];
  sessionTesting.resetSessionControllerForTest();
});
const result = {
  ok: true,
  pluginIds: ["sample"],
  restartRequired: false,
  runtime: { operationId: "operation", generation: 2, pluginIds: ["sample"] },
} as const;

it("owns accepted reload independently of its observer and persists intent before exact cancellation", async () => {
  const operation = createReplyOperation({
    sessionKey: "agent:test:reload",
    sessionId: "session",
    resetTriggered: false,
  });
  const gate = createDeferredCore();
  const caller = new AbortController();
  const custodian = new AbortController();
  const onAbort = () => custodian.abort(caller.signal.reason);
  caller.signal.addEventListener("abort", onAbort);
  state.targets = [
    {
      agentId: "test",
      sessionId: "session",
      sessionKey: "agent:test:reload",
      runId: "run",
      sourceInputKeys: ["run:user"],
      operation,
      isBlocking: () => true,
      interrupt: () => {
        expect(state.records.get("operation")?.continuations).toHaveLength(1);
        state.events.push("interrupt");
        return true;
      },
    },
  ];
  const resume = vi.fn(async () => {});
  const owner = createPluginReloadOperationOwner({
    warn: vi.fn(),
    resume,
    prepare: async (current) => {
      current.continuations = [
        {
          agentId: "test",
          sessionId: "session",
          sessionKey: "agent:test:reload",
          sourceRunId: "run",
          sourceInputKeys: ["run:user"],
          recoverySource: { kind: "unavailable" },
          queuedInputIds: ["older", "newer"],
          state: "pending",
        },
      ];
      state.records.set(current.id, structuredClone(current));
      state.events.push("persist-intent");
      return current;
    },
  });
  const run = vi.fn(
    async (drain: (instances: readonly PluginInstanceHandle[]) => Promise<void>) => {
      await drain([]);
      await gate.promise;
      return {
        ...result,
        pluginIds: [...result.pluginIds],
        runtime: { ...result.runtime, pluginIds: [...result.runtime.pluginIds] },
      };
    },
  );
  const accepted = await owner.start({
    operationId: "operation",
    pluginIds: ["sample"],
    requestKey: "shape",
    signal: custodian.signal,
    assertCurrent: () => custodian.signal.throwIfAborted(),
    onAccepted: () => caller.signal.removeEventListener("abort", onAbort),
    run,
  });
  caller.abort(new Error("wait observer disconnected"));
  expect(custodian.signal.aborted).toBe(false);
  const joined = await owner.observe("operation", "shape");
  expect(joined?.finished).toBe(accepted.finished);
  gate.resolve();
  expect(await accepted.finished).toMatchObject({ runtime: { generation: 2 } });
  expect(state.events.indexOf("save:accepted")).toBeLessThan(
    state.events.indexOf("persist-intent"),
  );
  expect(state.events.indexOf("persist-intent")).toBeLessThan(state.events.indexOf("interrupt"));
  expect(state.records.get("operation")?.state).toBe("succeeded");
  expect(resume).toHaveBeenCalledWith(
    expect.objectContaining({ state: "succeeded" }),
    expect.objectContaining({ healthy: true }),
  );
  expect(run).toHaveBeenCalledTimes(1);
  await expect(owner.observe("operation", "different-shape")).rejects.toThrow("another request");
});

it.each([false, true])(
  "resumes failed reload only with explicit healthy rollback proof (%s)",
  async (restored) => {
    const resume = vi.fn(async () => {});
    const owner = createPluginReloadOperationOwner({
      warn: vi.fn(),
      resume,
      prepare: async (operation) => operation,
    });
    const failure = new PluginRuntimeApplicationError("activation failed", {
      operationId: "failed",
      generation: 1,
      pluginIds: ["sample"],
      phase: "activate",
      committed: false,
      ...(restored ? { runtimeRestored: true } : {}),
    });
    const accepted = await owner.start({
      operationId: "failed",
      pluginIds: ["sample"],
      requestKey: "shape",
      assertCurrent: () => {},
      run: async () => {
        throw failure;
      },
    });
    await expect(accepted.finished).rejects.toBe(failure);
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ state: "failed" }),
      expect.objectContaining({ healthy: restored }),
    );
  },
);
