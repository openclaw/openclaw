import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { wrapToolWithBeforeToolCallHookCore as wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.wrapper.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
  resolveRunStaleThresholdMs,
  startDiagnosticRunActivityTracking,
} from "../logging/diagnostic-run-activity.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";

const handleGatewayRequest = vi.hoisted(() => vi.fn());
vi.mock("./server-methods.js", () => ({ handleGatewayRequest }));

const ref = { sessionId: "gateway-wait", sessionKey: "agent:main:gateway-wait" };
const result = { content: [], details: { status: "ok" } };
const cleanupGates: (() => void)[] = [];
const pendingWork: Promise<unknown>[] = [];

function completionGate() {
  const gate = createDeferred();
  cleanupGates.push(() => gate.resolve());
  return gate;
}

function startNestedTool(execute: () => Promise<void>, runId = "current-run", owned = true) {
  if (owned) {
    markDiagnosticEmbeddedRunStarted({ ...ref, runId });
  }
  const wrap = (name: string, body: AnyAgentTool["execute"]) =>
    wrapToolWithBeforeToolCallHook(
      { name, label: name, description: name, parameters: Type.Object({}), execute: body },
      { ...ref, runId },
    );
  const inner = wrap("crabbox", async () => {
    await execute();
    return result;
  });
  const outer = wrap("tool_call", () => inner.execute("inner", {}));
  const execution = outer.execute("outer", {});
  pendingWork.push(execution);
  return execution;
}

