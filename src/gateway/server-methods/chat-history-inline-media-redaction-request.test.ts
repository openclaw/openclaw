// Real-behavior proof that full `chat.history` and `chat.message.get` Gateway
// requests — issued over a real WebSocket to a booted Gateway server, reading a
// real on-disk transcript — redact inline `data:` media on Responses blocks.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { installGatewayTestHooks, rpcReq, testState, writeSessionStore } from "../test-helpers.js";
import { installConnectedControlUiServerSuite } from "../test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

const INLINE_PAYLOAD = "cG5n";
const DATA_URL = `data:image/png;base64,${INLINE_PAYLOAD}`;

type SeededInlineMediaTranscript = {
  messageId: string;
};

async function seedInlineMediaTranscript(dir: string): Promise<SeededInlineMediaTranscript> {
  testState.sessionStorePath = path.join(dir, "sessions.json");
  const session = SessionManager.create(dir, dir);
  const sessionId = session.getSessionId();
  const transcriptPath = session.getSessionFile();
  if (!sessionId || !transcriptPath) {
    throw new Error("expected SessionManager to expose session id and transcript path");
  }

  session.appendMessage({
    role: "user",
    content: "inline media redaction proof",
    timestamp: Date.now(),
  });
  const messageId = session.appendMessage({
    role: "assistant",
    content: [{ type: "input_image", image_url: DATA_URL }],
    timestamp: Date.now(),
    api: "responses",
    provider: "openai",
    model: "gpt-test",
  } as unknown as AssistantMessage);

  await writeSessionStore({
    entries: {
      main: {
        sessionId,
        sessionFile: transcriptPath,
        updatedAt: Date.now(),
      },
    },
  });

  return { messageId };
}

function expectRedactedInlineMediaBlock(content: unknown) {
  expect(content).toEqual([
    {
      type: "input_image",
      omitted: true,
      bytes: Buffer.byteLength(DATA_URL, "utf8"),
    },
  ]);
}

describe("chat history inline media redaction (real WS gateway)", () => {
  test("chat.history redacts input_image data URLs from a real transcript read", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-history-redact-"));
    try {
      await seedInlineMediaTranscript(dir);

      const res = await rpcReq<{ messages?: Array<Record<string, unknown>> }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 10,
      });

      expect(res.ok).toBe(true);
      const messages = res.payload?.messages ?? [];
      const assistantMessage = messages.find((message) => message.role === "assistant");
      expect(assistantMessage).toBeDefined();
      expectRedactedInlineMediaBlock(assistantMessage?.content);
      expect(JSON.stringify(messages)).not.toContain(DATA_URL);
      expect(JSON.stringify(messages)).not.toContain(INLINE_PAYLOAD);

      console.log(
        `chat.history real-request redaction: ${JSON.stringify(assistantMessage?.content ?? null)}`,
      );
    } finally {
      testState.sessionStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("chat.message.get redacts input_image data URLs from a real transcript read", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-message-get-redact-"));
    try {
      const { messageId } = await seedInlineMediaTranscript(dir);

      const res = await rpcReq<{ ok?: boolean; message?: Record<string, unknown> }>(
        ws,
        "chat.message.get",
        {
          sessionKey: "main",
          messageId,
        },
      );

      expect(res.ok).toBe(true);
      expect(res.payload?.ok).toBe(true);
      expectRedactedInlineMediaBlock(res.payload?.message?.content);
      expect(JSON.stringify(res.payload)).not.toContain(DATA_URL);
      expect(JSON.stringify(res.payload)).not.toContain(INLINE_PAYLOAD);

      console.log(
        `chat.message.get real-request redaction: ${JSON.stringify(res.payload?.message?.content ?? null)}`,
      );
    } finally {
      testState.sessionStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
