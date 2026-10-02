import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type DiagnosticEventPayload,
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  createDiagnosticTraceContextFromActiveScope,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";

const hasAnyAuthProfileStoreSourceMock = vi.hoisted(() => vi.fn(() => false));
vi.mock("../../agents/auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSource: hasAnyAuthProfileStoreSourceMock,
}));

import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  resolveCronSessionMock,
  resolveSessionAuthSelectionMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams(cfg: OpenClawConfig = {}) {
  return {
    deliveryAttemptFence: null,
    cfg,
    deps: {} as never,
    job: {
      id: "cron-diag-events",
      name: "Diag Events",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "isolated" as const,
      state: {},
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "agentTurn" as const, message: "run task" },
    },
    message: "run task",
    sessionKey: "cron:diag-events",
  };
}
function fallbackResult(agentMeta: Record<string, unknown>, text = "test output") {
  return {
    result: { result: { payloads: [{ text }], meta: { agentMeta } } },
    provider: "openai",
    model: "gpt-5.4",
    attempts: [],
  };
}
async function runWithEvents(
  params: Parameters<typeof runCronIsolatedAgentTurn>[0] = makeParams(),
  subscribe: typeof onDiagnosticEvent = onInternalDiagnosticEvent,
  events: DiagnosticEventPayload[] = [],
) {
  const unsubscribe = subscribe((event) => events.push(event));
  try {
    const result = await runCronIsolatedAgentTurn(params);
    await waitForDiagnosticEventsDrained();
    return { result, events };
  } finally {
    unsubscribe();
  }
}

