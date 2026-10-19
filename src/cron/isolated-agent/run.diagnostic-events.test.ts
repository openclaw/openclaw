import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";

const hasAnyAuthProfileStoreSourceAsyncMock = vi.hoisted(() => vi.fn(() => false));
// mock-isolation: Cron diagnostics simulate missing auth sources without a credential-store owner.
vi.mock("../../agents/auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSourceAsync: hasAnyAuthProfileStoreSourceAsyncMock,
}));

import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  resolveCronSessionMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const sessionDirs = useSessionStoreTempDirs(afterAll, "cron-diagnostic-events-");
let sessionStorePath: string;

function makeParams(config: OpenClawConfig = {}) {
  return makeIsolatedAgentParamsFixture({
    cfg: { ...config, session: { ...config.session, store: sessionStorePath } },
    job: {
      id: "cron-diag-events",
      payload: { kind: "agentTurn", message: "run task" },
    },
    message: "run task",
    sessionKey: "cron:diag-events",
  });
}
function fallbackResult(
  agentMeta: Record<string, unknown>,
  text = "test output",
  diagnosticTrace?: DiagnosticTraceContext,
) {
  return {
    result: {
      result: {
        payloads: [{ text }],
        meta: { agentMeta },
        ...(diagnosticTrace ? { diagnosticTrace } : {}),
      },
    },
    provider: "openai",
    model: "gpt-5.4",
    attempts: [],
  };
}
async function runWithEvents(
  params: Parameters<typeof runCronIsolatedAgentTurn>[0] = makeParams(),
  subscribe: (
    listener: Parameters<typeof onDiagnosticEvent>[0],
    filter?: Parameters<typeof onInternalDiagnosticEvent>[1],
  ) => () => void = onInternalDiagnosticEvent,
  events: DiagnosticEventPayload[] = [],
) {
  const unsubscribe = subscribe((event) => events.push(event), {
    include: [
      "message.queued",
      "message.dispatch.started",
      "message.dispatch.completed",
      "message.processed",
      "session.state",
      "model.usage",
    ],
  });
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
    sessionStorePath = path.join(sessionDirs.make(), "sessions.json");
    resolveCronSessionMock.mockReturnValue(makeCronSession({ storePath: sessionStorePath }));
  });

  it("anchors cron execution to a child message lifecycle trace and restores its parent", async () => {
    const outcome = "completed";
    const parent = createDiagnosticTraceContext();
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
      return fallbackResult({ usage: { input: 10, output: 20 } }, "test output", harnessTrace);
    });

    const { result, events } = await runWithDiagnosticTraceContext(parent, async () => {
      const run = await runWithEvents(makeParams(), onInternalDiagnosticEvent, observedEvents);
      expect(getActiveDiagnosticTraceContext()).toEqual(parent);
      return run;
    });
    expect(result.status).toBe("ok");
    const starts = events.filter((event) => event.type === "message.dispatch.started");
    const completions = events.filter((event) => event.type === "message.processed");
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
    const finished = [{ outcome, trace: messageTrace }];
    expect(completions).toMatchObject(finished);
    expect(starts[0]).toMatchObject({ channel: "cron", source: "cron-isolated" });
    expect(events.filter((event) => event.type === "message.dispatch.completed")).toMatchObject(
      finished,
    );
    const usage = events.find((event) => event.type === "model.usage");
    expect(usage?.trace).toMatchObject({
      traceId: messageTrace?.traceId,
      parentSpanId: harnessTrace?.spanId,
    });
    expect(getActiveDiagnosticTraceContext()).toBeUndefined();
  });

  it("emits final lifecycle events under the adopted run session id", async () => {
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: sessionStorePath,
        sessionEntry: makeCronSessionEntry({
          sessionId: "fallback-run-session",
          sessionFile: path.join(path.dirname(sessionStorePath), "fallback-run-session.jsonl"),
        }),
      }),
    );
    runWithModelFallbackMock.mockResolvedValue(
      fallbackResult({
        sessionId: "persisted-run-session",
        sessionFile: path.join(path.dirname(sessionStorePath), "persisted-run-session.jsonl"),
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
