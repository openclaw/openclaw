import { afterEach, expect, it } from "vitest";
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
} from "./diagnostic-stability.js";

afterEach(() => {
  // Reset owns recorder unsubscription as well as clearing its records.
  resetDiagnosticStabilityRecorderForTest();
  resetDiagnosticEventsForTest();
});

it("records a bounded payload-free projection of diagnostic events", async () => {
  resetDiagnosticStabilityRecorderForTest();
  resetDiagnosticEventsForTest();
  startDiagnosticStabilityRecorder();
  const tool = {
    type: "tool.loop",
    toolName: "poll",
    level: "warning",
    action: "warn",
    detector: "known_poll_no_progress",
    count: 3,
  } as const;
  const talk = {
    type: "talk.event",
    talkEventType: "latency.metrics",
    mode: "realtime",
    transport: "gateway-relay",
    brain: "agent-consult",
    provider: "openai",
    final: true,
    durationMs: 12,
  } as const;
  emitDiagnosticEvent({
    type: "webhook.error",
    channel: "telegram",
    chatId: "chat-secret",
    error: "raw upstream error with content",
  });
  emitDiagnosticEvent({
    ...tool,
    sessionId: "session-1",
    message: "message that should not be stored",
  });
  emitDiagnosticEvent({
    ...talk,
    sessionId: "talk-session-secret",
    turnId: "talk-turn-secret",
    captureId: "talk-capture-secret",
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

  expect(snapshot).toMatchObject({
    count: 3,
    summary: {
      byType: {
        "webhook.error": 1,
        "tool.loop": 1,
        "talk.event": 1,
      },
    },
    events: [{ type: "webhook.error", channel: "telegram" }, tool, { ...talk, bytes: 345 }],
  });
  for (const [index, keys] of [
    ["error", "chatId"],
    ["message", "sessionId", "sessionKey"],
    ["sessionId", "turnId", "captureId"],
  ].entries()) {
    for (const key of keys) {
      expect(snapshot.events[index]).not.toHaveProperty(key);
    }
  }
});
