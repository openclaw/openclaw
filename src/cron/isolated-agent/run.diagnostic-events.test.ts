import { beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { onAgentRuntimeEvent } from "../../infra/agent-events.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  type DiagnosticEventPayload,
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
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

const hasAnyAuthProfileStoreSourceAsyncMock = vi.hoisted(() => vi.fn(() => false));
// mock-isolation: Cron diagnostics simulate missing auth sources without a credential-store owner.
vi.mock("../../agents/auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSourceAsync: hasAnyAuthProfileStoreSourceAsyncMock,
}));

import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  resolveCronSessionMock,
  resolveCronPayloadOutcomeMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams(cfg: OpenClawConfig = {}) {
  setRuntimeConfigSnapshot(cfg);
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
  subscribe: (
    listener: (event: DiagnosticEventPayload) => void,
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
      const fallback = fallbackResult({ usage: { input: 10, output: 20 } });
      return {
        ...fallback,
        result: {
          result: { ...fallback.result.result, diagnosticTrace: harnessTrace },
        },
      };
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
    expect(completions).toHaveLength(1);
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
    expect(completions[0]).toMatchObject({ outcome, trace: messageTrace });
    expect(starts[0]).toMatchObject({ channel: "cron", source: "cron-isolated" });
    expect(events.filter((event) => event.type === "message.dispatch.completed")).toMatchObject([
      { outcome, trace: messageTrace },
    ]);
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

  it.each([
    {
      name: "visible report",
      payloads: [{ text: "Report ready" }],
      text: "Report ready",
      visible: true,
      capture: true,
    },
    {
      name: "silent reply",
      payloads: [{ text: "NO_REPLY" }],
      text: "NO_REPLY",
      visible: false,
      capture: true,
    },
    { name: "empty reply", payloads: [], text: "", visible: false, capture: false },
    {
      name: "silent reply with media",
      payloads: [{ text: "NO_REPLY", mediaUrl: "https://example.invalid/report.png" }],
      text: "NO_REPLY",
      visible: true,
      capture: true,
    },
    {
      name: "synthetic workflow error",
      payloads: [{ text: "Delivery failed", isError: true }],
      text: "",
      visible: false,
      capture: false,
    },
    {
      name: "visible report without content capture",
      payloads: [{ text: "Report ready" }],
      text: "Report ready",
      visible: true,
      capture: false,
    },
  ])(
    "publishes unread visibility before lifecycle end for $name",
    async ({ payloads, text, visible, capture }) => {
      const { resolveCronPayloadOutcome } =
        await vi.importActual<typeof import("./helpers.js")>("./helpers.js");
      resolveCronPayloadOutcomeMock.mockImplementation(resolveCronPayloadOutcome);
      runWithModelFallbackMock.mockResolvedValueOnce({
        result: {
          result: {
            payloads,
            meta: {
              agentMeta: {},
              finalAssistantVisibleText: text,
              finalAssistantRawText: text,
              finalAssistantMessageRawText: text,
            },
          },
        },
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      });
      const terminalVisibility: Array<boolean | undefined> = [];
      const capturedResponses: Array<string | undefined> = [];
      const unsubscribeRun = onAgentRuntimeEvent((event) => {
        if (event.stream === "lifecycle" && event.data.phase === "end") {
          terminalVisibility.push(getAgentRunContext(event.runId)?.isControlUiVisible);
        }
      });
      const unsubscribeDiagnostics = onTrustedInternalDiagnosticEvent(
        (event, _metadata, privateData) => {
          if (event.type === "message.processed") {
            capturedResponses.push(privateData.messageContent?.finalResponse);
          }
        },
      );
      try {
        await runWithEvents(
          makeParams({
            diagnostics: { enabled: true, otel: { enabled: true, captureContent: capture } },
          }),
        );
        expect(terminalVisibility).toEqual([visible]);
        expect(capturedResponses).toEqual([capture ? text : undefined]);
      } finally {
        unsubscribeRun();
        unsubscribeDiagnostics();
      }
    },
  );

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
});
