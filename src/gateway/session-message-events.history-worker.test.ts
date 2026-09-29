import { expect, test, vi } from "vitest";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import * as historyWorker from "../config/sessions/session-history-worker-runtime.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { onceMessage, rpcReq, writeSessionStore } from "./test-helpers.server.js";
import { setupGatewaySessionsTestHarness } from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

test.each([
  { read: "by-id", overloaded: false },
  { read: "count", overloaded: false },
  { read: "by-id", overloaded: true },
  { read: "count", overloaded: true },
] as const)(
  "delivers selected-session $read updates with overloaded=$overloaded",
  async ({ read, overloaded }) => {
    const { storePath } = await createSessionStoreDir();
    const target = {
      agentId: "main",
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      storePath,
    };
    await writeSessionStore({
      entries: { main: { sessionId: target.sessionId, updatedAt: Date.now() } },
      storePath,
    });
    const transcriptMessage = {
      role: "user",
      content: [{ type: "text", text: "early selected prompt" }],
      timestamp: Date.now(),
    };
    const persisted = await persistSessionTranscriptTurn(target, {
      messages: [{ eventId: "msg-selected", message: transcriptMessage }],
      updateMode: "none",
    });
    expect(persisted.appendedCount).toBe(1);

    const { ws } = await openClient({ scopes: ["operator.read"] });
    try {
      const subscribeRes = await rpcReq(ws, "sessions.messages.subscribe", { key: "main" });
      expect(subscribeRes.ok).toBe(true);
      expect(subscribeRes.payload?.key).toBe(target.sessionKey);
      const waitForEvent = (event: string) =>
        onceMessage(
          ws,
          (message) =>
            message.type === "event" &&
            message.event === event &&
            (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
              target.sessionKey,
        );
      const update = {
        target,
        message: {
          ...transcriptMessage,
          ...(read === "by-id" ? { content: [{ type: "text", text: "stale queued prompt" }] } : {}),
        },
        ...(read === "by-id" ? { messageId: "msg-selected" } : {}),
      };
      if (overloaded) {
        const readFailure = vi
          .spyOn(historyWorker, "readSessionHistoryPageInWorker")
          .mockRejectedValueOnce(new WorkerTaskError("worker task capacity reached", "overloaded"));
        try {
          const changed = waitForEvent("sessions.changed");
          emitSessionTranscriptUpdate(update);
          const invalidation = await changed;
          expect(invalidation.payload).toMatchObject({
            sessionKey: target.sessionKey,
            phase: "message",
          });
          expect(invalidation.payload).not.toHaveProperty("message");
          expect(invalidation.payload).not.toHaveProperty("messageSeq");
        } finally {
          readFailure.mockRestore();
        }
      }

      const nextMessage = waitForEvent("session.message");
      emitSessionTranscriptUpdate(update);
      const messageEvent = await nextMessage;
      expect(messageEvent.payload).toMatchObject({
        sessionKey: target.sessionKey,
        ...(read === "by-id" ? { messageId: "msg-selected" } : {}),
        messageSeq: 1,
        message: {
          ...transcriptMessage,
          ...(read === "by-id"
            ? {
                __openclaw: {
                  id: "msg-selected",
                  seq: 1,
                  transcriptPosition: { source: expect.any(String), rawSeq: expect.any(Number) },
                },
              }
            : {}),
        },
      });
    } finally {
      await closeGatewayTestWebSocket(ws);
    }
  },
);