function pendingRequest(
  method: string,
  timeoutMs?: number,
  signal?: AbortSignal,
  expectFinal = false,
) {
  const entered = createDeferred();
  const completed = completionGate();
  const settled = createDeferred();
  const execute = async (options: GatewayRequestOptions) => {
    entered.resolve();
    if (expectFinal) {
      options.respond(true, { status: "accepted" });
    }
    try {
      await completed.promise;
      options.respond(true, { status: "ok" });
    } finally {
      settled.resolve();
    }
  };
  return {
    entered,
    completed,
    settled,
    execute,
    call: () => {
      const response = dispatchGatewayRequestInProcessRaw(
        method,
        {},
        {
          client: null,
          context: { trackExecution: trackAsyncWork } as GatewayRequestContext,
          timeoutMs,
          signal,
          expectFinal,
          onExecution: (execution) => {
            pendingWork.push(execution);
          },
        },
      );
      pendingWork.push(response);
      return response;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
  setDiagnosticsEnabledForProcess(true);
  startDiagnosticRunActivityTracking();
});

afterEach(async () => {
  for (const finish of cleanupGates.splice(0)) {
    finish();
  }
  while (pendingWork.length > 0) {
    await Promise.allSettled(pendingWork.splice(0));
  }
  await waitForDiagnosticEventsDrained();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticEventsForTest();
  handleGatewayRequest.mockReset();
  vi.useRealTimers();
});

describe("nested tool Gateway response deadlines", () => {
  it.each([false, true])(
    "honors a nested 20-minute wait beyond the recovery floor (expectFinal: %s)",
    async (expectFinal) => {
      const startedAt = Date.now();
      const request = pendingRequest("environments.create", 20 * 60_000, undefined, expectFinal);
      handleGatewayRequest.mockImplementation(request.execute);
      const execution = startNestedTool(async () => {
        await request.call();
      });
      await request.entered.promise;
      await waitForDiagnosticEventsDrained();
      await vi.advanceTimersByTimeAsync(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS + 1);

      const snapshot = getDiagnosticSessionActivitySnapshot(ref);
      expect(snapshot).toMatchObject({
        activeToolName: "tool_call",
        activeToolCallId: "outer",
        activeToolAgeMs: BLOCKED_TOOL_CALL_ABORT_FLOOR_MS + 1,
        activeToolDeadlineAtMs: startedAt + 20 * 60_000 + BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
      });
      expect(snapshot.lastProgressAgeMs).toBeLessThan(resolveRunStaleThresholdMs(snapshot));

      request.completed.resolve();
      await execution;
      await waitForDiagnosticEventsDrained();
      expect(getDiagnosticSessionActivitySnapshot(ref).activeToolDeadlineAtMs).toBeUndefined();
    },
  );

  it.each(["long", "short"] as const)(
    "releases only the %s response allowance while an overlapping wait is still pending",
    async (first) => {
      const startedAt = Date.now();
      const requests = {
        long: pendingRequest("long", 30 * 60_000),
        short: pendingRequest("short", 20 * 60_000),
      };
      handleGatewayRequest.mockImplementation((options: GatewayRequestOptions) =>
        options.req.method === "long"
          ? requests.long.execute(options)
          : requests.short.execute(options),
      );
      const finishedWaits = createDeferred();
      const finishTool = completionGate();
      let calls: Promise<unknown>[] = [];
      const execution = startNestedTool(async () => {
        // Vitest's manual mock loader cannot resolve concurrent router imports.
        // Admit the sibling after import settles, with both responses still pending.
        calls = [requests.long.call()];
        await requests.long.entered.promise;
        calls.push(requests.short.call());
        await Promise.all(calls);
        finishedWaits.resolve();
        await finishTool.promise;
      });
      await Promise.all([requests.long.entered.promise, requests.short.entered.promise]);
      await waitForDiagnosticEventsDrained();
      expect(getDiagnosticSessionActivitySnapshot(ref).activeToolDeadlineAtMs).toBe(
        startedAt + 30 * 60_000 + BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
      );

      requests[first].completed.resolve();
      await calls[first === "long" ? 0 : 1];
      expect(getDiagnosticSessionActivitySnapshot(ref).activeToolDeadlineAtMs).toBe(
        startedAt + (first === "long" ? 20 : 30) * 60_000 + BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
      );

      requests[first === "long" ? "short" : "long"].completed.resolve();
      await finishedWaits.promise;
      expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
        activeToolName: "tool_call",
        activeToolDeadlineAtMs: undefined,
      });
      finishTool.resolve();
      await execution;
    },
  );

  it.each(["cancel", "timeout", "error"] as const)(
    "releases a failed response wait on %s without pretending the handler was canceled",
    async (ending) => {
      const controller = new AbortController();
      const request = pendingRequest("environments.create", 20 * 60_000, controller.signal);
      handleGatewayRequest.mockImplementation(request.execute);
      const failed = createDeferred<unknown>();
      const finishTool = completionGate();
      const handlerSettled = vi.fn();
      void request.settled.promise.then(handlerSettled);
      const execution = startNestedTool(async () => {
        try {
          await request.call();
        } catch (error) {
          failed.resolve(error);
        }
        await finishTool.promise;
      });
      await request.entered.promise;
      await waitForDiagnosticEventsDrained();
      expect(getDiagnosticSessionActivitySnapshot(ref).activeToolDeadlineAtMs).toBeDefined();
      if (ending === "cancel") {
        controller.abort(new Error("stop waiting"));
      } else if (ending === "timeout") {
        await vi.advanceTimersByTimeAsync(20 * 60_000);
      } else {
        request.completed.reject(new Error("handler failed"));
      }
      expect(await failed.promise).toBeInstanceOf(Error);
      expect(getDiagnosticSessionActivitySnapshot(ref).activeToolDeadlineAtMs).toBeUndefined();
      if (ending !== "error") {
        expect(handlerSettled).not.toHaveBeenCalled();
        request.completed.resolve();
      }
      await request.settled.promise;
      finishTool.resolve();
      await execution;
    },
  );

  it("uses only the current run's waits when a prior run still has a longer pending request", async () => {
    const startedAt = Date.now();
    const previous = pendingRequest("previous", 40 * 60_000);
    const current = pendingRequest("current", 20 * 60_000);
    handleGatewayRequest.mockImplementation((options: GatewayRequestOptions) =>
      options.req.method === "previous" ? previous.execute(options) : current.execute(options),
    );
    const oldExecution = startNestedTool(async () => {
      await previous.call();
    }, "previous-run");
    await previous.entered.promise;
    await waitForDiagnosticEventsDrained();
    const finishedWait = createDeferred();
    const finishTool = completionGate();
    const execution = startNestedTool(async () => {
      await current.call();
      finishedWait.resolve();
      await finishTool.promise;
    });
    await current.entered.promise;
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(ref).activeToolDeadlineAtMs).toBe(
      startedAt + 20 * 60_000 + BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
    );

    current.completed.resolve();
    await finishedWait.promise;
    await vi.advanceTimersByTimeAsync(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS + 1);
    const snapshot = getDiagnosticSessionActivitySnapshot(ref);
    expect(snapshot.activeToolDeadlineAtMs).toBeUndefined();
    expect(snapshot.lastProgressAgeMs).toBeGreaterThan(resolveRunStaleThresholdMs(snapshot));
    previous.completed.resolve();
    finishTool.resolve();
    await Promise.all([oldExecution, execution]);
  });

  it.each([
    { name: "unbounded current-run request", timeoutMs: undefined, owned: true },
    { name: "bounded ownerless request", timeoutMs: 20 * 60_000, owned: false },
  ])("preserves recoverability for a $name", async ({ timeoutMs, owned }) => {
    const request = pendingRequest("fallback", timeoutMs);
    handleGatewayRequest.mockImplementation(request.execute);
    const execution = startNestedTool(
      async () => {
        await request.call();
      },
      "current-run",
      owned,
    );
    await request.entered.promise;
    await waitForDiagnosticEventsDrained();
    await vi.advanceTimersByTimeAsync(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS + 1);
    const snapshot = getDiagnosticSessionActivitySnapshot(ref);
    expect(snapshot.activeToolDeadlineAtMs).toBeUndefined();
    expect(snapshot.lastProgressAgeMs).toBeGreaterThan(resolveRunStaleThresholdMs(snapshot));
    request.completed.resolve();
    await execution;
  });
});
