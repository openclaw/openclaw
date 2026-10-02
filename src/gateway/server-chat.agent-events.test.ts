// Server chat agent-event tests protect event fanout, heartbeat visibility,
// session lifecycle persistence, and subscriber registry behavior.

import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ChatEventSchema } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildAgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.js";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import {
  createAgentAttemptLifecycleCallbacks,
  type AgentAttemptLifecycleState,
} from "../agents/command/attempt-callbacks.js";
import { createAgentCommandLifecycle } from "../agents/command/lifecycle.js";
import { createSubscribedSessionHarness } from "../agents/embedded-agent-subscribe.e2e-harness.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../agents/internal-runtime-context.js";
import { createAgentLifecycleTerminalBackstop } from "../auto-reply/reply/agent-lifecycle-terminal.js";
import {
  emitAgentEvent as emitRuntimeAgentEvent,
  emitAgentEventForOwner,
  emitAgentEventForRunContext,
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import {
  clearAgentRunContext as clearRegisteredAgentRunContext,
  claimAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import { subscribePluginSessionsChanged } from "../plugins/services.test-support.js";
import { GatewayClientRegistry } from "./server/client-registry.js";

const persistGatewaySessionLifecycleEventMock = vi.fn();
const loadGatewaySessionLifecycleSnapshotMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.fn();
const logWarnMock = vi.fn();
const loadGatewaySessionRow = vi.hoisted(() => vi.fn());

vi.mock("../logger.js", () => ({
  logError: (...args: unknown[]) => logErrorMock(...args),
  logWarn: (...args: unknown[]) => logWarnMock(...args),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
}));

vi.mock("../infra/heartbeat-visibility.js", () => ({
  resolveHeartbeatVisibility: vi.fn(() => ({
    showOk: false,
    showAlerts: true,
    useIndicator: true,
  })),
}));

vi.mock("./session-utils.js", () => {
  const loadSessionEntry = vi.fn(() => ({
    cfg: {},
    storePath: "/tmp/sessions.json",
    store: {},
    entry: undefined,
    canonicalKey: "session-1",
    storeKeys: ["session-1"],
    legacyKey: undefined,
  }));
  return {
    loadSessionEntry,
    loadGatewaySessionEntryReadOnly: loadSessionEntry,
  };
});

import { getRuntimeConfig } from "../config/io.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import { makeClient, registerNodeSession } from "./node-registry.test-helpers.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import {
  emitAgentEvent,
  emitAgentEvents,
  registerChatRun,
  registerNamedChatRun,
} from "./server-chat.agent-events.test-helpers.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createChatAbortMarker,
  createSessionMessageSubscriberRegistry,
  type AgentEventHandlerOptions,
} from "./server-chat.js";
import { broadcastChatError, broadcastChatFinal } from "./server-methods/chat-broadcast.js";
import { createGatewayNodeSessionRuntime } from "./server-node-session-runtime.js";
import * as sessionEventRows from "./session-event-prepared-row.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { loadSessionEntry } from "./session-utils.js";

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

describe("agent event handler", () => {
  let lineageProjection: ReturnType<typeof createSessionRowProjectionFixture> | undefined;
  beforeEach(() => {
    lineageProjection = undefined;
    resetAgentEventsForTest({ preserveListeners: true });
    vi.mocked(getRuntimeConfig).mockReturnValue({});
    vi.mocked(resolveHeartbeatVisibility).mockReturnValue({
      showOk: false,
      showAlerts: true,
      useIndicator: true,
    });
    vi.mocked(loadSessionEntry)
      .mockReset()
      .mockReturnValue({
        cfg: {},
        agentId: "main",
        storePath: "/tmp/sessions.json",
        store: {},
        entry: undefined,
        canonicalKey: "session-1",
        storeKeys: ["session-1"],
        legacyKey: undefined,
      });
    vi.mocked(loadGatewaySessionRow).mockReset().mockReturnValue(null);
    loadGatewaySessionLifecycleSnapshotMock
      .mockReset()
      .mockImplementation((sessionKey, options) => ({
        row: options
          ? loadGatewaySessionRow(sessionKey, options)
          : loadGatewaySessionRow(sessionKey),
      }));
    persistGatewaySessionLifecycleEventMock.mockReset().mockResolvedValue(undefined);
    logErrorMock.mockReset();
    logWarnMock.mockReset();
  });

  afterEach(() => {
    lineageProjection?.dispose();
    vi.useRealTimers();
    resetAgentEventsForTest({ preserveListeners: true });
  });

  function createHarness(params?: {
    now?: number;
    resolveSessionKeyForRun?: (runId: string, options?: { agentId?: string }) => string | undefined;
    lifecycleErrorRetryGraceMs?: number;
    isChatSendRunActive?: (runId: string) => boolean;
    settleTrackedTerminal?: AgentEventHandlerOptions["settleTrackedTerminal"];
    trackTrackedRunTerminalPersistence?: AgentEventHandlerOptions["trackTrackedRunTerminalPersistence"];
    resolveActiveLifecycleGenerationForRun?: (runId: string) => string | undefined;
    updateRunToolErrorSummary?: AgentEventHandlerOptions["updateRunToolErrorSummary"];
    resolveSessionActiveRunState?: AgentEventHandlerOptions["resolveSessionActiveRunState"];
  }) {
    const nowSpy =
      params?.now === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(params.now);
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const nodeHasSessionSubscribers = vi.fn(() => true);
    const clearAgentRunContext = vi.fn();
    const clearTrackedActiveRun =
      vi.fn<NonNullable<AgentEventHandlerOptions["clearTrackedActiveRun"]>>();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const toolEventRecipients = chatRunState.toolEventRecipients;
    const sessionEventSubscribers = createSessionEventSubscriberRegistry();
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();

    const projection = lineageProjection;
    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      nodeHasSessionSubscribers,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: params?.resolveSessionKeyForRun ?? (() => undefined),
      clearAgentRunContext,
      toolEventRecipients,
      sessionEventSubscribers,
      sessionMessageSubscribers,
      loadGatewaySessionLifecycleSnapshotForEvent: loadGatewaySessionLifecycleSnapshotMock,
      persistGatewaySessionLifecycleEventForEvent: persistGatewaySessionLifecycleEventMock,
      lifecycleErrorRetryGraceMs: params?.lifecycleErrorRetryGraceMs,
      isChatSendRunActive: params?.isChatSendRunActive,
      clearTrackedActiveRun,
      settleTrackedTerminal: params?.settleTrackedTerminal,
      trackTrackedRunTerminalPersistence: params?.trackTrackedRunTerminalPersistence,
      resolveActiveLifecycleGenerationForRun: params?.resolveActiveLifecycleGenerationForRun,
      updateRunToolErrorSummary: params?.updateRunToolErrorSummary,
      resolveSessionActiveRunState: params?.resolveSessionActiveRunState,
      getSessionRowProjection: () => projection,
    });

    return {
      emit: emitAgentEvent.bind(undefined, handler),
      emitMany: emitAgentEvents.bind(undefined, handler),
      end: emitLifecycleEnd.bind(undefined, handler),
      register: registerChatRun.bind(undefined, chatRunState),
      registerNamed: registerNamedChatRun.bind(undefined, chatRunState),
      chat: () => chatBroadcastCalls(broadcast),
      agent: () => agentBroadcastCalls(broadcast),
      targetedChat: () => chatBroadcastCalls(broadcastToConnIds),
      targetedAgent: () => agentBroadcastCalls(broadcastToConnIds),
      deltas: () => chatDeltaTexts(broadcast),
      targetedDeltas: () => chatDeltaTexts(broadcastToConnIds),
      nodeChat: () => sessionChatCalls(nodeSendToSession),
      nodeAgent: () => sessionAgentCalls(nodeSendToSession),
      changes: () => sessionChangedCalls(broadcastToConnIds),
      nowSpy,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      nodeHasSessionSubscribers,
      clearAgentRunContext,
      clearTrackedActiveRun,
      agentRunSeq,
      chatRunState,
      toolEventRecipients,
      sessionEventSubscribers,
      sessionMessageSubscribers,
      handler,
    };
  }

  function mockSessionEntry(
    entry: ReturnType<typeof loadSessionEntry>["entry"],
    canonicalKey = "session-1",
  ) {
    vi.mocked(loadSessionEntry).mockReturnValue({
      cfg: {},
      agentId: "main",
      storePath: "/tmp/sessions.json",
      store: {},
      entry,
      canonicalKey,
      storeKeys: [canonicalKey],
      legacyKey: undefined,
    });
  }

  function chatBroadcastCalls(broadcast: ReturnType<typeof vi.fn>) {
    return broadcast.mock.calls.filter(([event]) => event === "chat");
  }

  function chatDeltaTexts(broadcast: ReturnType<typeof vi.fn>) {
    return chatBroadcastCalls(broadcast)
      .map(([, payload]) => payload as { state?: string; deltaText?: string })
      .filter((payload) => payload.state === "delta")
      .map((payload) => payload.deltaText);
  }

  function agentBroadcastCalls(broadcast: ReturnType<typeof vi.fn>) {
    return broadcast.mock.calls.filter(([event]) => event === "agent");
  }

  function sessionChangedCalls(broadcast: ReturnType<typeof vi.fn>) {
    return broadcast.mock.calls.filter(([event]) => event === "sessions.changed");
  }

  function answerCandidate(
    itemId: string,
    progressText: string,
    status: "candidate" | "selected" | "superseded" = "candidate",
  ) {
    return {
      itemId,
      kind: "answer_candidate",
      title: "Answer candidate",
      phase: "update",
      status,
      progressText,
      source: "codex-app-server",
      hideFromChannelProgress: true,
    };
  }

  function sessionChatCalls(nodeSendToSession: ReturnType<typeof vi.fn>) {
    return nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
  }

  function widgetResult(id: string, target = "assistant_message", title = id) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            kind: "canvas",
            presentation: { target, title, sandbox: "scripts" },
            view: { id, url: `/__openclaw__/canvas/documents/${id}/index.html` },
          }),
        },
      ],
    };
  }

  it("projects successful widgets into live assistant snapshots without final text", () => {
    const h = createHarness();
    h.registerNamed("widgets", {
      chatSendTiming: {
        ackedAtMs: 0,
        receivedAtMs: 0,
        dispatchStartedAtMs: 0,
        connId: "conn-widgets",
      },
    });
    h.emitMany("run-widgets", [
      ["tool", { phase: "result", name: "show_widget", result: widgetResult("alpha") }],
      ["tool", { phase: "result", name: "show_widget", result: widgetResult("beta") }],
      ["tool", { phase: "result", name: "show_widget", result: widgetResult("alpha") }],
      ["assistant", { text: "" }],
      ["lifecycle", { phase: "end" }],
    ]);

    const content = ["alpha", "beta"].map((id) => ({
      type: "canvas",
      preview: {
        kind: "canvas",
        surface: "assistant_message",
        render: "url",
        title: id,
        url: `/__openclaw__/canvas/documents/${id}/index.html`,
        viewId: id,
        sandbox: "scripts",
      },
      rawText: null,
    }));
    expect(h.chat().at(-1)?.[1]).toMatchObject({
      message: { role: "assistant", content },
    });
    for (const [, payload] of h.chat()) {
      expect(payload.message?.content).toEqual(content);
      expect(Value.Check(ChatEventSchema, payload)).toBe(true);
    }
    expect(h.nodeChat().at(-1)?.[2].message.content).toEqual(content);
    expect(
      h.broadcastToConnIds.mock.calls.filter(([event]) => event === "chat.send_timing"),
    ).toEqual([
      [
        "chat.send_timing",
        expect.objectContaining({
          phase: "first-assistant-event",
          runId: "client-widgets",
          sessionKey: "session-widgets",
        }),
        new Set(["conn-widgets"]),
        { dropIfSlow: true },
      ],
    ]);

    h.registerNamed("widgets");
    h.broadcast.mockClear();
    h.emitMany("run-widgets", [
      ["assistant", { text: "Next turn." }],
      ["lifecycle", { phase: "end" }],
    ]);
    expect(h.chat().at(-1)?.[1]).toMatchObject({
      message: { content: [{ type: "text", text: "Next turn." }] },
    });
  });

  it("keeps live widget snapshots bounded without retaining failed or node-panel results", () => {
    vi.useFakeTimers();
    const h = createHarness();
    h.registerNamed("widgets");
    let seq = 0;
    const id = (index: number) => `cv_${index.toString(16).padStart(32, "0")}`;
    const publish = (result: ReturnType<typeof widgetResult>, isError = false) =>
      h.emit(
        "run-widgets",
        "tool",
        {
          phase: "result",
          name: "show_widget",
          result,
          isError,
        },
        { seq: ++seq },
      );
    const publishWidget = (index: number, titleChars = 1_700) => {
      const result = widgetResult(id(index), "assistant_message", "a".repeat(titleChars));
      // These fixtures survive embedded and default Codex tool-result text caps.
      expect(result.content[0]?.text.length).toBeLessThan(8_000);
      publish(result);
    };
    const snapshot = () => {
      h.emit("run-widgets", "assistant", { text: `Widgets ready: ${seq}.` }, { seq: ++seq });
      vi.advanceTimersByTime(75);
      return h
        .chat()
        .at(-1)?.[1]
        .message.content.filter((block: { type: string }) => block.type === "canvas")
        .map((block: { preview: { viewId: string } }) => block.preview.viewId);
    };
    publish(widgetResult("failed"), true);
    publish(widgetResult("node", "node_panel"));
    for (let index = 0; index < 34; index++) {
      publishWidget(index);
    }
    const initial = Array.from({ length: 32 }, (_, index) => id(index + 2));
    expect(snapshot()).toEqual(initial);
    publishWidget(33);
    expect(snapshot()).toEqual(initial);
    expect(logWarnMock).not.toHaveBeenCalled();

    publishWidget(34, 7_000);
    const firstEviction = Array.from({ length: 30 }, (_, index) => id(index + 5));
    expect.soft(snapshot()).toEqual(firstEviction);
    publishWidget(34, 7_000);
    expect.soft(snapshot()).toEqual(firstEviction);
    expect.soft(logWarnMock).toHaveBeenCalledTimes(1);
    publishWidget(35, 7_000);
    publishWidget(36, 7_000);
    expect.soft(snapshot()).toEqual(Array.from({ length: 25 }, (_, index) => id(index + 12)));
    expect.soft(logWarnMock).toHaveBeenCalledTimes(3);

    // A descriptor that cannot fit alone must retire the old suffix too.
    publish(widgetResult(id(37), "assistant_message", "a".repeat(65_536)));
    expect.soft(snapshot()).toEqual([]);
    publish(widgetResult(id(38), "assistant_message", "a".repeat(65_536)));
    expect.soft(snapshot()).toEqual([]);
    publishWidget(39);
    expect.soft(snapshot()).toEqual([id(39)]);
    expect
      .soft(logWarnMock.mock.calls)
      .toEqual(
        Array.from({ length: 5 }, () => [
          "Live chat canvas preview omitted: display descriptors exceed the 64 KiB limit.",
        ]),
      );
    h.emit("run-widgets", "lifecycle", { phase: "end" }, { seq: ++seq });
    expect(h.chat().at(-1)?.[1].message.content).toHaveLength(2);
    h.handler.dispose();
  });

  it.each(["silent", "heartbeat"])("does not revive widgets from a %s turn", (mode) => {
    const h = createHarness();
    h.registerNamed("widgets");
    if (mode === "heartbeat") {
      registerAgentRunContext("run-widgets", { sessionKey: "session-widgets", isHeartbeat: true });
    }
    h.emitMany("run-widgets", [
      ["tool", { phase: "result", name: "show_widget", result: widgetResult("hidden") }],
      ["assistant", { text: mode === "silent" ? "NO_REPLY" : "" }],
      ["lifecycle", { phase: "end" }],
    ]);
    expect(h.chat().at(-1)?.[1].message).toBeUndefined();
    h.handler.dispose();
  });

  it("drops failed-attempt widgets before a runtime retry succeeds", () => {
    vi.useFakeTimers();
    const h = createHarness({ lifecycleErrorRetryGraceMs: 100 });
    h.registerNamed("widgets");
    h.emitMany("run-widgets", [
      ["tool", { phase: "result", name: "show_widget", result: widgetResult("failed-attempt") }],
      ["lifecycle", { phase: "error", error: "retryable failure" }],
      ["tool", { phase: "result", name: "show_widget", result: widgetResult("retried") }],
      ["lifecycle", { phase: "end" }],
    ]);
    expect(h.chat().at(-1)?.[1]).toMatchObject({
      state: "final",
      message: { content: [{ type: "canvas", preview: { viewId: "retried" } }] },
    });
    expect(vi.getTimerCount()).toBe(0);
    h.handler.dispose();
  });

  it("retires tool-only widgets when a new owner reuses the run before assistant text", () => {
    const h = createHarness();
    const runId = "widget-owner-reuse";
    const claim = () =>
      expectDefined(
        claimAgentRunContext(
          runId,
          { sessionKey: "session-widgets", isControlUiVisible: false },
          { exclusive: true, trackOwner: true },
        ),
        "widget run owner claim",
      );
    const firstClaim = claim();
    let currentClaim = firstClaim;
    h.sessionMessageSubscribers.subscribe("conn-widgets", "session-widgets");
    const stop = onAgentRuntimeEvent(h.handler);
    const emitWidget = (id: string, owner: string) =>
      emitAgentEventForOwner(
        {
          runId,
          stream: "tool",
          data: { phase: "result", name: "show_widget", result: widgetResult(id) },
        },
        owner,
      );
    try {
      emitWidget("retired", firstClaim);
      releaseAgentRunContext(runId, firstClaim);
      currentClaim = claim();
      emitWidget("fresh", currentClaim);
      emitWidget("late", firstClaim);
      emitAgentEventForOwner({ runId, stream: "lifecycle", data: { phase: "end" } }, currentClaim);
      expect(h.targetedChat().at(-1)?.[1]).toMatchObject({
        state: "final",
        message: { content: [{ type: "canvas", preview: { viewId: "fresh" } }] },
      });
    } finally {
      stop();
      releaseAgentRunContext(runId, firstClaim);
      releaseAgentRunContext(runId, currentClaim);
      h.handler.dispose();
      h.chatRunState.clear();
    }
  });

  it("retains standalone warnings and Guardian decisions in the client-owned reconnect snapshot", () => {
    const h = createHarness();
    h.register("provider-run", "session-1", "client-run");

    h.emitMany("provider-run", [
      ["notice", { phase: "warning", message: "Custom execution rules were not applied." }],
      [
        "codex_app_server.guardian",
        { phase: "started", reviewId: "network-review", targetItemId: null, status: "inProgress" },
      ],
      [
        "codex_app_server.guardian",
        { phase: "completed", reviewId: "network-review", targetItemId: null, status: "denied" },
      ],
    ]);

    expect(h.chatRunState.runs.get("client-run")?.progressSnapshot?.events).toMatchObject([
      {
        runId: "client-run",
        sessionKey: "session-1",
        stream: "notice",
        data: { phase: "warning", message: "Custom execution rules were not applied." },
      },
      {
        runId: "client-run",
        sessionKey: "session-1",
        stream: "codex_app_server.guardian",
        data: { phase: "completed", reviewId: "network-review", status: "denied" },
      },
    ]);

    h.emit(
      "provider-run",
      "codex_app_server.guardian",
      {
        phase: "strict_review_required",
        reviewId: "command-review",
        targetItemId: "command-item",
      },
      { seq: 4 },
    );
    expect(
      h.chatRunState.runs.get("client-run")?.progressSnapshot?.events.at(-1)?.data,
    ).toMatchObject({ phase: "strict_review_required", reviewId: "command-review" });

    h.emit(
      "provider-run",
      "codex_app_server.guardian",
      {
        phase: "completed",
        reviewId: "command-review",
        targetItemId: "command-item",
        status: "approved",
      },
      { seq: 5 },
    );
    expect(h.chatRunState.runs.get("client-run")?.progressSnapshot?.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({ reviewId: "command-review" }),
        }),
      ]),
    );
  });

  it("does not reserialize captured progress when registered live events evict old activity", () => {
    const h = createHarness();
    h.register("provider-run", "session-1", "client-run");
    const stop = onAgentRuntimeEvent(h.handler);
    const emit = (seq: number) =>
      emitRuntimeAgentEvent({
        runId: "provider-run",
        stream: "item",
        data: { kind: "preamble", itemId: `item-${seq}`, progressText: "x".repeat(2_048) },
      });
    for (let seq = 1; seq <= 50; seq += 1) {
      emit(seq);
    }
    const retained = h.chatRunState.runs.get("client-run")?.progressSnapshot?.events.at(-1);
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      emit(51);
      expect(stringify.mock.calls.filter(([value]) => value === retained)).toHaveLength(0);
      const snapshot = h.chatRunState.runs.get("client-run")?.progressSnapshot;
      expect(snapshot?.events).toHaveLength(50);
      expect(snapshot?.events[0]?.seq).toBe(2);
      expect(snapshot?.events.at(-1)?.seq).toBe(51);
    } finally {
      stringify.mockRestore();
      stop();
      h.handler.dispose();
    }
  });

  it("records, replaces, dismisses, and clears normalized plan snapshots", () => {
    const h = createHarness();
    h.register("provider-run", "session-1", "client-run");
    h.emit(
      "provider-run",
      "plan",
      {
        phase: "update",
        explanation: "  Initial plan  ",
        steps: ["Legacy step", { step: "Active step", status: "in_progress" }],
      },
      { ts: 1_000 },
    );
    expect(h.chatRunState.runs.get("client-run")?.planSnapshot).toEqual({
      explanation: "Initial plan",
      steps: [
        { step: "Legacy step", status: "pending" },
        { step: "Active step", status: "in_progress" },
      ],
    });

    h.emit(
      "provider-run",
      "plan",
      { phase: "update", steps: [{ step: "Replacement", status: "completed" }] },
      { seq: 2, ts: 1_100 },
    );
    expect(h.chatRunState.runs.get("client-run")?.planSnapshot).toEqual({
      steps: [{ step: "Replacement", status: "completed" }],
    });

    h.emit(
      "provider-run",
      "plan",
      { phase: "update", steps: [] },
      {
        seq: 3,
        ts: 1_200,
      },
    );
    expect(h.chatRunState.runs.get("client-run")?.planSnapshot).toEqual({ steps: [] });

    h.chatRunState.getOrCreate("client-run").planSnapshot = {
      steps: [{ step: "Temporary", status: "pending" }],
    };
    h.chatRunState.clearRun("client-run");
    expect(h.chatRunState.runs.get("client-run")?.planSnapshot).toBeUndefined();
  });

  it.each([
    { stream: "assistant", data: { text: "Recovered" } },
    { stream: "tool", data: { phase: "start", name: "read" } },
  ] as const)("clears stale validation diagnostics on $stream progress", (progressEvent) => {
    const updateRunToolErrorSummary = vi.fn();
    const h = createHarness({ updateRunToolErrorSummary });
    h.register("provider-run", "session-1", "client-run");
    h.emit(
      "provider-run",
      "tool",
      {
        phase: "result",
        name: "edit",
        isError: true,
        toolErrorSummary: "edit tool validation failed: invalid arguments",
      },
      { ts: 1_000 },
    );
    expect(updateRunToolErrorSummary).toHaveBeenCalledWith({
      runId: "provider-run",
      clientRunId: "client-run",
      summary: "edit tool validation failed: invalid arguments",
    });
    h.emit("provider-run", progressEvent.stream, progressEvent.data, {
      seq: 2,
      ts: 1_100,
    });

    expect(updateRunToolErrorSummary).toHaveBeenLastCalledWith({
      runId: "provider-run",
      clientRunId: "client-run",
      summary: undefined,
    });
  });

  function sessionAgentCalls(nodeSendToSession: ReturnType<typeof vi.fn>) {
    return nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
  }

  const requireRecord = createRequireRecord("object", "label-not-object");

  function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
    for (const [key, value] of Object.entries(fields)) {
      expect(record[key]).toEqual(value);
    }
  }

  function expectPayloadFields(value: unknown, fields: Record<string, unknown>) {
    expectRecordFields(requireRecord(value, "event payload"), fields);
  }

  function expectPayloadDataFields(value: unknown, fields: Record<string, unknown>) {
    const payload = requireRecord(value, "event payload");
    expectRecordFields(requireRecord(payload.data, "event payload data"), fields);
  }

  function requireMockArg(
    mock: ReturnType<typeof vi.fn>,
    index: number,
    argIndex: number,
    label: string,
  ) {
    return expectDefined(mock.mock.calls[index], `${label} call ${index + 1}`)[argIndex];
  }

  function requireMockPayload(
    mock: ReturnType<typeof vi.fn>,
    index: number,
    payloadIndex: number,
    label: string,
  ) {
    return requireRecord(requireMockArg(mock, index, payloadIndex, label), label);
  }

  function emitLifecycleEnd(handler: Parameters<typeof emitAgentEvent>[0], runId: string, seq = 2) {
    emitAgentEvent(handler, runId, "lifecycle", { phase: "end" }, { seq });
  }

  it("sanitizes only broadcasted assistant buffers while preserving cross-frame tags", () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const h = createHarness();
    h.registerNamed("lazy-sanitize");

    const deltas = [
      "Visible",
      `\n${INTERNAL_RUNTIME_CONTEXT_BEGIN.slice(0, 20)}`,
      `${INTERNAL_RUNTIME_CONTEXT_BEGIN.slice(20)}\nprivate runtime detail\n`,
      ...Array.from({ length: 16 }, (_, index) => `private fragment ${index}\n`),
      INTERNAL_RUNTIME_CONTEXT_END.slice(0, 18),
      `${INTERNAL_RUNTIME_CONTEXT_END.slice(18)}\nAfter [[reply_`,
      "to_current]] done",
    ];
    deltas.forEach((delta, index) => {
      now = 10_000 + index;
      h.emit("run-lazy-sanitize", "assistant", { delta }, { seq: index + 1 });
    });

    expect(h.chat()).toHaveLength(1);
    h.end("run-lazy-sanitize", deltas.length + 1);

    const payloads = h.chat().map(([, payload]) => payload) as Array<{
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    }>;
    expect(payloads.map((payload) => payload.message?.content?.[0]?.text)).toEqual([
      "Visible",
      "Visible\n\nAfter  done",
      "Visible\n\nAfter  done",
    ]);
    expect(JSON.stringify(payloads)).not.toContain("private runtime detail");
    nowSpy.mockRestore();
  });

  it.each(["rate_limit", "timeout"])(
    "keeps %s retries transient through long backoff and subsequent assistant output",
    (reason) => {
      vi.useFakeTimers();
      const h = createHarness();
      h.registerNamed("retry");
      for (let attempt = 2; attempt <= 5; attempt++) {
        h.emit(
          "run-retry",
          "lifecycle",
          {
            phase: "finishing",
            error: "provider rate limit",
          },
          { seq: attempt * 2 },
        );
        h.emit(
          "run-retry",
          "run_status",
          {
            phase: "retrying",
            attempt,
            maxAttempts: 10,
            reason,
          },
          { seq: attempt * 2 + 1 },
        );
        vi.advanceTimersByTime(30_000);
      }
      expect(h.chat().map(([, payload]) => payload)).toEqual(
        [2, 3, 4, 5].map((attempt) =>
          expect.objectContaining({
            runId: "client-retry",
            state: "status",
            phase: "starting_model",
            ...(reason === "rate_limit" ? { retry: { attempt, maxAttempts: 10, reason } } : {}),
          }),
        ),
      );
      expect(h.clearAgentRunContext).not.toHaveBeenCalled();
      expect(persistGatewaySessionLifecycleEventMock).not.toHaveBeenCalled();
      h.emit("run-retry", "assistant", { text: "I", delta: "I" }, { seq: 12 });
      vi.advanceTimersByTime(500);
      h.emit("run-retry", "assistant", { text: "I agree", delta: " agree" }, { seq: 13 });
      h.end("run-retry", 14);
      expect(h.chat().map(([, payload]) => payload.state)).toEqual([
        "status",
        "status",
        "status",
        "status",
        "delta",
        "delta",
        "final",
      ]);
      expect(h.chat().at(-1)?.[1]).toMatchObject({
        runId: "client-retry",
        message: { content: [{ type: "text", text: "I agree" }] },
      });
    },
  );

  it("keeps hidden progress batched while timer callbacks are overdue", async () => {
    vi.useFakeTimers();
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const h = createHarness();
    const runs = Array.from(
      {
        length: 32,
      },
      (_, index) => {
        const name = `overdue-${index}`;
        const run = {
          runId: `run-${name}`,
          clientRunId: `client-${name}`,
          sessionKey: `session-${name}`,
          recipient: `conn-${name}`,
          chunks: Array.from(
            {
              length: 5,
            },
            (_chunk, step) => `[${index}:${step}]🚀`,
          ),
        };
        h.registerNamed(name);
        registerAgentRunContext(run.runId, {
          sessionKey: run.sessionKey,
          isControlUiVisible: false,
        });
        h.sessionMessageSubscribers.subscribe(run.recipient, run.sessionKey);
        return run;
      },
    );
    const delivery = h.broadcastToConnIds;
    const progressFor = (runId: string) =>
      agentBroadcastCalls(delivery)
        .map(([, payload]) => payload as AgentEventPayload)
        .filter((payload) => payload.runId === runId);
    const chatFor = (runId: string) =>
      chatBroadcastCalls(delivery)
        .map(([, payload]) => payload)
        .filter((payload) => payload.runId === runId);
    const emitStep = (step: number) => {
      for (const run of runs) {
        const text = run.chunks.slice(0, step + 1).join("");
        h.emit(run.runId, "item", answerCandidate("shared-item", text), {
          seq: step * 2 + 1,
        });
        h.emit(
          run.runId,
          "assistant",
          {
            text,
            delta: run.chunks[step],
          },
          {
            seq: step * 2 + 2,
          },
        );
      }
    };
    const leadingFrames = 1;
    try {
      emitStep(0);
      now += 1;
      emitStep(1);
      // Advance wall time without servicing timers, as when ingress occupies the event loop.
      now += 100;
      emitStep(2);
      for (const run of runs) {
        expect(progressFor(run.clientRunId)).toHaveLength(leadingFrames);
      }
      expect(loadGatewaySessionLifecycleSnapshotMock).toHaveBeenCalledTimes(runs.length);
      vi.advanceTimersByTime(75);
      expect(loadGatewaySessionLifecycleSnapshotMock).toHaveBeenCalledTimes(runs.length * 2);
      for (const run of runs) {
        const progress = progressFor(run.clientRunId);
        expect(progress).toHaveLength(leadingFrames * 2);
        expect(progress.findLast((event) => event.stream === "item")?.data.progressText).toBe(
          run.chunks.slice(0, 3).join(""),
        );
      }

      // A fresh post-idle batch must also wait for a wake, even with no previous tail queued.
      now += 200;
      emitStep(3);
      now += 100;
      emitStep(4);
      for (const run of runs) {
        expect(progressFor(run.clientRunId)).toHaveLength(leadingFrames * 2);
      }
      vi.advanceTimersByTime(1);
      for (const run of runs) {
        const expected = run.chunks.join("");
        const progress = progressFor(run.clientRunId);
        expect(progress).toHaveLength(leadingFrames * 3);
        expect(progress.findLast((event) => event.stream === "item")?.data).toEqual(
          answerCandidate("shared-item", expected),
        );
        expect(progress.every((event) => event.sessionKey === run.sessionKey)).toBe(true);
        expect(
          progress
            .filter((event) => event.stream === "assistant")
            .map((event) => event.data.delta)
            .join(""),
        ).toBe("");
        h.emit(run.runId, "item", answerCandidate("shared-item", expected, "selected"), {
          seq: 11,
        });
        h.end(run.runId, 12);
        const chat = chatFor(run.clientRunId);
        expect(
          chat
            .filter((payload) => payload.state === "delta")
            .map((payload) => payload.deltaText)
            .join(""),
        ).toBe(expected);
        expect(chat.at(-1)).toMatchObject({
          state: "final",
          message: {
            content: [
              {
                type: "text",
                text: expected,
              },
            ],
          },
        });
        const scopedCalls = delivery.mock.calls.filter(
          ([, payload]) => payload.runId === run.clientRunId,
        );
        for (const [, payload, recipients] of scopedCalls) {
          expect(payload.sessionKey).toBe(run.sessionKey);
          expect(recipients).toEqual(new Set([run.recipient]));
        }
      }
      expect(h.broadcast).not.toHaveBeenCalled();
      expect(h.nodeSendToSession).not.toHaveBeenCalled();
      const completedCalls = delivery.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(delivery).toHaveBeenCalledTimes(completedCalls);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      h.handler.dispose();
      h.chatRunState.clear();
      nowSpy.mockRestore();
    }
  });

  it.each([
    [
      "native item start",
      "item",
      { itemId: "command-1", kind: "command", title: "Command", phase: "start" },
    ],
  ] as const)("flushes candidate and assistant progress before %s", (_name, stream, data) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const h = createHarness();
    h.registerNamed("candidate-boundary");
    h.toolEventRecipients.add("run-candidate-boundary", "conn-tools");

    try {
      h.emitMany("run-candidate-boundary", [
        ["item", answerCandidate("answer-1", "Hel")],
        ["assistant", { text: "Hel", delta: "Hel" }],
        ["item", answerCandidate("answer-1", "Hello")],
        ["assistant", { text: "Hello", delta: "lo" }],
      ]);
      expect(h.agent().length).toBeLessThanOrEqual(2);

      h.emit("run-candidate-boundary", stream, data, { seq: 5 });
      const delivered = [h.broadcast, h.broadcastToConnIds]
        .flatMap((sink) =>
          sink.mock.calls.flatMap(([event, payload], index) =>
            event === "agent"
              ? [
                  {
                    order: expectDefined(sink.mock.invocationCallOrder[index], "agent call order"),
                    payload: payload as AgentEventPayload,
                  },
                ]
              : [],
          ),
        )
        .toSorted((a, b) => a.order - b.order)
        .map(({ payload }) => payload);
      expect(delivered.filter((payload) => payload.seq >= 3)).toMatchObject([
        { seq: 3, stream: "item", data: answerCandidate("answer-1", "Hello") },
        { seq: 4, stream: "assistant", data: { text: "Hello" } },
        { seq: 5, stream, data },
      ]);
      expect(
        delivered
          .filter((payload) => payload.seq < 5 && payload.stream === "assistant")
          .map((payload) => payload.data.delta)
          .join(""),
      ).toBe("Hello");

      h.end("run-candidate-boundary", 6);
      const completedCalls = h.broadcast.mock.calls.length;
      vi.advanceTimersByTime(1_000);
      expect(h.broadcast).toHaveBeenCalledTimes(completedCalls);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      h.handler.dispose();
      h.chatRunState.clear();
    }
  });

  it("isolates candidate batches across runs and releases an aborted run before session reuse", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const h = createHarness();
    h.registerNamed("candidate-abort");
    h.registerNamed("candidate-sibling");
    const deliveredFor = (runId: string) =>
      h
        .agent()
        .map(([, payload]) => payload as AgentEventPayload)
        .filter((payload) => payload.runId === runId);

    try {
      for (const [runId, prefix] of [
        ["run-candidate-abort", "Alpha"],
        ["run-candidate-sibling", "Beta"],
      ] as const) {
        h.emitMany(runId, [
          ["item", answerCandidate("shared-item-id", prefix)],
          ["assistant", { text: prefix, delta: prefix }],
          ["item", answerCandidate("shared-item-id", `${prefix} tail`)],
          ["assistant", { text: `${prefix} tail`, delta: " tail" }],
        ]);
      }
      expect(h.agent().length).toBeLessThanOrEqual(4);
      const siblingBeforeAbort = deliveredFor("client-candidate-sibling");
      h.emit(
        "run-candidate-abort",
        "item",
        answerCandidate("shared-item-id", "Alpha tail", "superseded"),
        {
          seq: 5,
        },
      );
      h.emit(
        "run-candidate-abort",
        "lifecycle",
        { phase: "error", aborted: true, stopReason: "rpc" },
        { seq: 6 },
      );
      expect(deliveredFor("client-candidate-sibling")).toEqual(siblingBeforeAbort);
      expect(h.chat().at(-1)?.[1]).toMatchObject({
        runId: "client-candidate-abort",
        state: "aborted",
        message: { content: [{ type: "text", text: "Alpha tail" }] },
      });

      h.register("run-reuse", "session-candidate-abort", "client-reuse");
      h.emitMany("run-reuse", [
        ["item", answerCandidate("shared-item-id", "Fresh")],
        ["assistant", { text: "Fresh", delta: "Fresh" }],
        ["item", answerCandidate("shared-item-id", "Fresh", "selected")],
        ["lifecycle", { phase: "end" }],
      ]);
      const abortedDeliveries = deliveredFor("client-candidate-abort");
      vi.advanceTimersByTime(75);
      expect(deliveredFor("client-candidate-abort")).toEqual(abortedDeliveries);
      const sibling = deliveredFor("client-candidate-sibling");
      expect(sibling.findLast((payload) => payload.stream === "item")?.data).toEqual(
        answerCandidate("shared-item-id", "Beta tail"),
      );
      expect(
        sibling
          .filter((payload) => payload.stream === "assistant")
          .map((payload) => payload.data.delta)
          .join(""),
      ).toBe("Beta tail");
      h.emit(
        "run-candidate-sibling",
        "item",
        answerCandidate("shared-item-id", "Beta tail", "selected"),
        { seq: 5 },
      );
      h.end("run-candidate-sibling", 6);
      expect(
        h
          .chat()
          .map(([, payload]) => payload)
          .filter((payload) => payload.state === "final")
          .map((payload) => [payload.runId, payload.message.content[0].text]),
      ).toEqual([
        ["client-reuse", "Fresh"],
        ["client-candidate-sibling", "Beta tail"],
      ]);
      const completedCalls = h.broadcast.mock.calls.length;
      vi.advanceTimersByTime(1_000);
      expect(h.broadcast).toHaveBeenCalledTimes(completedCalls);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      h.handler.dispose();
      h.chatRunState.clear();
    }
  });

  it("flushes older cross-stream agent deltas before immediate text", () => {
    let now = 23_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const h = createHarness();
    h.registerNamed("agent-cross-stream");

    h.emit("run-agent-cross-stream", "thinking", {
      text: "Think",
      delta: "Think",
    });
    now = 23_050;
    h.emit("run-agent-cross-stream", "thinking", { text: "Thinking", delta: "ing" }, { seq: 2 });
    expect(h.agent()).toHaveLength(1);
    expect(h.nodeAgent()).toHaveLength(1);
    now = 23_080;
    h.emit("run-agent-cross-stream", "assistant", { text: "Answer", delta: "Answer" }, { seq: 3 });

    const agentCalls = h.agent();
    expect(agentCalls.map(([, payload]) => (payload as { seq?: number }).seq)).toEqual([1, 2, 3]);
    expect(agentCalls.map(([, payload]) => (payload as { stream?: string }).stream)).toEqual([
      "thinking",
      "thinking",
      "assistant",
    ]);
    expectPayloadDataFields(agentCalls[1]?.[1], { delta: "ing" });
    expect(h.nodeAgent()).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("does not let lifecycle start throttle the first assistant agent event", () => {
    let now = 25_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const h = createHarness();
    h.registerNamed("agent-start");

    h.emit("run-agent-start", "lifecycle", { phase: "start" });
    now = 25_050;
    h.emit("run-agent-start", "assistant", { text: "Hello", delta: "Hello" }, { seq: 2 });

    const agentCalls = h.agent();
    expect(agentCalls).toHaveLength(2);
    expectPayloadFields(agentCalls[0]?.[1], { stream: "lifecycle" });
    expectPayloadDataFields(agentCalls[1]?.[1], { text: "Hello" });
    expect(h.nodeAgent()).toHaveLength(2);
    nowSpy.mockRestore();
  });

  it("keeps a media-only assistant event pending without an empty or raw delta", () => {
    const h = createHarness({ now: 1_000 });
    h.registerNamed("media-only");

    h.emit(
      "run-media-only",
      "assistant",
      {
        text: "MEDIA:./attachment-catalog-tiny/demo.jpg",
        managedMediaUrls: ["./attachment-catalog-tiny/demo.jpg"],
      },
      { seq: 1 },
    );
    expect(h.chat()).toHaveLength(0);

    h.end("run-media-only", 2);
    const payloads = h.chat().map(([, payload]) => payload) as Array<{
      state?: string;
      message?: unknown;
    }>;
    expect(payloads).toEqual([expect.objectContaining({ state: "final", message: undefined })]);
    expect(JSON.stringify(payloads)).not.toContain("MEDIA:");
    h.nowSpy?.mockRestore();
  });

  it("withholds split MEDIA prefixes before a relative directive is complete", () => {
    const h = createHarness({ now: 1_000 });
    h.registerNamed("split-media");

    for (const [index, delta] of [
      "Prepared the batch.\n  M",
      "EDIA:./attachment-catalog-tiny/",
      "demo.jpg",
    ].entries()) {
      h.emit(
        "run-split-media",
        "assistant",
        {
          delta,
          ...(index === 2 ? { managedMediaUrls: ["./attachment-catalog-tiny/demo.jpg"] } : {}),
        },
        { seq: index + 1 },
      );
    }
    h.end("run-split-media", 4);

    const payloads = h.chat().map(([, payload]) => payload) as Array<{
      message?: { content?: Array<{ text?: string }> };
    }>;
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      const text = payload.message?.content?.[0]?.text ?? "";
      expect(text).not.toMatch(/(?:^|\n)\s*(?:M|ME|MED|MEDI|MEDIA:)/u);
      expect(text).not.toContain("attachment-catalog-tiny");
    }
    expect(payloads.at(-1)?.message?.content?.[0]?.text).toBe("Prepared the batch.");
    h.nowSpy?.mockRestore();
  });

  it("preserves an ordinary relative reference without managed-media facts", () => {
    const text = "MEDIA:./image.png";
    const h = createHarness({ now: 1_000 });
    h.registerNamed("ordinary-relative-media");

    h.emit(
      "run-ordinary-relative-media",
      "assistant",
      { text, delta: "", mediaUrls: [text.slice("MEDIA:".length)] },
      { seq: 1 },
    );
    h.end("run-ordinary-relative-media", 2);

    const finalPayload = h.chat().at(-1)?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe(text);
    h.nowSpy?.mockRestore();
  });

  it("restores an ordinary MEDIA-like prefix when the assistant run ends", () => {
    const h = createHarness({ now: 1_000 });
    h.registerNamed("terminal-media-prefix");

    h.emit(
      "run-terminal-media-prefix",
      "assistant",
      { text: "The selected size is\nM" },
      { seq: 1 },
    );
    h.end("run-terminal-media-prefix", 2);

    const finalPayload = h.chat().at(-1)?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("The selected size is\nM");
    h.nowSpy?.mockRestore();
  });

  it("retracts a visible item replaced by NO_REPLY with a 0 ms flush", () => {
    const { token, flushMs } = { token: "NO_REPLY", flushMs: 0 };

    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const h = createHarness();
    h.registerNamed("control-replacement");
    h.emit("run-control-replacement", "assistant", {
      itemId: "answer-1",
      text: "Provisional answer",
    });
    expect(h.deltas()).toEqual(["Provisional answer"]);
    h.emit(
      "run-control-replacement",
      "assistant",
      {
        itemId: "answer-1",
        text: token,
      },
      { seq: 2 },
    );
    vi.advanceTimersByTime(flushMs);
    h.end("run-control-replacement", 3);

    const payloads = h.chat().map(([, payload]) => payload);
    expect(payloads).toMatchObject([
      { state: "delta", message: { content: [{ text: "Provisional answer" }] } },
      { state: "delta", replace: true, deltaText: "", message: { content: [{ text: "" }] } },
      { state: "final" },
    ]);
    expect(payloads.at(-1)?.message).toBeUndefined();
    expect(h.nodeChat()).toHaveLength(payloads.length);
    h.handler.dispose();
    h.chatRunState.clear();
  });

  it("releases a held control-token prefix as a final short reply", () => {
    const h = createHarness({ now: 2_200 });
    h.registerNamed("4");
    h.emit("run-4", "assistant", { text: "No" });
    h.end("run-4");
    expect(h.chat()).toHaveLength(1);
    expect(h.chat()[0]?.[1]).toMatchObject({
      state: "final",
      message: { content: [{ text: "No" }] },
    });
    expect(h.nodeChat()).toHaveLength(1);
    h.nowSpy?.mockRestore();
  });

  it("strips a glued leading NO_REPLY token from cumulative chat snapshots", () => {
    const h = createHarness({
      now: 2_250,
    });
    h.registerNamed("4b");

    h.emitMany("run-4b", [
      ["assistant", { text: "NO_REPLYThe user" }],
      ["assistant", { text: "NO_REPLYThe user is saying hello" }],
    ]);
    h.end("run-4b");

    const chatCalls = h.chat();
    const finalPayload = chatCalls.at(-1)?.[1] as {
      message?: { content?: Array<{ text?: string }> };
      state?: string;
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("The user is saying hello");
    expect(
      chatCalls.every(([, payload]) => {
        const text = (payload as { message?: { content?: Array<{ text?: string }> } }).message
          ?.content?.[0]?.text;
        return !text || !text.includes("NO_REPLY");
      }),
    ).toBe(true);
    expect(h.nodeChat()).toHaveLength(chatCalls.length);
    h.nowSpy?.mockRestore();
  });

  it("flushes merged segmented text before final when latest segment is throttled", () => {
    let now = 10_800;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const h = createHarness();
    h.registerNamed("segmented-flush");

    h.emit("run-segmented-flush", "assistant", {
      text: "Before tool call",
      delta: "Before tool call",
    });

    now = 10_860;
    h.emit(
      "run-segmented-flush",
      "assistant",
      { text: "After tool call", delta: "\nAfter tool call" },
      { seq: 2 },
    );

    h.end("run-segmented-flush", 3);

    const chatCalls = h.chat();
    expect(chatCalls).toHaveLength(3);
    const flushPayload = chatCalls[1]?.[1] as {
      state?: string;
      deltaText?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    const finalPayload = chatCalls[2]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(flushPayload.state).toBe("delta");
    expect(flushPayload.deltaText).toBe("\nAfter tool call");
    expect(flushPayload.message?.content?.[0]?.text).toBe("Before tool call\nAfter tool call");
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("Before tool call\nAfter tool call");
    expect(h.nodeChat()).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("cancels trailing deltas when gateway chat state is cleared", () => {
    vi.useFakeTimers();
    let now = 14_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const h = createHarness();
    h.registerNamed("shutdown-trailing");

    h.emit("run-shutdown-trailing", "assistant", {
      text: "Hello",
      delta: "Hello",
    });
    now = 14_020;
    h.emit(
      "run-shutdown-trailing",
      "assistant",
      { text: "Hello world", delta: " world" },
      { seq: 2 },
    );
    expect(vi.getTimerCount()).toBe(2);

    h.chatRunState.clear();
    expect(vi.getTimerCount()).toBe(0);
    now = 14_500;
    vi.advanceTimersByTime(1_000);
    expect(h.deltas()).toEqual(["Hello"]);
    expect(h.agent()).toHaveLength(1);
    nowSpy.mockRestore();
  });

  it("flushes a scoped replacement empty text before final", () => {
    const text = "";

    let now = 11_700;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const h = createHarness();
    h.registerNamed("short-replacement-flush");

    h.emit("run-short-replacement-flush", "assistant", {
      text: "Hello world",
      itemId: "message-1",
    });

    now = 11_760;
    h.emit("run-short-replacement-flush", "assistant", { text, itemId: "message-1" }, { seq: 2 });

    h.end("run-short-replacement-flush", 3);

    const chatCalls = h.chat();
    expect(chatCalls).toHaveLength(3);
    const replacementPayload = chatCalls[1]?.[1] as {
      state?: string;
      deltaText?: string;
      replace?: boolean;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(replacementPayload.state).toBe("delta");
    expect(replacementPayload.deltaText).toBe(text);
    expect(replacementPayload.replace).toBe(true);
    expect(replacementPayload.message?.content?.[0]?.text).toBe(text);
    expectPayloadFields(chatCalls[2]?.[1], { state: "final" });
    expect(h.nodeChat()).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("keeps item ownership across message-2 correction Hi", () => {
    const { itemId, text, flags, expected } = {
      itemId: "message-2",
      text: "Hi",
      flags: { replace: true, replaceable: true },
      expected: "Hi",
    };

    const h = createHarness({
      now: 11_800,
    });
    h.registerNamed("item-correction");
    if (itemId === "message-1") {
      h.emit(
        "run-item-correction",
        "assistant",
        {
          itemId: "earlier",
          text: "Earlier",
        },
        { seq: 1 },
      );
    }
    h.emit(
      "run-item-correction",
      "assistant",
      {
        itemId: "message-1",
        text: "Hello",
        delta: "Hello",
      },
      { seq: itemId === "message-1" ? 2 : 1 },
    );
    h.emit(
      "run-item-correction",
      "assistant",
      { itemId, ...(text === undefined ? {} : { text }), ...flags },
      {
        seq: itemId === "message-1" ? 3 : 2,
      },
    );
    h.end("run-item-correction", itemId === "message-1" ? 4 : 3);

    const final = { state: "final", message: { content: [{ type: "text", text: expected }] } };
    expect(h.chat().at(-1)?.[1]).toMatchObject(final);
    expect(h.nodeChat().at(-1)?.[2]).toMatchObject(final);
    h.nowSpy?.mockRestore();
  });

  it("flushes buffered chat delta before tool start events", () => {
    let now = 12_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-tool-flush",
    });

    h.registerNamed("tool-flush");
    registerAgentRunContext("run-tool-flush", {
      sessionKey: "session-tool-flush",
      verboseLevel: "off",
    });
    h.toolEventRecipients.add("run-tool-flush", "conn-1");

    h.emit("run-tool-flush", "assistant", { text: "Before tool" });

    // Keep the second update inside the live-text pacing window.
    now = 12_050;
    h.emit("run-tool-flush", "assistant", { text: "Before tool expanded" }, { seq: 2 });

    h.emit(
      "run-tool-flush",
      "tool",
      { phase: "start", name: "read", toolCallId: "tool-flush-1" },
      { seq: 3 },
    );

    const chatCalls = h.chat();
    expect(chatCalls).toHaveLength(2);
    const flushedPayload = chatCalls[1]?.[1] as {
      state?: string;
      deltaText?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(flushedPayload.state).toBe("delta");
    expect(flushedPayload.deltaText).toBe(" expanded");
    expect(flushedPayload.message?.content?.[0]?.text).toBe("Before tool expanded");
    expect(h.nodeChat()).toHaveLength(2);

    expect(h.broadcastToConnIds).toHaveBeenCalledTimes(1);
    const flushCallIndex = h.broadcast.mock.calls.findIndex((call) => call === chatCalls[1]);
    const flushCallOrder = expectDefined(
      h.broadcast.mock.invocationCallOrder[flushCallIndex],
      "flushed chat delta invocation",
    );
    const toolCallOrder = expectDefined(
      h.broadcastToConnIds.mock.invocationCallOrder[0],
      "tool start invocation",
    );
    expect(flushCallOrder).toBeLessThan(toolCallOrder);
    nowSpy.mockRestore();
  });

  it("skips unused verbosity reads for registered visible without nodes tool deltas", () => {
    const audience = {
      audience: "visible without nodes",
      visible: true,
      subscribed: false,
      heartbeat: false,
    };

    const h = createHarness();
    const runId = "run-unused-verbosity";
    const sessionKey = "session-unused-verbosity";
    h.nodeHasSessionSubscribers.mockReturnValue(false);
    registerAgentRunContext(runId, {
      sessionKey,
      isControlUiVisible: audience.visible,
      isHeartbeat: audience.heartbeat,
      verboseLevel: "full",
    });
    if (audience.subscribed) {
      h.sessionMessageSubscribers.subscribe("conn-selected", sessionKey);
    }
    if (audience.visible && !audience.heartbeat) {
      h.chatRunState.toolEventRecipients.add(runId, "conn-selected");
    }
    const stop = onAgentRuntimeEvent(h.handler);
    try {
      for (let added = 1; added <= 32; added++) {
        emitRuntimeAgentEvent({
          runId,
          stream: "tool",
          data: { phase: "input_delta", toolCallId: "edit-1", diff: { added, removed: 0 } },
        });
      }
      expect(loadSessionEntry).not.toHaveBeenCalled();
      expect(h.broadcast).not.toHaveBeenCalled();
      expect(h.nodeSendToSession).not.toHaveBeenCalled();
      const delivered = h.targetedAgent();
      if ((audience.subscribed || audience.visible) && !audience.heartbeat) {
        expect(delivered.map(([, payload]) => payload.data.diff)).toEqual(
          Array.from({ length: 32 }, (_, index) => ({ added: index + 1, removed: 0 })),
        );
        expect(delivered.every((call) => call[2].has("conn-selected"))).toBe(true);
      } else {
        expect(delivered).toHaveLength(0);
        expect(loadGatewaySessionLifecycleSnapshotMock).not.toHaveBeenCalled();
      }
    } finally {
      stop();
      h.handler.dispose();
      h.chatRunState.clear();
      clearRegisteredAgentRunContext(runId);
    }
  });

  it("drops an expired run audience while preserving current session subscribers", () => {
    const h = createHarness({ now: 1_000, resolveSessionKeyForRun: () => "session-1" });
    try {
      registerAgentRunContext("run-expired", { sessionKey: "session-1", verboseLevel: "off" });
      h.toolEventRecipients.add("run-expired", "conn-run");
      h.sessionEventSubscribers.subscribe("conn-session");
      h.toolEventRecipients.markFinal("run-expired");
      h.nowSpy!.mockReturnValue(31_000);

      h.emit("run-expired", "tool", {
        phase: "result",
        name: "read",
        toolCallId: "late-result",
      });

      expect(
        h.broadcastToConnIds.mock.calls.map(([event, , recipients]) => [event, recipients]),
      ).toEqual([["session.tool", new Set(["conn-session"])]]);
    } finally {
      h.nowSpy?.mockRestore();
    }
  });

  it("uses newer session verbose state for in-flight tool events", () => {
    const h = createHarness({
      now: 1_000,
      resolveSessionKeyForRun: () => "session-1",
    });
    mockSessionEntry({ sessionId: "session-1", verboseLevel: "on", updatedAt: 1_500 });

    registerAgentRunContext("run-tool-toggle", {
      sessionKey: "session-1",
      verboseLevel: "off",
    });

    h.emit("run-tool-toggle", "tool", {
      phase: "start",
      name: "read",
      toolCallId: "t-toggle",
    });

    const nodeToolCalls = h.nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(1);
    const payload = requireRecord(nodeToolCalls[0]?.[2], "node tool payload");
    expect(payload.stream).toBe("tool");
    expectRecordFields(requireRecord(payload.data, "node tool payload data"), {
      phase: "start",
      name: "read",
    });
  });

  it("does not duplicate tool events to clients subscribed by run and session", () => {
    const runId = "provider-tool";
    const sessionKey = "session-dedupe";
    const h = createHarness({ resolveSessionKeyForRun: () => sessionKey });
    h.register(runId, sessionKey, "client-tool", { agentId: "work" });
    registerAgentRunContext(runId, { sessionKey, verboseLevel: "off" });
    h.toolEventRecipients.add(runId, "conn-overlap");
    h.toolEventRecipients.add(runId, "conn-run-only");
    h.sessionEventSubscribers.subscribe("conn-overlap");
    h.sessionEventSubscribers.subscribe("conn-session-only");
    h.emit(
      runId,
      "tool",
      {
        phase: "start",
        name: "exec",
        toolCallId: "tool-session-dedupe-1",
        args: { command: "echo hi" },
      },
      { ts: 1_234 },
    );
    expect(
      h.broadcastToConnIds.mock.calls.map(([event, payload, recipients]) => [
        event,
        payload.runId,
        payload.agentId,
        recipients,
      ]),
    ).toEqual([
      ["agent", "client-tool", "work", new Set(["conn-overlap", "conn-run-only"])],
      ["session.tool", "client-tool", "work", new Set(["conn-session-only"])],
    ]);
  });

  it("suppresses heartbeat tool events for Control UI and verbose node subscribers", () => {
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-heartbeat",
    });

    registerAgentRunContext("run-heartbeat-tool", {
      sessionKey: "session-heartbeat",
      isHeartbeat: true,
      verboseLevel: "on",
    });
    h.toolEventRecipients.add("run-heartbeat-tool", "conn-run");
    h.sessionEventSubscribers.subscribe("conn-session");

    h.emit(
      "run-heartbeat-tool",
      "tool",
      {
        phase: "start",
        name: "read",
        toolCallId: "tool-heartbeat-1",
        args: { path: "HEARTBEAT.md" },
      },
      { ts: 1_234 },
    );

    expect(h.broadcastToConnIds).not.toHaveBeenCalled();
    const nodeToolCalls = h.nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(0);
  });

  it("broadcasts terminal session status to session subscribers on lifecycle end", async () => {
    const runId = "provider-run";
    const clientRunId = "client-run";
    const sessionKey = "session-finished";
    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      key: sessionKey,
      kind: "direct",
      updatedAt: 1_700,
      status: "done",
      startedAt: 900,
      endedAt: 1_700,
      runtimeMs: 800,
      abortedLastRun: false,
    });
    const resolveSessionActiveRunState = vi
      .fn<NonNullable<AgentEventHandlerOptions["resolveSessionActiveRunState"]>>()
      .mockReturnValueOnce({ active: true, runIds: [runId] })
      .mockReturnValue({ active: false, runIds: [] });
    const h = createHarness({
      resolveSessionKeyForRun: () => sessionKey,
      resolveSessionActiveRunState,
    });
    h.sessionEventSubscribers.subscribe("conn-session");
    h.register(runId, sessionKey, clientRunId);
    registerAgentRunContext(runId, { sessionKey, verboseLevel: "off" });
    h.emitMany(runId, [
      ["lifecycle", { phase: "start", startedAt: 900 }, { ts: 1_000 }],
      ["lifecycle", { phase: "end", startedAt: 900, endedAt: 1_700 }, { seq: 2, ts: 1_800 }],
    ]);
    await waitForFast(() => expect(h.changes()).toHaveLength(2));
    const changes = h.changes();
    expectPayloadFields(changes[0]?.[1], {
      sessionKey,
      phase: "start",
      hasActiveRun: true,
      activeRunIds: [runId],
    });
    expectPayloadFields(changes[1]?.[1], {
      sessionKey,
      phase: "end",
      hasActiveRun: false,
      activeRunIds: [],
      status: "done",
      startedAt: 900,
      endedAt: 1_700,
      runtimeMs: 800,
      updatedAt: 1_700,
      abortedLastRun: false,
    });
    expect(resolveSessionActiveRunState).toHaveBeenCalledWith({
      requestedKey: sessionKey,
      canonicalKey: sessionKey,
    });
    const persistParams = requireRecord(
      persistGatewaySessionLifecycleEventMock.mock.calls.find(
        ([params]) => params.event.data.phase === "end",
      )?.[0],
      "terminal persistence",
    );
    expect(persistParams.sessionKey).toBe(sessionKey);
    const event = requireRecord(persistParams.event, "persisted event");
    expectRecordFields(event, { runId, clientRunId });
    expect(requireRecord(event.data, "lifecycle data").phase).toBe("end");
    expect(h.clearTrackedActiveRun).toHaveBeenCalledWith({ runId, clientRunId, sessionKey });
    const terminalCallIndex = h.broadcastToConnIds.mock.calls.indexOf(
      expectDefined(changes[1], "terminal session publication"),
    );
    expect(h.clearTrackedActiveRun.mock.invocationCallOrder[0]).toBeLessThan(
      h.broadcastToConnIds.mock.invocationCallOrder[terminalCallIndex] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("publishes run lifecycle changes to plugins without websocket subscribers", async () => {
    const sessionKey = "agent:main:headless-run";
    const received = vi.fn();
    const unsubscribe = subscribePluginSessionsChanged(received);
    const publisher = createGatewayBroadcaster({ clients: new GatewayClientRegistry() });
    const h = createHarness({
      resolveSessionKeyForRun: () => sessionKey,
    });
    h.broadcastToConnIds.mockImplementation(publisher.broadcastToConnIds);
    registerAgentRunContext("run-headless", { sessionKey, verboseLevel: "off" });

    try {
      h.emit("run-headless", "lifecycle", { phase: "start", startedAt: 900 });
      await waitForFast(() => {
        expect(received).toHaveBeenCalledWith({ sessionKey, phase: "start" });
      });

      h.emit(
        "run-headless",
        "lifecycle",
        { phase: "end", startedAt: 900, endedAt: 1_700 },
        { seq: 2, ts: 1_800 },
      );
      await waitForFast(() => {
        expect(received.mock.calls.map(([event]) => event.phase)).toEqual(["start", "end"]);
      });
    } finally {
      unsubscribe();
    }
  });

  it("suppresses late interrupted pre-restart lifecycle events from live projections", () => {
    mockSessionEntry(
      {
        sessionId: "session-recovery",
        updatedAt: 2_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "interrupted-run",
            lifecycleGeneration: "pre-restart",
          },
        ],
      },
      "session-recovery",
    );
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-recovery",
      lifecycleErrorRetryGraceMs: 0,
    });
    h.sessionEventSubscribers.subscribe("conn-session");
    h.register("interrupted-run", "session-recovery", "interrupted-run");

    h.emit(
      "interrupted-run",
      "lifecycle",
      {
        phase: "end",
        aborted: true,
        stopReason: "restart",
        endedAt: 2_100,
      },
      {
        seq: 2,
        lifecycleGeneration: "pre-restart",
        sessionKey: "session-recovery",
        sessionId: "session-recovery",
        ts: 2_100,
      },
    );

    expect(h.chat()).toHaveLength(0);
    expect(h.changes()).toHaveLength(0);
    expect(persistGatewaySessionLifecycleEventMock).not.toHaveBeenCalled();
    expect(h.chatRunState.registry.peek("interrupted-run")).toBeUndefined();
    expect(h.clearAgentRunContext).toHaveBeenCalledWith("interrupted-run");
    expect(h.clearTrackedActiveRun).toHaveBeenCalledWith({
      runId: "interrupted-run",
      clientRunId: "interrupted-run",
      sessionKey: "session-recovery",
    });
  });

  it("broadcasts canonical state after concurrent recovery completions persist", async () => {
    const restartRecoveryRuns = [
      {
        runId: "run-a",
        lifecycleGeneration: "pre-restart-a",
      },
      {
        runId: "run-b",
        lifecycleGeneration: "pre-restart-b",
      },
    ];
    mockSessionEntry(
      {
        sessionId: "session-recovery",
        updatedAt: 2_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns,
      },
      "session-recovery",
    );
    let currentRow = {
      key: "session-recovery",
      kind: "direct" as const,
      sessionId: "session-recovery",
      updatedAt: 2_000,
      status: "running" as "done" | "running",
      abortedLastRun: true,
    };
    vi.mocked(loadGatewaySessionRow).mockImplementation(() => currentRow);
    const runA = createDeferred();
    const runB = createDeferred();
    persistGatewaySessionLifecycleEventMock.mockImplementation(
      ({ event }: { event: { runId: string } }) =>
        event.runId === "run-a" ? runA.promise : runB.promise,
    );
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-recovery",
      lifecycleErrorRetryGraceMs: 0,
    });
    h.sessionEventSubscribers.subscribe("conn-session");

    for (const [runId, lifecycleGeneration, seq] of [
      ["run-a", "pre-restart-a", 1],
      ["run-b", "pre-restart-b", 2],
    ] as const) {
      h.handler({
        runId,
        lifecycleGeneration,
        seq,
        stream: "lifecycle",
        sessionKey: "session-recovery",
        sessionId: "session-recovery",
        ts: 2_100 + seq,
        data: {
          phase: "end",
          endedAt: 2_100 + seq,
        },
      });
    }

    currentRow = { ...currentRow, updatedAt: 2_101 };
    runA.resolve();
    await waitForFast(() => expect(h.changes()).toHaveLength(1));
    expectPayloadFields(requireMockArg(h.broadcastToConnIds, 0, 1, "run-a session snapshot"), {
      status: "running",
      abortedLastRun: true,
      endedAt: null,
      runtimeMs: null,
    });

    currentRow = {
      ...currentRow,
      updatedAt: 2_102,
      status: "done",
      abortedLastRun: false,
    };
    runB.resolve();
    await waitForFast(() => expect(h.changes()).toHaveLength(2));
    expectPayloadFields(requireMockArg(h.broadcastToConnIds, 1, 1, "run-b session snapshot"), {
      status: "done",
      abortedLastRun: false,
    });
  });

  it("broadcasts a terminal fallback snapshot when persistence fails", async () => {
    vi.mocked(loadGatewaySessionRow).mockReturnValue({
      key: "session-failed-write",
      kind: "direct",
      sessionId: "session-failed-write",
      updatedAt: 2_000,
      status: "running",
      startedAt: 1_000,
      abortedLastRun: false,
    });
    persistGatewaySessionLifecycleEventMock.mockRejectedValueOnce(
      new Error("disk full sk-abcdefghijklmnopqrstuvwxyz123456"),
    );
    const trackTrackedRunTerminalPersistence = vi.fn();
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-failed-write",
      lifecycleErrorRetryGraceMs: 0,
      trackTrackedRunTerminalPersistence,
    });
    h.sessionEventSubscribers.subscribe("conn-session");

    h.emit(
      "run-failed-write",
      "lifecycle",
      {
        phase: "end",
        endedAt: 2_100,
      },
      { seq: 2, sessionKey: "session-failed-write", sessionId: "session-failed-write", ts: 2_100 },
    );

    await waitForFast(() => expect(h.changes()).toHaveLength(1));
    expectPayloadFields(requireMockArg(h.broadcastToConnIds, 0, 1, "fallback session snapshot"), {
      status: "done",
      updatedAt: 2_100,
      abortedLastRun: false,
    });
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock).toHaveBeenCalledWith(
      "gateway: terminal session persistence failed session=session-failed-write run=run-failed-write error=Error: disk full sk-abc…3456",
    );
    expect(trackTrackedRunTerminalPersistence).toHaveBeenCalledWith({
      runId: "run-failed-write",
      clientRunId: "run-failed-write",
      sessionKey: "session-failed-write",
      sessionId: "session-failed-write",
      persistence: expect.any(Promise),
    });
    expect(trackTrackedRunTerminalPersistence.mock.invocationCallOrder[0]).toBeLessThan(
      h.broadcastToConnIds.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("cancels a deferred old-generation error before a same-id retry", () => {
    vi.useFakeTimers();
    const runId = "shared-run";
    const sessionKey = "session-recovery";
    let activeLifecycleGeneration = "pre-restart";
    const context = { sessionKey, sessionId: sessionKey };
    registerAgentRunContext(runId, { ...context, lifecycleGeneration: activeLifecycleGeneration });
    const h = createHarness({
      resolveSessionKeyForRun: () => sessionKey,
      lifecycleErrorRetryGraceMs: 100,
      resolveActiveLifecycleGenerationForRun: () => activeLifecycleGeneration,
    });
    h.register(runId, sessionKey, runId);
    const oldEvent = { ...context, lifecycleGeneration: "pre-restart" };
    h.emit(
      runId,
      "lifecycle",
      {
        phase: "error",
        error: "retryable provider failure",
        endedAt: 2_000,
      },
      { ...oldEvent, ts: 2_000 },
    );
    expect(vi.getTimerCount()).toBe(1);
    mockSessionEntry(
      {
        sessionId: sessionKey,
        updatedAt: 2_000,
        status: "running",
        restartRecoveryRuns: [{ runId, lifecycleGeneration: "pre-restart" }],
      },
      sessionKey,
    );
    activeLifecycleGeneration = "post-restart";
    registerAgentRunContext(runId, { ...context, lifecycleGeneration: activeLifecycleGeneration });
    h.agentRunSeq.set(runId, 4);
    h.chatRunState.getOrCreate(runId).buffer = "new retry output";
    h.emit(
      runId,
      "lifecycle",
      { phase: "end", endedAt: 2_100 },
      {
        ...oldEvent,
        seq: 3,
        ts: 2_100,
      },
    );
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(h.chatRunState.registry.peek(runId)).toBeDefined();
    expect(h.chatRunState.runs.get(runId)?.buffer).toBe("new retry output");
    expect(h.agentRunSeq.get(runId)).toBe(4);
    expect(h.clearAgentRunContext).not.toHaveBeenCalled();
    expect(h.clearTrackedActiveRun).not.toHaveBeenCalled();
    expect(persistGatewaySessionLifecycleEventMock).not.toHaveBeenCalled();
  });

  it("cancels deferred lifecycle errors when the handler is disposed", () => {
    vi.useFakeTimers();
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-dispose",
      lifecycleErrorRetryGraceMs: 100,
    });

    h.emit(
      "run-dispose",
      "lifecycle",
      { phase: "error", error: "retryable provider failure" },
      { sessionKey: "session-dispose", ts: 2_000 },
    );
    expect(vi.getTimerCount()).toBe(1);

    h.handler.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);

    expect(h.clearAgentRunContext).not.toHaveBeenCalled();
    expect(persistGatewaySessionLifecycleEventMock).not.toHaveBeenCalled();
    expect(h.chat().map(([, payload]) => payload.state)).not.toContain("error");
  });

  it("projects lifecycle self-aborts with their validation diagnostic", () => {
    const h = createHarness();
    h.register("provider-validation-loop", "session-validation-loop", "client-validation-loop");

    h.emit(
      "provider-validation-loop",
      "lifecycle",
      {
        phase: "end",
        aborted: true,
        toolErrorSummary: "edit tool validation failed: edits: must be an array",
      },
      { seq: 2, ts: 1_500 },
    );

    const chatCalls = h.chat();
    expect(chatCalls).toHaveLength(1);
    expect(expectDefined(chatCalls[0], "chatCalls[0] test invariant")[1]).toMatchObject({
      runId: "client-validation-loop",
      sessionKey: "session-validation-loop",
      seq: 2,
      state: "aborted",
      stopReason: "aborted",
      errorMessage: "edit tool validation failed: edits: must be an array",
    });
    expect(h.nodeChat()).toHaveLength(1);
    expect(h.chatRunState.registry.peek("provider-validation-loop")).toBeUndefined();
  });

  it("does not forward unsafe lifecycle abort diagnostics", () => {
    const h = createHarness();
    h.register("provider-unsafe-abort", "session-unsafe-abort", "client-unsafe-abort");

    h.emit(
      "provider-unsafe-abort",
      "lifecycle",
      {
        phase: "end",
        aborted: true,
        stopReason: "aborted",
        toolErrorSummary: "browser failed\nsecret output",
      },
      { seq: 2, ts: 1_500 },
    );

    const payload = expectDefined(
      h.chat()[0],
      "chatBroadcastCalls(broadcast)[0] test invariant",
    )[1] as Record<string, unknown>;
    expect(payload.state).toBe("aborted");
    expect(payload).not.toHaveProperty("errorMessage");
  });

  it("classifies a timeout end without error text via the recorded outcome", () => {
    // Idle/run-budget timeouts end with no error field; without deriving
    // errorKind from the terminal classification the projection falls back
    // to text-sniffing an undefined error and renders a generic "failed".
    const h = createHarness();
    h.register("provider-idle-timeout", "session-idle", "client-idle");

    h.emit(
      "provider-idle-timeout",
      "lifecycle",
      { phase: "end", aborted: true, stopReason: "timeout", timeoutPhase: "idle" },
      { seq: 2, ts: 1_500 },
    );

    const payload = expectDefined(
      h.chat()[0],
      "chatBroadcastCalls(broadcast)[0] test invariant",
    )[1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      runId: "client-idle",
      state: "error",
      stopReason: "timeout",
      errorKind: "timeout",
    });
  });

  it("ignores stale aborted markers from older same-key runs for fresh chat lifecycle events (same-millisecond older sequence)", () => {
    const h = createHarness({ now: 2_000 });
    h.chatRunState.getOrCreate("client-stale-abort").abortMarker = {
      abortedAtMs: 2_000,
      sequence: -1,
    };
    h.registerNamed("stale-abort");

    h.emit(
      "run-stale-abort",
      "assistant",
      { text: "Fresh output", delta: "Fresh output" },
      { ts: 2_100 },
    );
    h.emit("run-stale-abort", "lifecycle", { phase: "end" }, { seq: 2, ts: 2_200 });

    const chatCalls = h.chat();
    expect(chatCalls).toHaveLength(2);
    const deltaPayload = expectDefined(chatCalls[0], "chatCalls[0] test invariant")[1];
    const finalPayload = expectDefined(chatCalls[1], "chatCalls[1] test invariant")[1];
    expect(deltaPayload.state).toBe("delta");
    expect(finalPayload.state).toBe("final");
    expect(h.nodeChat()).toHaveLength(2);
    expect(h.chatRunState.runs.get("client-stale-abort")?.abortMarker).toBeDefined();
    expect(h.chatRunState.registry.peek("run-stale-abort")).toBeUndefined();
  });

  it("honors same-millisecond abort markers from the current same-key run", () => {
    const h = createHarness({ now: 3_000 });
    h.registerNamed("current-abort");
    h.chatRunState.getOrCreate("client-current-abort").abortMarker = createChatAbortMarker();

    h.emit(
      "run-current-abort",
      "assistant",
      { text: "Suppressed output", delta: "Suppressed output" },
      { ts: 3_100 },
    );
    h.emit(
      "run-current-abort",
      "lifecycle",
      { phase: "end", aborted: true, stopReason: "rpc" },
      { seq: 2, ts: 3_200 },
    );

    expect(h.chat()).toHaveLength(0);
    expect(h.nodeChat()).toHaveLength(0);
    expect(h.chatRunState.runs.get("client-current-abort")?.abortMarker).toBeDefined();
    expect(h.chatRunState.registry.peek("run-current-abort")).toBeUndefined();
  });

  it.each([
    {
      name: "keeps tool output only for Control UI recipients when verbose is on",
      runId: "run-tool-on",
      toolCallId: "t3",
      verboseLevel: "on",
      partialResult: { content: [{ type: "text", text: "partial" }] },
    },
    {
      name: "keeps tool output when verbose is full",
      runId: "run-tool-full",
      toolCallId: "t4",
      verboseLevel: "full",
      partialResult: undefined,
    },
  ] as const)("$name", ({ runId, toolCallId, verboseLevel, partialResult }) => {
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });
    const result = { content: [{ type: "text", text: "secret" }] };
    registerAgentRunContext(runId, { sessionKey: "session-1", verboseLevel });
    h.toolEventRecipients.add(runId, "conn-1");
    h.emit(runId, "tool", {
      phase: "result",
      name: "exec",
      toolCallId,
      result,
      ...(partialResult ? { partialResult } : {}),
    });

    expect(h.broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = requireMockArg(h.broadcastToConnIds, 0, 1, "tool output payload") as {
      data?: Record<string, unknown>;
    };
    expect(payload.data?.result).toEqual(result);
    expect(payload.data?.partialResult).toEqual(partialResult);
    const nodePayload = requireMockPayload(h.nodeSendToSession, 0, 2, "node tool output payload");
    const nodeData = requireRecord(nodePayload.data, "node tool output data");
    expect(nodeData.result).toEqual(verboseLevel === "full" ? result : undefined);
    expect(nodeData.partialResult).toBeUndefined();
  });

  it("routes hidden selected-agent global chat events only to matching subscribers", () => {
    const h = createHarness();
    h.sessionMessageSubscribers.subscribe("conn-main", "agent:main:global");
    h.sessionMessageSubscribers.subscribe("conn-work", "agent:work:global");
    h.register("run-hidden-main", "global", "client-hidden-main", {
      agentId: "main",
    });
    registerAgentRunContext("run-hidden-main", {
      sessionKey: "global",
      isControlUiVisible: false,
    });
    loadGatewaySessionLifecycleSnapshotMock.mockReturnValue({
      row: { key: "global", kind: "global", updatedAt: 1_000, sessionId: "main-global" },
    });

    h.emit("run-hidden-main", "assistant", { text: "hidden main global reply" });

    const chatCall = h.broadcastToConnIds.mock.calls.find(([event]) => event === "chat");
    expect(chatCall?.[2]).toEqual(new Set(["conn-main"]));
    expect(chatCall?.[1]).toEqual(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "global",
      }),
    );
    expect(chatCall?.[1]).not.toHaveProperty("session");
    h.emit(
      "run-hidden-main",
      "item",
      { kind: "status", phase: "update", title: "Working" },
      { seq: 2 },
    );
    expect(loadGatewaySessionLifecycleSnapshotMock).toHaveBeenCalledWith("global", {
      agentId: "main",
    });
    const agentCall = h.targetedAgent()[0];
    expect(agentCall?.[2]).toEqual(new Set(["conn-main"]));
    expect(agentCall?.[1].session).toMatchObject({ key: "global", sessionId: "main-global" });
  });

  it("routes hidden bare global chat events to the configured default agent subscriber", () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      agents: { list: [{ id: "main" }, { id: "ops", default: true }] },
    });
    const h = createHarness();
    h.sessionMessageSubscribers.subscribe("conn-main", "agent:main:global");
    h.sessionMessageSubscribers.subscribe("conn-ops", "agent:ops:global");
    h.register("run-hidden-default", "global", "client-hidden-default");
    registerAgentRunContext("run-hidden-default", {
      sessionKey: "global",
      isControlUiVisible: false,
    });
    loadGatewaySessionLifecycleSnapshotMock.mockReturnValue({
      row: { key: "global", kind: "global", updatedAt: 1_000, sessionId: "ops-global" },
    });

    h.emit("run-hidden-default", "assistant", {
      text: "hidden default global reply",
    });

    const chatCall = h.broadcastToConnIds.mock.calls.find(([event]) => event === "chat");
    expect(chatCall?.[2]).toEqual(new Set(["conn-ops"]));
    expect(chatCall?.[1]).toEqual(
      expect.objectContaining({
        sessionKey: "global",
      }),
    );
    expect(chatCall?.[1]).not.toHaveProperty("session");
    h.emit(
      "run-hidden-default",
      "item",
      { kind: "status", phase: "update", title: "Working" },
      { seq: 2 },
    );
    expect(loadGatewaySessionLifecycleSnapshotMock).toHaveBeenCalledWith("global", undefined);
    const agentCall = h.targetedAgent()[0];
    expect(agentCall?.[2]).toEqual(new Set(["conn-ops"]));
    expect(agentCall?.[1].session).toMatchObject({ key: "global", sessionId: "ops-global" });
  });

  it("keeps chat-linked run remapping alive across per-attempt lifecycle errors", () => {
    vi.useFakeTimers();
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
      lifecycleErrorRetryGraceMs: 100,
    });
    h.register("run-fallback-retry", "session-fallback", "run-fallback-client");

    h.emitMany("run-fallback-retry", [
      ["assistant", { text: "draft" }],
      ["lifecycle", { phase: "error", error: "provider failed" }],
    ]);

    expect(h.chatRunState.registry.peek("run-fallback-retry")).toMatchObject({
      sessionKey: "session-fallback",
      clientRunId: "run-fallback-client",
    });
    expect(h.clearAgentRunContext).not.toHaveBeenCalled();
    expect(h.agentRunSeq.get("run-fallback-retry")).toBe(2);

    h.emit(
      "run-fallback-retry",
      "lifecycle",
      {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
      { seq: 3, sessionKey: "session-fallback" },
    );
    const agentCalls = h.broadcast.mock.calls.filter(([event]) => event === "agent");
    const fallbackPayload = agentCalls.at(-1)?.[1] as {
      runId?: string;
      data?: Record<string, unknown>;
    };
    expect(fallbackPayload.runId).toBe("run-fallback-client");
    expect(fallbackPayload.data?.phase).toBe("fallback");
    expect(h.nodeAgent().at(-1)?.[2]).toMatchObject({
      runId: "run-fallback-client",
      data: { phase: "fallback" },
    });

    vi.advanceTimersByTime(100);

    expect(h.chatRunState.registry.peek("run-fallback-retry")).toMatchObject({
      sessionKey: "session-fallback",
      clientRunId: "run-fallback-client",
    });
    expect(h.chat().map(([, payload]) => payload.state)).not.toContain("error");
    expect(h.clearAgentRunContext).not.toHaveBeenCalled();
    expect(h.agentRunSeq.get("run-fallback-retry")).toBe(3);

    h.end("run-fallback-retry", 4);

    expect(h.chat().map(([, payload]) => payload.state)).not.toContain("error");
    const finalPayload = h.chat().at(-1)?.[1] as {
      state?: string;
      runId?: string;
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.runId).toBe("run-fallback-client");
    expect(h.clearAgentRunContext).toHaveBeenCalledWith("run-fallback-retry");
    expect(h.agentRunSeq.has("run-fallback-retry")).toBe(false);
  });

  it.each([
    ["fallback exhaustion", { fallbackExhaustedFailure: true }, "error"],
    ["native cancellation", { aborted: true, stopReason: "aborted" }, "aborted"],
  ])("finalizes %s immediately and retires the preceding retryable error", (_name, data, state) => {
    vi.useFakeTimers();
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-terminal-error",
    });
    const runId = "run-terminal-final-failure";
    registerAgentRunContext(runId, { sessionKey: "session-terminal-error" });
    h.emit(runId, "lifecycle", { phase: "error", error: "retryable failure" });
    expect(h.chat()).toHaveLength(0);

    h.emit(
      runId,
      "lifecycle",
      {
        phase: "error",
        error: "Terminal failure",
        ...data,
      },
      { seq: 2 },
    );

    expect(h.chat()).toHaveLength(1);
    expect(h.chat()[0]?.[1]).toMatchObject({ runId, state });
    expect(h.clearAgentRunContext).toHaveBeenCalledWith(runId);
    expect(h.agentRunSeq.has(runId)).toBe(false);
    expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(15_000);
    expect(h.chat()).toHaveLength(1);
    expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledOnce();
  });

  it("keeps deferred lifecycle-error cleanup across phase-less lifecycle events", () => {
    vi.useFakeTimers();
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-terminal-error",
      lifecycleErrorRetryGraceMs: 100,
    });
    registerAgentRunContext("run-terminal-late-lifecycle", {
      sessionKey: "session-terminal-error",
    });

    h.emitMany("run-terminal-late-lifecycle", [
      ["lifecycle", { phase: "start" }],
      ["lifecycle", { phase: "error", error: "request timed out" }],
      ["lifecycle", { msg: "status update" }],
    ]);

    vi.advanceTimersByTime(100);

    const finalPayload = h.chat().at(-1)?.[1] as {
      state?: string;
      runId?: string;
      errorMessage?: string;
    };
    expect(finalPayload.state).toBe("error");
    expect(finalPayload.runId).toBe("run-terminal-late-lifecycle");
    expect(finalPayload.errorMessage).toContain("request timed out");
    expect(h.clearAgentRunContext).toHaveBeenCalledWith("run-terminal-late-lifecycle");
    expect(h.agentRunSeq.has("run-terminal-late-lifecycle")).toBe(false);
  });

  it.each(["command", "reply"] as const)(
    "projects subscribed provider errors through %s ownership",
    (owner) => {
      const runId = "run-provider-error";
      const h = createHarness();
      const chatTerminals = () =>
        h.chat().filter(([, event]) => ["final", "error", "aborted"].includes(event.state));
      h.register(runId, "session-provider-detail", runId);
      const state: AgentAttemptLifecycleState = {
        currentTurnUserMessagePersisted: true,
        lifecycleFinishing: false,
        lifecycleEnded: false,
      };
      const callbacks = createAgentAttemptLifecycleCallbacks(state);
      const command = createAgentCommandLifecycle({
        runId,
        lifecycleGeneration: getAgentEventLifecycleGeneration,
        startedAt: 1,
        state,
      });
      const reply = createAgentLifecycleTerminalBackstop({
        runId,
        getLifecycleGeneration: getAgentEventLifecycleGeneration,
        resolveTerminationFields: () => ({}),
      });
      const onAgentEvent = vi.fn((event) => {
        if (owner === "command") {
          void callbacks.onAgentEvent(event);
        } else {
          reply.note(event);
        }
      });
      const unlisten = onAgentRuntimeEvent(h.handler);
      const { emit, subscription } = createSubscribedSessionHarness({
        runId,
        onAgentEvent,
        terminalLifecyclePhase: "finishing",
      });
      try {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            provider: "openai",
            model: "gpt-5.6-luna",
            content: [],
            errorMessage:
              '502 {"error":{"type":"server_error","message":"Upstream unavailable x-api-key: synthetic-provider-credential"}}',
          },
        });
        emit({ type: "agent_end" });
        expect(chatTerminals()).toHaveLength(0);
        if (owner === "command") {
          command.emitResultError({ payloads: [], meta: { durationMs: 0 } }, false, {
            metadata: {},
            outcome: buildAgentRunTerminalOutcome({ status: "error", stopReason: "error" }),
          });
        } else {
          reply.capture("error", "Provider failed");
          expect(chatTerminals()).toHaveLength(0);
          reply.emit("error", "Provider failed");
        }
        expect(chatTerminals()).toHaveLength(1);
        const payload = chatTerminals()[0]?.[1];
        const runtimeTerminal = h
          .agent()
          .find(([, event]) => event.stream === "lifecycle" && event.data.phase === "error")?.[1];
        expect(runtimeTerminal.data.executionSettled).toBe(true);
        const serialized = JSON.stringify(payload);
        const wire = JSON.parse(serialized);
        expect(Value.Check(ChatEventSchema, wire)).toBe(true);
        expect(h.nodeChat().at(-1)?.[2]).toEqual(payload);
        expect(wire.errorDetail).toEqual({
          provider: "openai",
          model: "gpt-5.6-luna",
          failoverReason: "server_error",
          providerRuntimeFailureKind: "timeout",
          providerErrorType: "server_error",
          httpStatus: 502,
          providerErrorMessagePreview: "Upstream unavailable x-api-key: ***",
        });
        const callbackTerminal = onAgentEvent.mock.calls.find(
          ([event]) => event.stream === "lifecycle" && event.data.error,
        )?.[0];
        expect(callbackTerminal.data.errorObservation).toMatchObject({
          provider: "openai",
          model: "gpt-5.6-luna",
          httpStatus: 502,
          providerErrorMessagePreview: wire.errorDetail.providerErrorMessagePreview,
        });
        expect(runtimeTerminal.data.errorObservation).toEqual(
          callbackTerminal.data.errorObservation,
        );
        expect(serialized).not.toContain("synthetic-provider-credential");
        expect(JSON.stringify(callbackTerminal.data.errorObservation)).not.toContain("rawError");
      } finally {
        subscription.unsubscribe();
        unlisten();
        h.handler.dispose();
      }
    },
  );

  it("bounds the chat error allowlist and omits invalid or log-only facts", () => {
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-bounded-error",
      lifecycleErrorRetryGraceMs: 0,
    });
    try {
      h.emit("run-bounded-error", "lifecycle", {
        phase: "error",
        error: "Request failed",
        errorObservation: {
          provider: "p".repeat(301),
          model: "m".repeat(301),
          failoverReason: "f".repeat(301),
          providerRuntimeFailureKind: "k".repeat(301),
          providerErrorType: "t".repeat(301),
          providerErrorMessagePreview: `${"x".repeat(299)}🚀tail`,
          httpStatus: "invalid",
          rawErrorPreview: "log-only",
          rawErrorHash: "log-only",
          errorBody: "log-only",
          unexpected: "log-only",
        },
      });
      const serialized = JSON.stringify(h.chat().at(-1)?.[1]);
      const payload = JSON.parse(serialized);
      expect(serialized).not.toContain("log-only");
      expect(payload.errorDetail).toEqual({
        provider: "p".repeat(300),
        model: "m".repeat(300),
        failoverReason: "f".repeat(300),
        providerRuntimeFailureKind: "k".repeat(300),
        providerErrorType: "t".repeat(300),
        providerErrorMessagePreview: "x".repeat(299),
      });
      expect(Value.Check(ChatEventSchema, payload)).toBe(true);
    } finally {
      h.handler.dispose();
    }
  });

  it("suppresses delayed lifecycle chat errors for active chat.send runs while still cleaning up", () => {
    vi.useFakeTimers();
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-chat-send",
      lifecycleErrorRetryGraceMs: 100,
      isChatSendRunActive: (runId) => runId === "run-chat-send",
    });
    registerAgentRunContext("run-chat-send", { sessionKey: "session-chat-send" });

    h.emitMany("run-chat-send", [
      ["assistant", { text: "partial" }],
      ["lifecycle", { phase: "error", error: "chat.send failed" }],
    ]);

    vi.advanceTimersByTime(100);

    expect(h.chat().map(([, payload]) => payload.state)).not.toContain("error");
    expect(h.clearAgentRunContext).toHaveBeenCalledWith("run-chat-send");
    expect(h.agentRunSeq.has("run-chat-send")).toBe(false);
  });

  it("publishes the selected saved partial with its terminal error and retains the backstop diagnostic", () => {
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-saved-error",
    });
    const runId = "run-saved-error";
    h.register(runId, "session-saved-error", runId);
    registerAgentRunContext(runId, { sessionKey: "session-saved-error" });
    h.emit(runId, "assistant", { itemId: "earlier", text: "Earlier candidate" });
    h.emit(runId, "assistant", { itemId: "later", text: "Saved partial" });
    h.emit(runId, "assistant", {
      text: "Saved partial",
      itemId: "saved-partial",
      replace: true,
      replaceable: true,
    });
    h.emit(runId, "lifecycle", {
      phase: "finishing",
      error: "client closed",
      assistantTranscriptIdempotencyKey: "saved-partial",
    });
    expect(h.chat().filter(([, payload]) => payload.state === "error")).toHaveLength(0);
    h.emit(runId, "lifecycle", {
      phase: "error",
      executionSettled: true,
      error: "client closed",
      assistantTranscriptIdempotencyKey: "saved-partial",
    });
    const errors = h.chat().filter(([, payload]) => payload.state === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toMatchObject({
      errorMessage: "client closed",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Saved partial" }],
        __openclaw: { runId, idempotencyKey: "saved-partial" },
      },
    });
  });

  it("emits lifecycle chat errors for active chat.send runs with a chat run link", () => {
    vi.useFakeTimers();
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-chat-send",
      lifecycleErrorRetryGraceMs: 100,
      isChatSendRunActive: (runId) => runId === "run-chat-send",
    });
    h.register("run-chat-send", "session-chat-send", "run-chat-send");
    registerAgentRunContext("run-chat-send", { sessionKey: "session-chat-send" });

    h.emit("run-chat-send", "lifecycle", {
      phase: "error",
      error: "chat.send failed",
    });

    vi.advanceTimersByTime(100);

    const chatErrors = h
      .chat()
      .filter(([, payload]) => (payload as { state?: string }).state === "error");
    expect(chatErrors).toHaveLength(1);
    const errorPayload = chatErrors[0]?.[1] as Record<string, unknown>;
    expectPayloadFields(errorPayload, {
      runId: "run-chat-send",
      sessionKey: "session-chat-send",
      state: "error",
      errorMessage: "chat.send failed",
    });
    expect(errorPayload).not.toHaveProperty("message");
    expect(h.chatRunState.registry.peek("run-chat-send")).toBeUndefined();
    expect(h.clearAgentRunContext).toHaveBeenCalledWith("run-chat-send");
    expect(h.agentRunSeq.has("run-chat-send")).toBe(false);
  });

  it("drains reply-dispatch text once across global after its source is released", async () => {
    const sessionKey = "global";

    vi.useFakeTimers();
    const runId = "run-reply-dispatch-drain";
    const harness = createHarness({ resolveSessionKeyForRun: () => sessionKey });
    const entered = createDeferred();
    const pairing = createDeferred();
    let delayed = false;
    const runtime = createGatewayNodeSessionRuntime({
      broadcast: vi.fn(),
      resolveCurrentPairingState: async () => {
        if (delayed) {
          entered.resolve();
          await pairing.promise;
        }
        return { identity: "identity-a", generation: "generation-a" };
      },
      isPairingStateCurrent: (_nodeId, expected) => expected.generation === "generation-a",
      sessionEventSubscribers: harness.sessionEventSubscribers,
      sessionMessageSubscribers: harness.sessionMessageSubscribers,
    });
    const frames: string[] = [];
    registerNodeSession(runtime.nodeRegistry, makeClient("conn-node", "node-a", frames), {
      pairingGeneration: "generation-a",
    });
    runtime.nodeSubscribe("node-a", sessionKey, "conn-node");
    runtime.nodeSubscribe("node-a", "agent:main:global", "conn-node");
    const sends: Promise<void>[] = [];
    harness.nodeSendToSession.mockImplementation(
      (key: string, event: string, payload: unknown, opts?: GatewayBroadcastOpts) => {
        sends.push(runtime.nodeSendToSession(key, event, payload, opts));
      },
    );
    const claimId = expectDefined(
      claimAgentRunContext(
        runId,
        { sessionKey, agentId: "main" },
        { exclusive: true, trackOwner: true },
      ),
      "reply-dispatch owner claim",
    );
    const stop = onAgentRuntimeEvent(harness.handler);
    try {
      emitAgentEventForOwner(
        { runId, stream: "assistant", data: { text: "one", delta: "one" } },
        claimId,
      );
      await Promise.all(sends);
      delayed = true;
      emitAgentEventForOwner(
        { runId, stream: "assistant", data: { text: "one two", delta: " two" } },
        claimId,
      );
      emitAgentEventForOwner(
        {
          runId,
          stream: "lifecycle",
          data: { phase: "end", completionSource: "reply-dispatch" },
        },
        claimId,
      );
      await entered.promise;
      releaseAgentRunContext(runId, claimId);
      broadcastChatFinal({
        context: harness,
        runId,
        sessionKey,
        message: { role: "assistant", content: [{ type: "text", text: "one two" }] },
      });
      harness.chatRunState.clearRun(runId);
      pairing.resolve();
      await Promise.all(sends);

      const events = frames.map((frame) => JSON.parse(frame));
      expect(
        events
          .filter((frame) => frame.event === "agent" && frame.payload.stream === "assistant")
          .map((frame) => frame.payload.data),
      ).toEqual([{ text: "one", delta: "one" }, { delta: " two" }]);
      expect(events.at(-1)?.payload).toMatchObject({
        state: "final",
        message: { content: [{ text: "one two" }] },
      });
    } finally {
      stop();
      releaseAgentRunContext(runId, claimId);
      harness.handler.dispose();
    }
  });

  it.each([
    [false, false],
    [true, true],
  ])(
    "preserves reply-dispatch ownership (delivery=%s, execution=%s)",
    async (settled, executionSettled) => {
      vi.useFakeTimers();
      const trackTrackedRunTerminalPersistence = vi.fn();
      const harness = createHarness({
        resolveSessionKeyForRun: () => "session-reply-dispatch",
        trackTrackedRunTerminalPersistence,
      });
      const { broadcast, chatRunState, clearAgentRunContext, agentRunSeq, handler } = harness;
      const runId = "run-reply-dispatch";
      registerChatRun(chatRunState, runId, "session-reply-dispatch", runId);
      registerAgentRunContext(runId, { sessionKey: "session-reply-dispatch" });
      chatRunState.getOrCreate(runId).buffer = "pending delivered reply";

      emitAgentEvent(handler, runId, "lifecycle", {
        phase: "error",
        error: "ACP turn failed",
        completionSource: "reply-dispatch",
        ...(executionSettled ? { executionSettled: true } : {}),
      });
      expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledTimes(
        executionSettled ? 1 : 0,
      );
      expect.soft(chatRunState.runs.get(runId)?.buffer).toBe("pending delivered reply");
      expect(agentRunSeq.get(runId)).toBe(1);
      if (settled) {
        broadcastChatError({
          context: harness,
          runId,
          sessionKey: "session-reply-dispatch",
          errorMessage: "ACP turn failed",
        });
        chatRunState.clearRun(runId);
        chatRunState.registry.remove(runId, runId);
      }

      // Drain pending persistence or legacy grace after the dispatch owner's action.
      await vi.runAllTimersAsync();

      const terminals = chatBroadcastCalls(broadcast);
      expect(terminals).toHaveLength(settled ? 1 : 0);
      if (settled) {
        expectPayloadFields(terminals[0]?.[1], { state: "error", seq: 2 });
        expect(agentRunSeq.has(runId)).toBe(false);
      } else {
        expect(chatRunState.runs.get(runId)?.buffer).toBe("pending delivered reply");
        expect(chatRunState.registry.peek(runId)?.clientRunId).toBe(runId);
        expect(agentRunSeq.get(runId)).toBe(1);
      }
      expect(clearAgentRunContext).not.toHaveBeenCalled();
      expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledOnce();
      expect(trackTrackedRunTerminalPersistence).toHaveBeenCalledWith({
        runId,
        clientRunId: runId,
        sessionKey: "session-reply-dispatch",
        sessionId: undefined,
        persistence: expect.any(Promise),
      });
    },
  );

  it("forwards restart recovery provenance to terminal persistence", () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-recovery",
    });
    registerAgentRunContext("run-recovery", {
      lifecycleGeneration,
      mainSessionRestartRecovery: true,
      sessionKey: "session-recovery",
    });
    const stop = onAgentRuntimeEvent(h.handler);

    emitRuntimeAgentEvent({
      runId: "run-recovery",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    stop();

    const persistParams = requireRecord(
      requireMockArg(persistGatewaySessionLifecycleEventMock, 0, 0, "persist lifecycle params"),
      "persist lifecycle params",
    );
    expect(requireRecord(persistParams.event, "persist lifecycle event")).toMatchObject({
      lifecycleGeneration,
      mainSessionRestartRecovery: true,
      runId: "run-recovery",
    });
  });

  it.each([
    ["assistant", { text: "owned reply", delta: "owned reply", phase: "commentary" }],
    ["lifecycle", { phase: "end" }],
  ] as const)(
    "routes owner-scoped %s events after their run context disappears",
    async (stream, data) => {
      const hidden = stream !== "lifecycle";
      const config = {
        agents: { ownership: "explicit" as const, list: [{ id: "main" }, { id: "work" }] },
      };
      vi.mocked(getRuntimeConfig).mockReturnValue(config);
      const runId = `run-owned-${stream}`;
      const resolveSessionKeyForRun = vi.fn(
        (_runId: string, options?: { agentId?: string }) =>
          `agent:${options?.agentId ?? resolveDefaultAgentId(config)}:shared`,
      );
      const h = createHarness({ resolveSessionKeyForRun });
      h.sessionMessageSubscribers.subscribe("conn-main", "agent:main:shared");
      h.sessionMessageSubscribers.subscribe("conn-work", "agent:work:shared");
      h.sessionEventSubscribers.subscribe("conn-session");

      if (hidden) {
        registerAgentRunContext(runId, {
          agentId: "work",
          sessionKey: "agent:work:shared",
          isControlUiVisible: false,
        });
      }
      let event: Parameters<typeof h.handler>[0] | undefined;
      const unsubscribe = onAgentRuntimeEvent((received) => {
        event = received;
      });
      emitRuntimeAgentEvent({ runId, stream, data, agentId: "work" });
      unsubscribe();
      if (hidden) {
        clearRegisteredAgentRunContext(runId);
      }
      const received = expectDefined(event, "owner-scoped runtime event");
      expect(received.sessionKey).toBeUndefined();

      h.handler(received);

      if (hidden) {
        expect(h.broadcast).not.toHaveBeenCalled();
        expect(h.nodeSendToSession).not.toHaveBeenCalled();
        const delivered = h.broadcastToConnIds.mock.calls.filter(
          ([eventName]) => eventName === "agent" || eventName === "chat",
        );
        expect(delivered.length).toBeGreaterThan(0);
        for (const [, payload, recipients] of delivered) {
          expect(payload).toEqual(
            expect.objectContaining({ agentId: "work", sessionKey: "agent:work:shared" }),
          );
          expect(recipients).toEqual(new Set(["conn-work"]));
        }
        return;
      }

      expect(h.chat()).toEqual([
        [
          "chat",
          expect.objectContaining({
            agentId: "work",
            runId,
            sessionKey: "agent:work:shared",
            state: "final",
          }),
          expect.objectContaining({ sessionKeys: ["agent:work:shared"] }),
        ],
      ]);
      expect(h.nodeSendToSession.mock.calls.map(([sessionKey]) => sessionKey)).toEqual([
        "agent:work:shared",
        "agent:work:shared",
      ]);
      expect(h.clearAgentRunContext).toHaveBeenCalledWith(runId);
      expect(h.agentRunSeq.has(runId)).toBe(false);
      expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledWith({
        agentId: "work",
        event: expect.objectContaining({
          data,
          lifecycleGeneration: received.lifecycleGeneration,
          runId,
        }),
        sessionKey: "agent:work:shared",
      });
      await waitForFast(() => {
        expect(h.broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({
            agentId: "work",
            phase: "end",
            runId,
            sessionKey: "agent:work:shared",
          }),
          new Set(["conn-session"]),
          { dropIfSlow: true },
        );
      });
    },
  );

  it.each([
    { stream: "assistant", controlUiVisible: true },
    { stream: "item", controlUiVisible: false },
  ] as const)(
    "drops queued $stream progress after release without dropping another run's updates (visible: $controlUiVisible)",
    ({ stream, controlUiVisible }) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const h = createHarness();
      const delivery = controlUiVisible ? h.broadcast : h.broadcastToConnIds;
      const claim = (runId: string) =>
        expectDefined(
          claimAgentRunContext(
            runId,
            { sessionKey: `session-${runId}`, isControlUiVisible: controlUiVisible },
            { exclusive: true, trackOwner: true },
          ),
          "preview owner claim",
        );
      const retiredRunId = "run-preview-retired";
      const activeRunId = "run-preview-active";
      const retiredClaim = claim(retiredRunId);
      const activeClaim = claim(activeRunId);
      if (!controlUiVisible) {
        h.sessionMessageSubscribers.subscribe("conn-retired", `session-${retiredRunId}`);
        h.sessionMessageSubscribers.subscribe("conn-active", `session-${activeRunId}`);
      }
      const stop = onAgentRuntimeEvent(h.handler);

      try {
        for (const [runId, claimId] of [
          [retiredRunId, retiredClaim],
          [activeRunId, activeClaim],
        ] as const) {
          for (const [text, delta] of [
            ["First", "First"],
            ["First queued", " queued"],
          ] as const) {
            emitAgentEventForOwner(
              {
                runId,
                stream,
                data: stream === "item" ? answerCandidate("answer-1", text) : { text, delta },
              },
              claimId,
            );
          }
        }
        expect(agentBroadcastCalls(delivery)).toHaveLength(2);
        expect(loadGatewaySessionLifecycleSnapshotMock).toHaveBeenCalledTimes(
          controlUiVisible ? 0 : 2,
        );

        releaseAgentRunContext(retiredRunId, retiredClaim);
        vi.advanceTimersByTime(75);

        const delivered = agentBroadcastCalls(delivery).map(
          ([, payload]) => payload as AgentEventPayload,
        );
        const expected = [
          [retiredRunId, "First"],
          [activeRunId, "First"],
          [activeRunId, "First queued"],
        ];
        expect(
          delivered.map(({ runId, data }) => [
            runId,
            stream === "item" ? data.progressText : data.text,
          ]),
        ).toEqual(expected);
        expect(loadGatewaySessionLifecycleSnapshotMock).toHaveBeenCalledTimes(
          controlUiVisible ? 0 : 3,
        );
        if (controlUiVisible) {
          expect(h.nodeAgent().map((call) => call[2])).toEqual(delivered);
        } else {
          expect(h.nodeSendToSession).not.toHaveBeenCalled();
        }
        if (stream === "assistant") {
          const chat = chatBroadcastCalls(delivery).map(([, payload]) => payload);
          expect(chat.map((payload) => [payload.runId, payload.message.content[0].text])).toEqual(
            expected,
          );
          expect(chat.map((payload) => payload.deltaText)).toEqual(["First", "First", " queued"]);
          if (controlUiVisible) {
            expect(h.nodeChat().map((call) => call[2])).toEqual(chat);
          }
        }
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        stop();
        releaseAgentRunContext(retiredRunId, retiredClaim);
        releaseAgentRunContext(activeRunId, activeClaim);
        h.handler.dispose();
        h.chatRunState.clear();
      }
    },
  );

  it("starts fresh chat text when a new owner reuses a source run id with a queued tail", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const h = createHarness();
    const runId = "run-owner-reuse";
    const claim = () =>
      expectDefined(
        claimAgentRunContext(
          runId,
          { sessionKey: "session-reuse", isControlUiVisible: false },
          { exclusive: true, trackOwner: true },
        ),
        "reused run owner claim",
      );
    const firstClaim = claim();
    let currentClaim = firstClaim;
    h.sessionMessageSubscribers.subscribe("conn-selected", "session-reuse");
    const stop = onAgentRuntimeEvent(h.handler);
    const emitText = (text: string, delta: string) =>
      emitAgentEventForOwner({ runId, stream: "assistant", data: { text, delta } }, currentClaim);

    try {
      emitText("First", "First");
      emitText("First queued", " queued");
      expect(h.targetedDeltas()).toEqual(["First"]);

      releaseAgentRunContext(runId, firstClaim);
      currentClaim = claim();
      emitText("Fresh", "Fresh");
      vi.advanceTimersByTime(75);

      expect(h.targetedChat().map(([, payload]) => payload.message.content[0].text)).toEqual([
        "First",
        "Fresh",
      ]);
      emitAgentEventForOwner({ runId, stream: "lifecycle", data: { phase: "end" } }, currentClaim);
      expect(h.targetedChat().at(-1)?.[1]).toMatchObject({
        runId,
        state: "final",
        message: { content: [{ type: "text", text: "Fresh" }] },
      });
      expect(h.broadcast).not.toHaveBeenCalled();
      expect(h.nodeSendToSession).not.toHaveBeenCalled();
      for (const call of h.broadcastToConnIds.mock.calls) {
        expect(call[2]).toEqual(new Set(["conn-selected"]));
      }
      const completedCalls = h.broadcastToConnIds.mock.calls.length;
      // Terminal plugin hooks clear their safety deadline after their promises settle.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.broadcastToConnIds).toHaveBeenCalledTimes(completedCalls);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stop();
      releaseAgentRunContext(runId, firstClaim);
      releaseAgentRunContext(runId, currentClaim);
      h.handler.dispose();
      h.chatRunState.clear();
    }
  });

  it.each(["session change", "subscriber removal", "subscriber replacement"] as const)(
    "keeps queued hidden previews isolated across %s",
    (change) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const h = createHarness();
      const runId = "run-hidden-audience";
      let label = "Before buffering";
      loadGatewaySessionLifecycleSnapshotMock.mockImplementation((key: string) => ({
        row: { key, kind: "direct", updatedAt: 10_000, label },
      }));
      const claimId = expectDefined(
        claimAgentRunContext(
          runId,
          { sessionKey: "session-A", isControlUiVisible: false },
          { exclusive: true, trackOwner: true },
        ),
        "hidden preview owner claim",
      );
      h.sessionMessageSubscribers.subscribe("conn-A", "session-A");
      h.sessionMessageSubscribers.subscribe("conn-B", "session-B");
      const stop = onAgentRuntimeEvent(h.handler);
      const preview = (text: string) =>
        emitAgentEventForOwner(
          { runId, stream: "item", data: answerCandidate("answer-1", text) },
          claimId,
        );

      try {
        preview("Old visible");
        preview("Old queued");
        expect(h.targetedAgent()).toHaveLength(1);
        expect(loadGatewaySessionLifecycleSnapshotMock).toHaveBeenCalledTimes(1);
        label = "Current metadata";

        if (change === "session change") {
          registerAgentRunContext(runId, { sessionKey: "session-B" }, claimId);
        } else if (change === "subscriber removal") {
          h.sessionMessageSubscribers.unsubscribe("conn-A", "session-A");
          vi.advanceTimersByTime(75);
          expect(h.targetedAgent()).toHaveLength(1);
          expect(loadGatewaySessionLifecycleSnapshotMock).toHaveBeenCalledTimes(1);
          h.sessionMessageSubscribers.subscribe("conn-replacement", "session-A");
        } else {
          h.sessionMessageSubscribers.unsubscribe("conn-A", "session-A");
          h.sessionMessageSubscribers.subscribe("conn-replacement", "session-A");
          vi.advanceTimersByTime(75);
        }
        preview("New visible");
        vi.advanceTimersByTime(75);

        expect(
          h.targetedAgent().map(([, event, recipients]) => {
            const payload = event as AgentEventPayload;
            return [payload.sessionKey, payload.data.progressText, recipients];
          }),
        ).toEqual([
          ["session-A", "Old visible", new Set(["conn-A"])],
          ...(change === "session change"
            ? [
                ["session-A", "Old queued", new Set(["conn-A"])],
                ["session-B", "New visible", new Set(["conn-B"])],
              ]
            : [
                ...(change === "subscriber replacement"
                  ? [["session-A", "Old queued", new Set(["conn-replacement"])]]
                  : []),
                ["session-A", "New visible", new Set(["conn-replacement"])],
              ]),
        ]);
        const delivered = h.targetedAgent();
        expect(loadGatewaySessionLifecycleSnapshotMock).toHaveBeenCalledTimes(delivered.length);
        for (const [index, [, event]] of delivered.entries()) {
          const payload = requireRecord(event, "hidden preview metadata");
          const expectedLabel = index === 0 ? "Before buffering" : "Current metadata";
          expect(payload.label).toBe(expectedLabel);
          expect(payload.session).toMatchObject({ key: payload.sessionKey, label: expectedLabel });
        }
        expect(h.broadcast).not.toHaveBeenCalled();
        expect(h.nodeSendToSession).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        stop();
        releaseAgentRunContext(runId, claimId);
        h.handler.dispose();
        h.chatRunState.clear();
      }
    },
  );

  it("does not project maintenance child events onto its selected parent session", () => {
    const runId = "run-maintenance-child";
    const sessionKey = "session-maintenance-parent";
    const settleTrackedTerminal = vi.fn();
    const h = createHarness({ resolveSessionKeyForRun: () => sessionKey, settleTrackedTerminal });
    h.sessionMessageSubscribers.subscribe("conn-selected", sessionKey);
    registerAgentRunContext(runId, {
      isControlUiVisible: false,
      projectSessionActive: false,
      projectSessionLifecycle: false,
      projectSessionMessages: false,
      sessionId: "session-parent",
      sessionKey,
    });
    const stop = onAgentRuntimeEvent(h.handler);
    for (const [stream, data] of [
      ["lifecycle", { phase: "start", startedAt: 1_000 }],
      ["assistant", { text: "Internal review output", delta: "Internal review output" }],
      ["tool", { phase: "start", name: "skill_workshop", toolCallId: "review-tool" }],
      ["item", { phase: "update", kind: "status", title: "Reviewing" }],
      ["lifecycle", { phase: "end", endedAt: 2_000 }],
    ] as const) {
      emitRuntimeAgentEvent({ runId, stream, data });
    }
    stop();
    expect(h.chat()).toHaveLength(0);
    expect(h.agent()).toHaveLength(0);
    expect(h.broadcastToConnIds).not.toHaveBeenCalled();
    expect(h.nodeSendToSession).not.toHaveBeenCalled();
    expect(persistGatewaySessionLifecycleEventMock).not.toHaveBeenCalled();
    expect(settleTrackedTerminal).toHaveBeenCalledWith({ runId, clientRunId: runId, sessionKey });
  });

  it("sends non-control-UI-visible live chat only to exact session message subscribers", () => {
    vi.useFakeTimers();
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-hidden",
      lifecycleErrorRetryGraceMs: 1,
    });
    h.sessionMessageSubscribers.subscribe("conn-selected", "session-hidden");
    h.sessionMessageSubscribers.subscribe("conn-other", "session-other");
    registerAgentRunContext("run-hidden", {
      sessionKey: "session-hidden",
      isControlUiVisible: false,
      verboseLevel: "off",
    });

    h.emit("run-hidden", "assistant", {
      text: "visible only to the selected session",
    });
    h.end("run-hidden", 2);

    expect(h.chat()).toHaveLength(0);
    expect(h.nodeSendToSession).not.toHaveBeenCalled();
    const chatCalls = h.broadcastToConnIds.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[0]?.[2]).toEqual(new Set(["conn-selected"]));
    expectPayloadFields(chatCalls[0]?.[1], {
      runId: "run-hidden",
      sessionKey: "session-hidden",
      state: "delta",
    });
    expectPayloadFields(chatCalls[1]?.[1], {
      runId: "run-hidden",
      sessionKey: "session-hidden",
      state: "final",
    });
    expect(chatCalls[1]?.[2]).toEqual(new Set(["conn-selected"]));

    const streams = ["tool", "thinking", "approval"] as const;
    const streamCallStart = h.broadcastToConnIds.mock.calls.length;
    for (const [index, stream] of streams.entries()) {
      h.handler({
        runId: "run-hidden",
        seq: index + 3,
        stream,
        ts: Date.now(),
        data: { phase: "start", delta: "Inspecting", name: "read" },
      });
    }
    expect(
      h.broadcastToConnIds.mock.calls
        .slice(streamCallStart)
        .map(([event, payload, recipients]) => [
          event,
          requireRecord(payload, "event").stream,
          recipients,
        ]),
    ).toEqual(streams.map((stream) => ["agent", stream, new Set(["conn-selected"])]));

    h.broadcastToConnIds.mockClear();
    const claimId = claimAgentRunContext(
      "revoked",
      { isControlUiVisible: false, sessionKey: "session-hidden" },
      { exclusive: true, trackOwner: true },
    )!;
    const stop = onAgentRuntimeEvent(h.handler);
    emitAgentEventForOwner(
      { runId: "revoked", stream: "lifecycle", data: { phase: "error", error: "retry" } },
      claimId,
    );
    stop();
    expect(h.broadcastToConnIds).toHaveBeenCalledTimes(1);
    const persisted = persistGatewaySessionLifecycleEventMock.mock.calls.length;
    releaseAgentRunContext("revoked", claimId);
    vi.advanceTimersByTime(1);
    expect(h.broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledTimes(persisted);
  });

  it("preserves an owner claim in the terminal persistence handoff", () => {
    const runId = "claimed-terminal-handoff";
    const claimId = claimAgentRunContext(
      runId,
      { sessionKey: "session-claimed-terminal" },
      { exclusive: true, trackOwner: true },
    )!;
    const h = createHarness({
      resolveSessionKeyForRun: () => "session-claimed-terminal",
    });
    let event: Parameters<typeof h.handler>[0] | undefined;
    const stop = onAgentRuntimeEvent((received) => {
      event = received;
    });
    emitAgentEventForOwner({ runId, stream: "lifecycle", data: { phase: "end" } }, claimId);
    stop();

    h.handler(expectDefined(event, "claimed terminal event"));

    expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ contextClaimId: claimId }),
      }),
    );
    releaseAgentRunContext(runId, claimId);
  });

  it("mirrors commentary-phase assistant events only to exact session message subscribers", () => {
    const h = createHarness({ now: 1_000, resolveSessionKeyForRun: () => "session-hidden" });
    const runId = "run-hidden-commentary";
    const commentary = "I will inspect the files first.";
    const untagged = "Untagged text frame must not mirror.";
    h.sessionMessageSubscribers.subscribe("conn-selected", "session-hidden");
    h.sessionMessageSubscribers.subscribe("conn-other", "session-other");
    registerAgentRunContext(runId, {
      sessionKey: "session-hidden",
      isControlUiVisible: false,
      verboseLevel: "off",
    });
    h.emitMany(runId, [
      ["assistant", { text: commentary, delta: commentary, phase: "commentary" }],
      ["assistant", { text: untagged, delta: untagged }],
      ["assistant", { delta: "Untagged delta-only stream must not mirror." }],
      ["assistant", { text: "Terminal echo without delta" }],
      ["assistant", { text: "Final answer", delta: "Final answer", phase: "final_answer" }],
      ["assistant", { delta: "Streaming commentary delta.", phase: "commentary" }],
    ]);
    expect(h.chat()).toHaveLength(0);
    expect(h.agent()).toHaveLength(0);
    expect(h.nodeSendToSession).not.toHaveBeenCalled();
    const agentCalls = h.targetedAgent();
    expect(agentCalls).toHaveLength(2);
    for (const [, payload, recipients] of agentCalls) {
      expect(recipients).toEqual(new Set(["conn-selected"]));
      expectPayloadFields(payload, { runId, sessionKey: "session-hidden", stream: "assistant" });
    }
    expectPayloadDataFields(agentCalls[0]?.[1], {
      text: commentary,
      delta: commentary,
      phase: "commentary",
    });
    expectPayloadDataFields(agentCalls[1]?.[1], {
      delta: "Streaming commentary delta.",
      phase: "commentary",
    });
    const chatCalls = h.targetedChat();
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]?.[2]).toEqual(new Set(["conn-selected"]));
    expectPayloadFields(chatCalls[0]?.[1], { runId, sessionKey: "session-hidden", state: "delta" });
    h.nowSpy?.mockRestore();
  });

  it("does not mirror aborted non-control-UI-visible assistant commentary", () => {
    const h = createHarness({
      now: 1_000,
      resolveSessionKeyForRun: () => "session-hidden-aborted",
    });
    h.sessionMessageSubscribers.subscribe("conn-selected", "session-hidden-aborted");
    registerAgentRunContext("run-hidden-commentary-aborted", {
      sessionKey: "session-hidden-aborted",
      isControlUiVisible: false,
      verboseLevel: "off",
    });
    h.chatRunState.getOrCreate("run-hidden-commentary-aborted").abortMarker =
      createChatAbortMarker(1_000);

    h.emit("run-hidden-commentary-aborted", "assistant", {
      text: "This aborted commentary must not be mirrored.",
      delta: "This aborted commentary must not be mirrored.",
      phase: "commentary",
    });

    expect(h.chat()).toHaveLength(0);
    expect(h.agent()).toHaveLength(0);
    expect(h.broadcastToConnIds).not.toHaveBeenCalled();
    expect(h.nodeSendToSession).not.toHaveBeenCalled();
    h.nowSpy?.mockRestore();
  });

  describe("spawnedBy enrichment in chat and agent broadcasts", () => {
    function mockSessionLineage(key: string, spawnedBy?: string) {
      lineageProjection = createSessionRowProjectionFixture({
        cfg: {},
        store: {
          [key]: { sessionId: "lineage", updatedAt: 1, ...(spawnedBy ? { spawnedBy } : {}) },
        },
      });
      mockSessionEntry(
        { sessionId: "lineage", updatedAt: 1, ...(spawnedBy ? { spawnedBy } : {}) },
        key,
      );
      vi.mocked(loadGatewaySessionRow).mockReturnValue({
        key,
        kind: "direct",
        updatedAt: null,
        ...(spawnedBy ? { spawnedBy } : {}),
      });
    }

    it("marks a yielded final as waiting instead of parent-task completion", () => {
      const h = createHarness({
        resolveSessionKeyForRun: () => "agent:main:main",
      });

      h.register("run-yielded", "agent:main:main", "client-yielded");
      h.emit("run-yielded", "assistant", {
        text: "Waiting for registered continuation work.",
      });
      h.emit(
        "run-yielded",
        "lifecycle",
        {
          phase: "end",
          yielded: true,
          livenessState: "paused",
          stopReason: "end_turn",
        },
        { seq: 2 },
      );

      const finalCall = expectDefined(
        h.chat().find(([, payload]) => payload.state === "final"),
        "yielded final chat call",
      );
      expectPayloadFields(finalCall[1], {
        runId: "client-yielded",
        sessionKey: "agent:main:main",
        state: "final",
        stopReason: "end_turn",
        yielded: true,
      });
    });

    it("does not let stale yield metadata override an aborted lifecycle", () => {
      const h = createHarness({
        resolveSessionKeyForRun: () => "agent:main:main",
      });

      h.register("run-aborted", "agent:main:main", "client-aborted");
      h.emit("run-aborted", "lifecycle", {
        phase: "end",
        aborted: true,
        yielded: true,
        livenessState: "paused",
        stopReason: "end_turn",
      });

      const finalCall = expectDefined(
        h.chat().find(([, payload]) => payload.state === "error"),
        "aborted final chat call",
      );
      expectPayloadFields(finalCall[1], {
        runId: "client-aborted",
        sessionKey: "agent:main:main",
        state: "error",
        stopReason: "end_turn",
      });
      expect(finalCall[1]).not.toHaveProperty("yielded");
    });

    it("includes spawnedBy in chat broadcasts for spawn-owned dashboard sessions", () => {
      mockSessionLineage("agent:main:dashboard:visible-child", "agent:main:discord:direct:alice");
      const h = createHarness({
        resolveSessionKeyForRun: () => "agent:main:dashboard:visible-child",
      });
      h.register(
        "run-dashboard-child",
        "agent:main:dashboard:visible-child",
        "client-dashboard-child",
      );

      h.emit("run-dashboard-child", "assistant", { text: "visible child" });

      expectPayloadFields(h.chat()[0]?.[1], {
        sessionKey: "agent:main:dashboard:visible-child",
        spawnedBy: "agent:main:discord:direct:alice",
      });
    });

    it("includes spawnedBy in chat error final broadcasts for subagent sessions", () => {
      mockSessionLineage("agent:coder:subagent:err", "agent:conductor:task:parent-err");

      const h = createHarness({
        resolveSessionKeyForRun: () => "agent:coder:subagent:err",
        lifecycleErrorRetryGraceMs: 0,
      });

      h.register("run-sub-err", "agent:coder:subagent:err", "client-sub-err");

      h.emitMany("run-sub-err", [
        ["assistant", { text: "partial" }],
        ["lifecycle", { phase: "error", error: "provider failed" }],
      ]);

      const chatCalls = h.chat();
      const errorCall = expectDefined(
        chatCalls.find(([, p]) => p.state === "error"),
        "error chat call",
      );
      expectPayloadFields(errorCall[1], {
        sessionKey: "agent:coder:subagent:err",
        spawnedBy: "agent:conductor:task:parent-err",
        state: "error",
      });
    });

    it("includes spawnedBy in seq gap error broadcasts for subagent sessions", () => {
      mockSessionLineage("agent:coder:subagent:gap", "agent:conductor:task:parent-gap");

      const h = createHarness({
        resolveSessionKeyForRun: () => "agent:coder:subagent:gap",
      });

      registerAgentRunContext("run-sub-gap", { sessionKey: "agent:coder:subagent:gap" });

      h.emitMany("run-sub-gap", [
        ["lifecycle", { phase: "start" }],
        ["assistant", { text: "skipped seq" }, { seq: 5 }],
      ]);

      const agentCalls = h.broadcast.mock.calls.filter(([event]) => event === "agent");
      const gapError = expectDefined(
        agentCalls.find(([, p]) => p.stream === "error" && p.data?.reason === "seq gap"),
        "seq gap error agent call",
      );
      expectPayloadFields(gapError[1], {
        sessionKey: "agent:coder:subagent:gap",
        spawnedBy: "agent:conductor:task:parent-gap",
      });
      expectPayloadDataFields(gapError[1], { reason: "seq gap", expected: 2, received: 5 });
    });
  });
  describe("agent model roster publications", () => {
    type ModelObservation = { provider: string | null; model: string | null };
    const PRIMARY_MODEL: ModelObservation = { provider: "provider", model: "primary" };
    function createModelHarness() {
      const runId = "run-model";
      registerAgentRunContext(runId, {
        agentId: "main",
        sessionKey: "session-1",
        sessionId: "original",
        projectSessionActive: true,
      });
      const owner = getAgentRunContext(runId)!;
      const h = createHarness({
        resolveSessionKeyForRun: () => owner.sessionKey,
        resolveSessionActiveRunState: () => ({ active: true, runIds: [runId] }),
      });
      const broadcast = vi.fn<AgentEventHandlerOptions["broadcast"]>();
      const broadcastToConnIds = vi.fn<AgentEventHandlerOptions["broadcastToConnIds"]>();
      const persist = vi
        .fn<NonNullable<AgentEventHandlerOptions["persistGatewaySessionLifecycleEventForEvent"]>>()
        .mockResolvedValue(undefined);
      h.broadcast.mockImplementation(broadcast);
      h.broadcastToConnIds.mockImplementation(broadcastToConnIds);
      h.nodeHasSessionSubscribers.mockReturnValue(false);
      persistGatewaySessionLifecycleEventMock.mockImplementation(persist);
      loadGatewaySessionLifecycleSnapshotMock.mockImplementation((key) => ({
        row: {
          key,
          sessionId: owner.sessionId,
          kind: "direct",
          updatedAt: 1,
          status: "running",
          modelProvider: "selected",
          model: "configured",
          activeModelProvider: owner.activeModel?.provider,
          activeModel: owner.activeModel?.model,
        },
      }));
      onTestFinished(onAgentRuntimeEvent(h.handler));
      return {
        runId,
        broadcast,
        broadcastToConnIds,
        persist,
        sessionEventSubscribers: h.sessionEventSubscribers,
        changes: () =>
          broadcastToConnIds.mock.calls
            .filter(([event]) => event === "sessions.changed")
            .map(([, payload]) => payload),
        observe: (candidate: ModelObservation = PRIMARY_MODEL, sessionKey?: string) =>
          emitAgentEventForRunContext(
            { runId, sessionKey, stream: "lifecycle", data: { phase: "model", ...candidate } },
            owner,
          ),
      };
    }

    beforeEach(() => {
      resetAgentEventsForTest();
      logErrorMock.mockReset();
    });
    afterEach(() => resetAgentEventsForTest());

    it("publishes candidate changes and clearing without persisting session selection", () => {
      const { runId, broadcast, changes, observe, persist, sessionEventSubscribers } =
        createModelHarness();
      sessionEventSubscribers.subscribe("conn-model");
      const candidates: ModelObservation[] = [
        PRIMARY_MODEL,
        { provider: "other-provider", model: "primary" },
        { provider: "other-provider", model: "fallback" },
        { provider: null, model: null },
      ];
      for (const candidate of candidates) {
        observe(candidate);
        observe(candidate);
      }
      expect(broadcast.mock.calls.filter(([event]) => event === "agent")).toHaveLength(8);
      expect(changes()).toHaveLength(4);
      for (const [index, { provider, model }] of candidates.entries()) {
        expect(changes()[index]).toMatchObject({
          phase: "model",
          modelProvider: "selected",
          model: "configured",
          activeModelProvider: provider,
          activeModel: model,
          hasActiveRun: true,
          activeRunIds: [runId],
          session: { activeModelProvider: provider, activeModel: model },
        });
        expect(changes()[index]).not.toHaveProperty("catalogChanged");
      }
      expect(persist).not.toHaveBeenCalled();
    });

    it("publishes unchanged candidates after visibility, receiver, or target changes", () => {
      const sessionKey = "session-2";

      const { runId, changes, observe, sessionEventSubscribers } = createModelHarness();
      observe();
      registerAgentRunContext(runId, { isControlUiVisible: false });
      sessionEventSubscribers.subscribe("conn-model");
      observe();
      expect(changes()).toHaveLength(0);
      registerAgentRunContext(runId, { isControlUiVisible: true });
      observe();
      observe();
      expect(changes()).toHaveLength(1);
      registerAgentRunContext(runId, { sessionId: "replacement" });
      observe();
      observe();
      expect(changes()).toHaveLength(2);
      expect(changes()[1]).toMatchObject({ session: { sessionId: "replacement" } });
      observe(PRIMARY_MODEL, sessionKey);
      observe(PRIMARY_MODEL, sessionKey);
      expect(changes()).toHaveLength(3);
      expect(changes()[2]).toMatchObject({
        sessionKey,
        session: { key: sessionKey, activeModel: "primary" },
      });
    });

    it("remembers the committed model after deferred row preparation", async () => {
      const { changes, observe, sessionEventSubscribers } = createModelHarness();
      sessionEventSubscribers.subscribe("conn-model");
      observe();
      const ready = createDeferred();
      const preparation = vi
        .spyOn(sessionEventRows, "withPreparedSessionEventRow")
        .mockImplementationOnce(async (_projection, _key, _agentId, publish) => {
          await ready.promise;
          publish();
        });
      onTestFinished(() => preparation.mockRestore());
      const fallback = { provider: "provider", model: "fallback" };
      observe(fallback);
      const pending = preparation.mock.results[0]?.value;
      observe();
      ready.resolve();
      await pending;
      expect(changes()).toHaveLength(1);
      expect(changes()[0]).toMatchObject({ session: { activeModel: "primary" } });
      observe(fallback);
      observe(fallback);
      expect(changes()).toHaveLength(2);
      expect(changes()[1]).toMatchObject({ session: { activeModel: "fallback" } });
    });

    it("retries an unchanged model snapshot after publication fails", async () => {
      const { broadcastToConnIds, changes, observe, sessionEventSubscribers } =
        createModelHarness();
      sessionEventSubscribers.subscribe("conn-model");
      broadcastToConnIds.mockImplementationOnce(() => {
        throw new Error("publication failed");
      });
      observe();
      await Promise.resolve();
      expect(logErrorMock).toHaveBeenCalledWith(
        expect.stringContaining("session snapshot publication failed"),
      );
      observe();
      observe();
      expect(changes()).toHaveLength(2);
      expect(changes()[1]).toMatchObject({ session: { activeModel: "primary" } });
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
