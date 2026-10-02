import { expect, test, vi } from "vitest";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import * as historyWorker from "../config/sessions/session-history-worker-runtime.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { waitForSessionEvent } from "./session-message-event.test-support.js";
import { rpcReq, writeSessionStore } from "./test-helpers.server.js";
import { setupGatewaySessionsTestHarness } from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

test.each(["by-id", "count"] as const)(
  "delivers selected-session %s updates after worker overload",
  async (read) => {
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
    expect(persisted.messages.filter((m) => m.appended)).toHaveLength(1);

    const { ws } = await openClient({ scopes: ["operator.read"] });
    await using cleanup = { [Symbol.asyncDispose]: () => closeGatewayTestWebSocket(ws) };
    void cleanup;
    const subscribeRes = await rpcReq(ws, "sessions.messages.subscribe", { key: "main" });
    expect(subscribeRes).toMatchObject({ ok: true, payload: { key: target.sessionKey } });
    const waitForEvent = (event: string) =>
      waitForSessionEvent(ws, event, { sessionKey: target.sessionKey });
    const update = {
      target,
      message: {
        ...transcriptMessage,
        ...(read === "by-id" ? { content: [{ type: "text", text: "stale queued prompt" }] } : {}),
      },
      ...(read === "by-id" ? { messageId: "msg-selected" } : {}),
    };
    {
      using _ = vi
        .spyOn(historyWorker, "readSessionHistoryPageInWorker")
        .mockRejectedValueOnce(new WorkerTaskError("worker task capacity reached", "overloaded"));
      const changed = waitForEvent("sessions.changed");
      emitSessionTranscriptUpdate(update);
      const invalidation = await changed;
      expect(invalidation.payload).toMatchObject({
        sessionKey: target.sessionKey,
        phase: "message",
      });
      expect(invalidation.payload).not.toHaveProperty("message");
      expect(invalidation.payload).not.toHaveProperty("messageSeq");
    }

    const nextMessage = waitForEvent("session.message");
    emitSessionTranscriptUpdate(update);
    const messageEvent = await nextMessage;
    expect(messageEvent.payload).toMatchObject({
      sessionKey: target.sessionKey,
      messageSeq: 1,
      message: transcriptMessage,
    });
    if (read === "by-id") {
      expect(messageEvent.payload).toMatchObject({
        messageId: "msg-selected",
        message: {
          __openclaw: {
            id: "msg-selected",
            seq: 1,
            transcriptPosition: { source: expect.any(String), rawSeq: expect.any(Number) },
          },
        },
      });
    }
  },
);
