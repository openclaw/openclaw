import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as diagnostics from "../../infra/diagnostic-events.js";
import * as trace from "../../infra/diagnostic-trace-context.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";

// mock-isolation: Cron diagnostics simulate missing auth sources without a credential-store owner.
vi.mock("../../agents/auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSourceAsync: () => false,
}));

import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as harness from "./run.test-harness.js";

const runCron = await harness.loadRunCronIsolatedAgentTurn();
const sessionDirs = useSessionStoreTempDirs(afterAll, "cron-diagnostic-events-");
let sessionStorePath: string;
type TraceContext = trace.DiagnosticTraceContext;
let events: diagnostics.DiagnosticEventPayload[];
let published: diagnostics.DiagnosticEventPayload[];

function makeParams(config: OpenClawConfig = {}) {
  return makeIsolatedAgentParamsFixture({
    cfg: { ...config, session: { ...config.session, store: sessionStorePath } },
  });
}
function fallback(agentMeta: Record<string, unknown>, diagnosticTrace?: TraceContext) {
  const result = { payloads: [{ text: "test output" }], meta: { agentMeta }, diagnosticTrace };
  return { result: { result }, provider: "openai", model: "gpt-5.4", attempts: [] };
}
async function runWithEvents(params: Parameters<typeof runCron>[0] = makeParams()) {
  const result = await runCron(params);
  await diagnostics.waitForDiagnosticEventsDrained();
  return result;
}

describe("runCronIsolatedAgentTurn diagnostic events", () => {
  setupRunCronIsolatedAgentTurnSuite();
  beforeEach(({ onTestFinished }) => {
    resetDiagnosticStateForTest();
    diagnostics.resetDiagnosticEventsForTest();
    sessionStorePath = path.join(sessionDirs.make(), "sessions.json");
    harness.resolveCronSessionMock.mockReturnValue(
      harness.makeCronSession({ storePath: sessionStorePath }),
    );
    events = [];
    published = [];
    onTestFinished(diagnostics.onDiagnosticEvent((event) => published.push(event)));
    onTestFinished(
      diagnostics.onInternalDiagnosticEvent((event) => events.push(event), {
        include: [
          "message.queued",
          "message.dispatch.started",
          "message.dispatch.completed",
          "message.processed",
          "session.state",
          "model.usage",
        ],
      }),
    );
  });

  it("keeps lifecycle trace and adopted session identity through execution and parent restoration", async () => {
    const parent = trace.createDiagnosticTraceContext();
    let dispatchStartedBeforeExecution = false;
    let executionTrace: TraceContext | undefined;
    let harnessTrace: TraceContext | undefined;
    harness.runWithModelFallbackMock.mockImplementationOnce(async () => {
      await Promise.resolve();
      dispatchStartedBeforeExecution = events.some(
        (event) => event.type === "message.dispatch.started",
      );
      executionTrace = trace.getActiveDiagnosticTraceContext();
      harnessTrace = trace.createDiagnosticTraceContextFromActiveScope();
      return fallback(
        { sessionId: "persisted-run-session", usage: { input: 10, output: 20 } },
        harnessTrace,
      );
    });

    const result = await trace.runWithDiagnosticTraceContext(parent, async () => {
      const run = await runWithEvents();
      expect(trace.getActiveDiagnosticTraceContext()).toEqual(parent);
      return run;
    });
    expect(result.status).toBe("ok");
    const starts = events.filter((event) => event.type === "message.dispatch.started");
    expect(starts).toHaveLength(1);
    expect(dispatchStartedBeforeExecution).toBe(true);
    const messageTrace = starts[0]?.trace;
    expect(messageTrace?.spanId).toBeTruthy();
    expect(messageTrace).toMatchObject({ traceId: parent.traceId, parentSpanId: parent.spanId });
    expect(messageTrace?.spanId).not.toBe(parent.spanId);
    expect(executionTrace).toEqual(messageTrace);
    expect(harnessTrace).toMatchObject({
      traceId: messageTrace?.traceId,
      parentSpanId: messageTrace?.spanId,
    });
    const finished = [{ outcome: "completed", trace: messageTrace }];
    expect(events.filter((event) => event.type === "message.processed")).toMatchObject(finished);
    expect(starts[0]).toMatchObject({ channel: "cron", source: "cron-isolated" });
    expect(events.filter((event) => event.type === "message.dispatch.completed")).toMatchObject(
      finished,
    );
    const usage = events.find((event) => event.type === "model.usage");
    expect(usage?.trace).toMatchObject({
      traceId: messageTrace?.traceId,
      parentSpanId: harnessTrace?.spanId,
    });
    expect(trace.getActiveDiagnosticTraceContext()).toBeUndefined();
    expect(
      published.filter(({ type }) =>
        ["message.queued", "session.state", "message.processed"].includes(type),
      ),
    ).toMatchObject([
      { type: "message.queued", sessionId: "test-session-id" },
      { type: "session.state", state: "processing", sessionId: "test-session-id" },
      { type: "session.state", state: "idle", sessionId: "persisted-run-session" },
      { type: "message.processed", sessionId: "persisted-run-session" },
    ]);
  });

  it("emits neither lifecycle nor usage events when diagnostics are disabled", async () => {
    const result = await runWithEvents(makeParams({ diagnostics: { enabled: false } }));
    expect(result.status).toBe("ok");
    expect(events).toEqual([]);
  });

  it("emits billed model usage when the cron run is aborted before finalization", async () => {
    const abortController = new AbortController();
    harness.runWithModelFallbackMock.mockImplementationOnce(async () => {
      abortController.abort("cron: job execution timed out");
      return fallback({ sessionId: "late-session", usage: { input: 50, output: 10, total: 60 } });
    });
    const result = await runWithEvents({
      ...makeParams(),
      abortSignal: abortController.signal,
    });
    expect(result).toMatchObject({ status: "error", error: "cron: job execution timed out" });
    expect(events.filter((event) => event.type === "model.usage")).toMatchObject([
      {
        type: "model.usage",
        sessionId: "test-session-id",
        usage: { input: 50, output: 10, total: 60 },
      },
    ]);
  });
});
