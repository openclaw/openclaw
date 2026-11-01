import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.wrapper.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS as recoveryMs,
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
const startedAt = Date.parse("2026-09-20T00:00:00Z");
const snapshot = () => getDiagnosticSessionActivitySnapshot(ref);

function expectDeadline(minutes?: number) {
  expect(snapshot().activeToolDeadlineAtMs).toBe(
    minutes === undefined ? undefined : startedAt + minutes * 60_000 + recoveryMs,
  );
}

function completionGate() {
  const gate = createDeferred();
  cleanupGates.push(() => gate.resolve());
  return gate;
}

function startNestedTool(
  requests: ReturnType<typeof pendingRequest>[],
  runId = "current-run",
  owned = true,
  captureError = false,
) {
  const finished = createDeferred<unknown[]>();
  const finish = completionGate();
  if (owned) {
    markDiagnosticEmbeddedRunStarted({ ...ref, runId });
  }
  const wrap = (name: string, body: AnyAgentTool["execute"]) =>
    wrapToolWithBeforeToolCallHook(
      { name, label: name, description: name, parameters: Type.Object({}), execute: body },
      { ...ref, runId },
    );
  const inner = wrap("crabbox", async () => {
    const responses: Promise<unknown>[] = [];
    for (const request of requests) {
      responses.push(request.call());
      // Admit siblings only after the manual mock loader's import has settled.
      await request.entered;
    }
    finished.resolve(
      await Promise.all(
        responses.map((response) =>
          captureError ? response.catch((error: unknown) => error) : response,
        ),
      ),
    );
    await finish.promise;
    return result;
  });
  const outer = wrap("dispatch_action", () => inner.execute("inner", {}));
  const execution = outer.execute("outer", {});
  pendingWork.push(execution);
  return {
    ready: Promise.all(requests.map((request) => request.entered)),
    finished: finished.promise,
    stop: async () => {
      finish.resolve();
      await execution;
    },
  };
}

function pendingRequest(method: string, timeout?: number, signal?: AbortSignal, final = false) {
  const entered = createDeferred();
  const completed = completionGate();
  const settled = createDeferred();
  let response: Promise<unknown> | undefined;
  handleGatewayRequest.mockImplementationOnce(async (options: GatewayRequestOptions) => {
    expect(options.req.method).toBe(method);
    entered.resolve();
    if (final) {
      options.respond(true, { status: "accepted" });
    }
    try {
      await completed.promise;
      options.respond(true, { status: "ok" });
    } finally {
      settled.resolve();
    }
  });
  return {
    entered: entered.promise.then(waitForDiagnosticEventsDrained),
    completed,
    settled,
    finish: async () => {
      completed.resolve();
      await response;
    },
    call: () => {
      response = dispatchGatewayRequestInProcessRaw(
        method,
        {},
        {
          client: null,
          context: { trackExecution: trackAsyncWork } as GatewayRequestContext,
          timeoutMs: timeout,
          signal,
          expectFinal: final,
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
  vi.setSystemTime(startedAt);
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
  it.each([
    ["bounded first response", 20 * 60_000, true, false],
    ["bounded final response", 20 * 60_000, true, true],
    ["unbounded current-run request", undefined, true, false],
    ["bounded ownerless request", 20 * 60_000, false, false],
  ] as const)(
    "tracks recovery allowance for a %s",
    async (_name, timeoutMs, owned, expectFinal) => {
      const request = pendingRequest("environments.create", timeoutMs, undefined, expectFinal);
      const tool = startNestedTool([request], "current-run", owned);
      await tool.ready;
      await vi.advanceTimersByTimeAsync(recoveryMs + 1);
      const activity = snapshot();
      if (owned && timeoutMs !== undefined) {
        expect(activity).toMatchObject({
          activeToolName: "dispatch_action",
          activeToolCallId: "outer",
          activeToolAgeMs: recoveryMs + 1,
          activeToolDeadlineAtMs: startedAt + timeoutMs + recoveryMs,
        });
        expect(activity.lastProgressAgeMs).toBeLessThan(resolveRunStaleThresholdMs(activity));
      } else {
        expectDeadline();
        expect(activity.lastProgressAgeMs).toBeGreaterThan(resolveRunStaleThresholdMs(activity));
      }
      request.completed.resolve();
      await tool.stop();
      await waitForDiagnosticEventsDrained();
      expectDeadline();
    },
  );

  it.each(["long", "short"] as const)(
    "releases only the %s response allowance while an overlapping wait is still pending",
    async (first) => {
      const requests = {
        long: pendingRequest("long", 30 * 60_000),
        short: pendingRequest("short", 20 * 60_000),
      };
      const tool = startNestedTool([requests.long, requests.short]);
      await tool.ready;
      expectDeadline(30);

      await requests[first].finish();
      expectDeadline(first === "long" ? 20 : 30);

      requests[first === "long" ? "short" : "long"].completed.resolve();
      await tool.finished;
      expect(snapshot()).toMatchObject({
        activeToolName: "dispatch_action",
        activeToolDeadlineAtMs: undefined,
      });
      await tool.stop();
    },
  );

  it.each(["cancel", "timeout", "error"] as const)(
    "releases a failed response wait on %s without pretending the handler was canceled",
    async (ending) => {
      const controller = new AbortController();
      const request = pendingRequest("environments.create", 20 * 60_000, controller.signal);
      const handlerSettled = vi.fn();
      void request.settled.promise.then(handlerSettled);
      const tool = startNestedTool([request], "current-run", true, true);
      await tool.ready;
      expect(snapshot().activeToolDeadlineAtMs).toBeDefined();
      if (ending === "cancel") {
        controller.abort(new Error("stop waiting"));
      } else if (ending === "timeout") {
        await vi.advanceTimersByTimeAsync(20 * 60_000);
      } else {
        request.completed.reject(new Error("handler failed"));
      }
      expect((await tool.finished)[0]).toBeInstanceOf(Error);
      expectDeadline();
      if (ending !== "error") {
        expect(handlerSettled).not.toHaveBeenCalled();
        request.completed.resolve();
      }
      await request.settled.promise;
      await tool.stop();
    },
  );

  it("uses only the current run's waits when a prior run still has a longer pending request", async () => {
    const previous = pendingRequest("previous", 40 * 60_000);
    const current = pendingRequest("current", 20 * 60_000);
    const oldTool = startNestedTool([previous], "previous-run");
    await oldTool.ready;
    const tool = startNestedTool([current]);
    await tool.ready;
    expectDeadline(20);

    current.completed.resolve();
    await tool.finished;
    await vi.advanceTimersByTimeAsync(recoveryMs + 1);
    const activity = snapshot();
    expectDeadline();
    expect(activity.lastProgressAgeMs).toBeGreaterThan(resolveRunStaleThresholdMs(activity));
    previous.completed.resolve();
    await Promise.all([oldTool.stop(), tool.stop()]);
  });
});