describe("runCronIsolatedAgentTurn diagnostic events", () => {
  setupRunCronIsolatedAgentTurnSuite();
  beforeEach(() => {
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
  });

  it.each(["completed", "error"] as const)(
    "anchors cron execution to a message lifecycle trace on %s",
    async (outcome) => {
      const observedEvents: DiagnosticEventPayload[] = [];
      let dispatchStartedBeforeExecution = false;
      let executionTrace: DiagnosticTraceContext | undefined;
      let harnessTrace: DiagnosticTraceContext | undefined;
      runWithModelFallbackMock.mockImplementationOnce(async () => {
        await Promise.resolve();
        dispatchStartedBeforeExecution = observedEvents.some(
          (event) => event.type === "message.dispatch.started",
        );
        executionTrace = getActiveDiagnosticTraceContext();
        harnessTrace = createDiagnosticTraceContextFromActiveScope();
        if (outcome === "error") {
          throw new Error("cron model failed");
        }
        const fallback = fallbackResult({ usage: { input: 10, output: 20 } });
        return {
          ...fallback,
          result: {
            result: { ...fallback.result.result, diagnosticTrace: harnessTrace },
          },
        };
      });

      const { result, events } = await runWithEvents(
        makeParams(),
        onInternalDiagnosticEvent,
        observedEvents,
      );
      expect(result.status).toBe(outcome === "error" ? "error" : "ok");
      const starts = events.filter((event) => event.type === "message.dispatch.started");
      const completions = events.filter((event) => event.type === "message.processed");
      expect(starts).toHaveLength(1);
      expect(completions).toHaveLength(1);
      expect(dispatchStartedBeforeExecution).toBe(true);
      const messageTrace = starts[0]?.trace;
      expect(messageTrace?.spanId).toBeTruthy();
      expect(executionTrace).toEqual(messageTrace);
      expect(harnessTrace).toMatchObject({
        traceId: messageTrace?.traceId,
        parentSpanId: messageTrace?.spanId,
      });
      expect(completions[0]).toMatchObject({ outcome, trace: messageTrace });
      expect(starts[0]).toMatchObject({ channel: "cron", source: "cron-isolated" });
      expect(events.filter((event) => event.type === "message.dispatch.completed")).toMatchObject([
        { outcome, trace: messageTrace },
      ]);
      if (outcome === "completed") {
        const usage = events.find((event) => event.type === "model.usage");
        expect(usage?.trace).toMatchObject({
          traceId: messageTrace?.traceId,
          parentSpanId: harnessTrace?.spanId,
        });
      } else {
        expect(result.error).toBe("cron model failed");
      }
      expect(getActiveDiagnosticTraceContext()).toBeUndefined();
    },
  );

  it("creates a child message scope and restores the ambient parent after completion", async () => {
    const parent = createDiagnosticTraceContext();
    const { result, events } = await runWithDiagnosticTraceContext(parent, async () => {
      const run = await runWithEvents();
      expect(getActiveDiagnosticTraceContext()).toEqual(parent);
      return run;
    });
    const messageTrace = events.find((event) => event.type === "message.dispatch.started")?.trace;
    expect(result.status).toBe("ok");
    expect(messageTrace).toMatchObject({ traceId: parent.traceId, parentSpanId: parent.spanId });
    expect(messageTrace?.spanId).not.toBe(parent.spanId);
    expect(getActiveDiagnosticTraceContext()).toBeUndefined();
  });

  it("emits final lifecycle events under the adopted run session id", async () => {
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          sessionId: "fallback-run-session",
          sessionFile: "/tmp/fallback-run-session.jsonl",
        }),
      }),
    );
    runWithModelFallbackMock.mockResolvedValue(
      fallbackResult({
        sessionId: "persisted-run-session",
        sessionFile: "/tmp/persisted-run-session.jsonl",
        usage: { input: 10, output: 20 },
      }),
    );
    const { result, events } = await runWithEvents(makeParams(), onDiagnosticEvent);
    expect(result.status).toBe("ok");
    expect(
      events.filter(({ type }) =>
        ["message.queued", "session.state", "message.processed"].includes(type),
      ),
    ).toMatchObject([
      { type: "message.queued", sessionId: "fallback-run-session" },
      { type: "session.state", state: "processing", sessionId: "fallback-run-session" },
      { type: "session.state", state: "idle", sessionId: "persisted-run-session" },
      { type: "message.processed", sessionId: "persisted-run-session" },
    ]);
  });

  it("emits neither lifecycle nor usage events when diagnostics are disabled", async () => {
    const { result, events } = await runWithEvents(makeParams({ diagnostics: { enabled: false } }));
    expect(result.status).toBe("ok");
    expect(events).toEqual([]);
  });

  it("emits billed model usage when the cron run is aborted before finalization", async () => {
    const abortController = new AbortController();
    runWithModelFallbackMock.mockImplementationOnce(async () => {
      abortController.abort("cron: job execution timed out");
      return fallbackResult(
        {
          sessionId: "late-session",
          usage: { input: 50, output: 10, total: 60 },
        },
        "late output",
      );
    });
    const { result, events } = await runWithEvents({
      ...makeParams(),
      abortSignal: abortController.signal,
    });
    expect(result.status).toBe("error");
    expect(result.error).toBe("cron: job execution timed out");
    const usageEvents = events.filter((event) => event.type === "model.usage");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      type: "model.usage",
      sessionId: "test-session-id",
      usage: { input: 50, output: 10, total: 60 },
    });
  });

  it.each([
    { name: "total-only model usage", usage: { total: 42 }, expectedTotal: 42, cost: undefined },
    { name: "cost-only zero total", usage: { cost: { total: 0 } }, expectedTotal: 0, cost: 0 },
  ])("preserves $name in cron diagnostics", async ({ usage, expectedTotal, cost }) => {
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry({ estimatedCostUsd: 1.25 }),
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    runWithModelFallbackMock.mockResolvedValue(fallbackResult({ usage }));
    const { result, events } = await runWithEvents();
    expect(result.status).toBe("ok");
    const usageEvents = events.filter((event) => event.type === "model.usage");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.usage).toMatchObject({
      input: 0,
      output: 0,
      promptTokens: 0,
      total: expectedTotal,
    });
    expect(usageEvents[0]?.costUsd).toBe(cost);
    if (cost !== undefined) {
      expect(cronSession.sessionEntry.estimatedCostUsd).toBe(cost);
      for (const key of [
        "inputTokens",
        "outputTokens",
        "cacheRead",
        "cacheWrite",
        "totalTokens",
      ] as const) {
        expect(cronSession.sessionEntry[key]).toBeUndefined();
      }
      expect(cronSession.sessionEntry.totalTokensFresh).not.toBe(true);
    }
  });

  it("skips auth-profile override resolution when no sources exist", async () => {
    const result = await runCronIsolatedAgentTurn(makeParams());
    expect(result.status).toBe("ok");
    expect(hasAnyAuthProfileStoreSourceMock).toHaveBeenCalledTimes(1);
    expect(resolveSessionAuthSelectionMock).not.toHaveBeenCalled();
  });
});
