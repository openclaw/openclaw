import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { appendTranscriptMessageSync } from "../../config/sessions/session-accessor.js";
import { onDiagnosticEvent, type DiagnosticEventPayload } from "../../infra/diagnostic-events.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
import { installGatewayTestHooks, rpcReq, testState, writeSessionStore } from "../test-helpers.js";
import { installConnectedControlUiServerSuite } from "../test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

describe("chat.history request truncation diagnostic", () => {
  const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-chat-history-omit-");
  test("a real request reports older history omitted by the production budget", async () => {
    const sessionId = "sess-omission-proof";
    const sessionKey = "agent:main:main";
    // Count actual budget omissions within one source window, not unread older history.
    const messageCount = 10;
    const textBytes = 100_000;
    const budgetBytes = getMaxChatHistoryMessagesBytes();
    const dir = tempDirs.make();
    const captured: Extract<DiagnosticEventPayload, { type: "payload.large" }>[] = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      if (event.type === "payload.large" && event.surface === "gateway.chat.history") {
        captured.push(event);
      }
    });
    testState.sessionStorePath = path.join(dir, "sessions.json");

    try {
      await writeSessionStore({
        entries: {
          [sessionKey]: { sessionId, updatedAt: Date.now() },
        },
      });
      for (let index = 0; index < messageCount; index += 1) {
        appendTranscriptMessageSync(
          {
            agentId: "main",
            sessionId,
            sessionKey,
            storePath: testState.sessionStorePath,
          },
          {
            message: {
              role: index % 2 === 0 ? "user" : "assistant",
              content: [{ type: "text", text: `m${index} ${"x".repeat(textBytes)}` }],
              timestamp: index + 1,
            },
            now: index + 1,
          },
        );
      }

      const response = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey,
        limit: 1000,
        maxChars: 100_000,
      });
      expect(response.ok).toBe(true);
      const returned = response.payload?.messages ?? [];
      expect(returned.length).toBeGreaterThan(0);
      expect(returned.length).toBeLessThan(messageCount);
      expect(Buffer.byteLength(JSON.stringify(returned), "utf8")).toBeLessThanOrEqual(budgetBytes);

      expect(captured).toHaveLength(1);
      const event = expectDefined(captured[0], "captured[0] test invariant");
      expect(event).toMatchObject({
        action: "truncated",
        reason: "chat_history_budget",
        count: messageCount - returned.length,
      });
    } finally {
      unsubscribe();
      testState.sessionStorePath = undefined;
    }
  });
});
