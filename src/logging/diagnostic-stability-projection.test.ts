import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emitDiagnosticEvent,
  emitInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticStabilitySnapshot,
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "./diagnostic-stability.js";

describe("diagnostic stability projection", () => {
  beforeEach(() => {
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
  });

  it("records a bounded payload-free projection of diagnostic events", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "webhook.error",
      channel: "telegram",
      chatId: "chat-secret",
      error: "raw upstream error with content",
    });
    emitDiagnosticEvent({
      type: "tool.loop",
      sessionId: "session-1",
      toolName: "poll",
      level: "warning",
      action: "warn",
      detector: "known_poll_no_progress",
      count: 3,
      message: "message that should not be stored",
    });
    emitDiagnosticEvent({
      type: "talk.event",
      sessionId: "talk-session-secret",
      turnId: "talk-turn-secret",
      captureId: "talk-capture-secret",
      talkEventType: "latency.metrics",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
      final: true,
      durationMs: 12,
      byteLength: 345,
    });
    emitInternalDiagnosticEvent({
      type: "diagnostic.child_process.spawn",
      family: "node",
      count: 2,
      intervalMs: 60_000,
    });
    emitInternalDiagnosticEvent({ type: "gateway.http.cancelled", source: "client" });
    emitDiagnosticEvent({
      type: "worker.request",
      kind: "sessionTranscript",
      requestClass: "task",
      phase: "queued",
      queueDepth: 1,
    });
    emitDiagnosticEvent({ type: "secret.egress", outcome: "forwarded", substituted: false });
    emitDiagnosticEvent({
      type: "tool.catalog",
      source: "builtin",
      mode: "code-mode",
      toolCount: 12,
    });
    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expect(snapshot.count).toBe(3);
    expect(snapshot.summary.byType).toMatchObject({
      "webhook.error": 1,
      "tool.loop": 1,
      "talk.event": 1,
    });
    expect(snapshot.events[0]).toMatchObject({
      type: "webhook.error",
      channel: "telegram",
    });
    expect(snapshot.events[0]).not.toHaveProperty("error");
    expect(snapshot.events[0]).not.toHaveProperty("chatId");
    expect(snapshot.events[1]).toMatchObject({
      type: "tool.loop",
      toolName: "poll",
      level: "warning",
      action: "warn",
      detector: "known_poll_no_progress",
      count: 3,
    });
    expect(snapshot.events[1]).not.toHaveProperty("message");
    expect(snapshot.events[1]).not.toHaveProperty("sessionId");
    expect(snapshot.events[1]).not.toHaveProperty("sessionKey");
    expect(snapshot.events[2]).toMatchObject({
      type: "talk.event",
      talkEventType: "latency.metrics",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
      final: true,
      durationMs: 12,
      bytes: 345,
    });
    expect(snapshot.events[2]).not.toHaveProperty("sessionId");
    expect(snapshot.events[2]).not.toHaveProperty("turnId");
    expect(snapshot.events[2]).not.toHaveProperty("captureId");
  });
});
