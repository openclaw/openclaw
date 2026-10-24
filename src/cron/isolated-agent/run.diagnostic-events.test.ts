import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePreparedRunAdmission } from "../../agents/admitted-run-context.js";
import { prepareAgentRunTerminalReply } from "../../agents/agent-run-terminal-reply.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { derivePersistedSessionLifecyclePatch } from "../../config/sessions/session-run-lifecycle-projection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration, onAgentRuntimeEvent } from "../../infra/agent-events.js";
import * as diagnostics from "../../infra/diagnostic-events.js";
import * as trace from "../../infra/diagnostic-trace-context.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";
import { deriveSessionUnread } from "../../shared/session-unread.js";
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

function makeParams(config: OpenClawConfig = {}) {
  return makeIsolatedAgentParamsFixture({
    cfg: { ...config, session: { ...config.session, store: sessionStorePath } },
  });
}
function fallback(agentMeta: Record<string, unknown>, diagnosticTrace?: TraceContext) {
  const result = { payloads: [{ text: "test output" }], meta: { agentMeta }, diagnosticTrace };
  return { result: { result }, provider: "openai", model: "gpt-5.4", attempts: [] };
}
async function runWithEvents(
  params: Parameters<typeof runCron>[0] = makeParams(),
  publicEvents = false,
  events: diagnostics.DiagnosticEventPayload[] = [],
) {
  const listener = (event: diagnostics.DiagnosticEventPayload) => events.push(event);
  const unsubscribe = publicEvents
    ? diagnostics.onDiagnosticEvent(listener)
    : diagnostics.onInternalDiagnosticEvent(listener, {
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
    const result = await runCron(params);
    await diagnostics.waitForDiagnosticEventsDrained();
    return { result, events };
  } finally {
    unsubscribe();
  }
}

describe("runCronIsolatedAgentTurn diagnostic events", () => {
  setupRunCronIsolatedAgentTurnSuite();
  beforeEach(() => {
    resetDiagnosticStateForTest();
    diagnostics.resetDiagnosticEventsForTest();
    sessionStorePath = path.join(sessionDirs.make(), "sessions.json");
    harness.resolveCronSessionMock.mockReturnValue(
      harness.makeCronSession({ storePath: sessionStorePath }),
    );
  });

  it("anchors cron execution to a child message lifecycle trace and restores its parent", async () => {
    const parent = trace.createDiagnosticTraceContext();
    const observedEvents: diagnostics.DiagnosticEventPayload[] = [];
    let dispatchStartedBeforeExecution = false;
    let executionTrace: TraceContext | undefined;
    let harnessTrace: TraceContext | undefined;
    harness.runWithModelFallbackMock.mockImplementationOnce(async () => {
      await Promise.resolve();
      dispatchStartedBeforeExecution = observedEvents.some(
        (event) => event.type === "message.dispatch.started",
      );
      executionTrace = trace.getActiveDiagnosticTraceContext();
      harnessTrace = trace.createDiagnosticTraceContextFromActiveScope();
      return fallback({ usage: { input: 10, output: 20 } }, harnessTrace);
    });

    const { result, events } = await trace.runWithDiagnosticTraceContext(parent, async () => {
      const run = await runWithEvents(makeParams(), false, observedEvents);
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
  });

  it("emits final lifecycle events under the adopted run session id", async () => {
    harness.resolveCronSessionMock.mockReturnValue(
      harness.makeCronSession({
        storePath: sessionStorePath,
        sessionEntry: harness.makeCronSessionEntry({
          sessionId: "fallback-run-session",
        }),
      }),
    );
    harness.runWithModelFallbackMock.mockResolvedValue(
      fallback({
        sessionId: "persisted-run-session",
        usage: { input: 10, output: 20 },
      }),
    );
    const { result, events } = await runWithEvents(makeParams(), true);
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
    {
      name: "reasoning-only reply",
      payloads: [{ text: "Private reasoning", isReasoning: true }],
      text: "",
      visible: false,
      capture: false,
    },
    {
      name: "silent terminal with an earlier draft",
      payloads: [{ text: "Earlier draft" }],
      text: "NO_REPLY",
      visible: false,
      capture: false,
    },
    {
      name: "heartbeat acknowledgement",
      payloads: [{ text: "HEARTBEAT_OK" }],
      text: "HEARTBEAT_OK",
      visible: false,
      capture: true,
    },
  ])(
    "projects unread visibility before lifecycle end for $name",
    async ({ payloads, text, visible, capture }) => {
      const { resolveCronPayloadOutcome } =
        await vi.importActual<typeof import("./helpers.js")>("./helpers.js");
      harness.resolveCronPayloadOutcomeMock.mockImplementation(resolveCronPayloadOutcome);
      harness.mockRunCronFallbackPassthrough();
      harness.runEmbeddedAgentMock.mockImplementationOnce(
        async (params: RunEmbeddedAgentParams) => {
          await resolvePreparedRunAdmission({ ...params, runtimeKind: "embedded" });
          await params.onExecutionStarted?.();
          const reply = prepareAgentRunTerminalReply({ rawText: text });
          return {
            payloads,
            meta: {
              durationMs: 0,
              agentMeta: {},
              terminalReply: reply.terminalReply,
              finalAssistantVisibleText: reply.text,
              finalAssistantRawText: text,
              finalAssistantMessageRawText: text,
            },
          };
        },
      );
      const terminalVisibility: boolean[] = [];
      const terminalUnread: boolean[] = [];
      const capturedResponses: Array<string | undefined> = [];
      const readState = { createdAt: 1, lastReadAt: 2, lastActivityAt: 2 };
      const unsubscribeRun = onAgentRuntimeEvent((event) => {
        if (event.stream === "lifecycle" && event.data.phase === "end") {
          terminalVisibility.push(event.controlUiVisible === true);
          const patch = derivePersistedSessionLifecyclePatch({
            entry: readState,
            event,
            currentLifecycleGeneration: getAgentEventLifecycleGeneration(),
          });
          terminalUnread.push(deriveSessionUnread({ ...readState, ...patch }));
        }
      });
      const unsubscribeDiagnostics = diagnostics.onTrustedInternalDiagnosticEvent(
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
        expect(terminalUnread).toEqual([visible]);
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
    harness.runWithModelFallbackMock.mockImplementationOnce(async () => {
      abortController.abort("cron: job execution timed out");
      return fallback({ sessionId: "late-session", usage: { input: 50, output: 10, total: 60 } });
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
