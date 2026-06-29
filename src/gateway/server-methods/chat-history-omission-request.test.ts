// Real-behavior proof that a full `chat.history` Gateway request — issued over a
// real WebSocket to a real booted Gateway server, reading a real on-disk
// transcript — emits the `payload.large` / `truncated` diagnostic when older
// history is omitted by the byte budget. This drives the actual server method
// (`handleChatHistoryRequest`), not the budget helpers in isolation, so it
// covers the caller gate that previously swallowed front-cap and drop-to-last
// omissions. It imports only the WebSocket harness and the diagnostic bus (no
// changed symbols), so the same test reproduces the missing diagnostic on
// pre-fix `main`.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import {
  onDiagnosticEvent,
  type DiagnosticPayloadLargeEvent,
} from "../../infra/diagnostic-events.js";
import { setMaxChatHistoryMessagesBytesForTest } from "../server-constants.js";
import { installGatewayTestHooks, rpcReq, testState, writeSessionStore } from "../test-helpers.js";
import { installConnectedControlUiServerSuite } from "../test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

describe("chat.history request emits truncation diagnostic (real WS gateway)", () => {
  test("a real chat.history request logs payload.large when older history is omitted", async () => {
    const SESSION_ID = "sess-omission-proof";
    const MESSAGE_COUNT = 12;
    const TEXT_BYTES = 2_000;
    // Budget far below the seeded transcript but well above one message, so the
    // front byte cap drops older messages without per-message placeholdering.
    const BUDGET_BYTES = 8_000;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-history-omit-"));
    const captured: DiagnosticPayloadLargeEvent[] = [];
    const unsubscribe = onDiagnosticEvent((evt) => {
      if (evt.type === "payload.large" && evt.surface === "gateway.chat.history") {
        captured.push(evt);
      }
    });
    setMaxChatHistoryMessagesBytesForTest(BUDGET_BYTES);
    testState.sessionStorePath = path.join(dir, "sessions.json");
    try {
      await writeSessionStore({
        entries: {
          main: {
            sessionId: SESSION_ID,
            sessionFile: path.join(dir, `${SESSION_ID}.jsonl`),
            updatedAt: Date.now(),
          },
        },
      });
      const messages = Array.from({ length: MESSAGE_COUNT }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `m${i} ${"x".repeat(TEXT_BYTES)}` }],
        timestamp: i + 1,
      }));
      const lines = messages.map((message) => JSON.stringify({ message }));
      await fs.writeFile(path.join(dir, `${SESSION_ID}.jsonl`), lines.join("\n"), "utf-8");

      const res = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 1000,
      });

      expect(res.ok).toBe(true);
      const returned = res.payload?.messages ?? [];
      // The response keeps only the survivors under budget (never empty), so the
      // request genuinely omitted older history.
      expect(returned.length).toBeGreaterThan(0);
      expect(returned.length).toBeLessThan(MESSAGE_COUNT);

      expect(captured).toHaveLength(1);
      const event = captured[0];
      expect(event.action).toBe("truncated");
      expect(event.reason).toBe("chat_history_budget");
      expect(event.count).toBeGreaterThan(0);
      expect(event.count).toBe(MESSAGE_COUNT - returned.length);

      // Print the real runtime diagnostic so a `run-vitest` run shows the
      // captured Gateway event (used as the PR real-behavior proof).
      console.log(
        `chat.history real-request diagnostic: returned=${returned.length} ` +
          `event=${JSON.stringify(event)}`,
      );
    } finally {
      unsubscribe();
      setMaxChatHistoryMessagesBytesForTest(undefined);
      testState.sessionStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
