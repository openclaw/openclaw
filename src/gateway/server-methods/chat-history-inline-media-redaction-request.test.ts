import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { installGatewayTestHooks, rpcReq, testState } from "../test-helpers.js";
import { installConnectedControlUiServerSuite } from "../test-with-server.js";

installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    testState.sessionStorePath = sessionStorePath;
    for (const session of [
      { sessionId: SESSION_ID, sessionKey: SESSION_KEY },
      ...CURSOR_SESSIONS,
    ]) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: session.sessionKey, storePath: sessionStorePath },
        { sessionId: session.sessionId, updatedAt: Date.now() },
      );
    }
  },
  cleanup: async () => {
    testState.sessionStorePath = undefined;
  },
});

let ws: WebSocket;
const DATA_URL = "DATA:image/png;BASE64,cG5n";
const SESSION_ID = "sess-inline-media-proof";
const SESSION_KEY = "agent:main:main";
const CURSOR_SESSIONS = [
  {
    sessionId: "sess-inline-media-responses-proof",
    sessionKey: "agent:main:inline-media-responses-proof",
  },
  {
    sessionId: "sess-inline-media-nested-proof",
    sessionKey: "agent:main:inline-media-nested-proof",
  },
] as const;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const sessionStorePath = path.join(tempDirs.make("openclaw-chat-history-redact-"), "sessions.json");

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

beforeEach(() => {
  testState.sessionStorePath = sessionStorePath;
});

function expectRedactedInlineMediaBlock(content: unknown): void {
  expect(content).toEqual([
    {
      type: "input_image",
      omitted: true,
      bytes: Buffer.byteLength(DATA_URL, "utf8"),
    },
  ]);
}

describe("chat history inline media redaction (real WS gateway)", () => {
  test("stored history endpoints redact Responses inline images", async () => {
    const appendResult = appendTranscriptMessageSync(
      {
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        storePath: sessionStorePath,
      },
      {
        message: {
          role: "assistant",
          content: [{ type: "input_image", image_url: DATA_URL }],
          timestamp: Date.now(),
        },
        now: Date.now(),
      },
    );
    expect(appendResult.ok).toBe(true);
    const appended = expectDefined(
      appendResult.ok ? appendResult.value : undefined,
      "inline-media transcript append",
    );

    const history = await rpcReq<{ messages?: Array<Record<string, unknown>> }>(
      ws,
      "chat.history",
      { sessionKey: SESSION_KEY, limit: 10 },
    );
    expect(history.ok).toBe(true);
    const historyMessages = history.payload?.messages ?? [];
    const assistantMessage = historyMessages.find((message) => message.role === "assistant");
    expect(assistantMessage).toBeDefined();
    expectRedactedInlineMediaBlock(assistantMessage?.content);
    expect(JSON.stringify(historyMessages)).not.toContain(DATA_URL);

    const full = await rpcReq<{ ok?: boolean; message?: Record<string, unknown> }>(
      ws,
      "chat.message.get",
      { sessionKey: SESSION_KEY, messageId: appended.messageId },
    );
    expect(full.ok).toBe(true);
    expect(full.payload?.ok).toBe(true);
    expectRedactedInlineMediaBlock(full.payload?.message?.content);
    expect(JSON.stringify(full.payload)).not.toContain(DATA_URL);

    console.log(
      `chat.history real-request redaction: ${JSON.stringify(assistantMessage?.content ?? null)}`,
    );
    console.log(
      `chat.message.get real-request redaction: ${JSON.stringify(full.payload?.message?.content ?? null)}`,
    );
  });

  test.each([
    {
      name: "Responses inline images",
      ...CURSOR_SESSIONS[0],
      imageUrl: DATA_URL,
      message: {
        role: "assistant",
        content: [{ type: "input_image", image_url: DATA_URL }],
        timestamp: 1,
      },
      expectedContent: [
        {
          type: "input_image",
          omitted: true,
          bytes: Buffer.byteLength(DATA_URL, "utf8"),
        },
      ],
    },
    {
      name: "nested tool activity inline images",
      ...CURSOR_SESSIONS[1],
      imageUrl: "DATA:image/png;BASE64,bmVzdGVk",
      message: createNestedToolActivity({
        runId: "nested-image-run",
        scopeId: "nested-image-scope",
        afterEntryId: "cached",
        startOrder: 0,
        parentToolCallId: "cached",
        toolCallId: "nested-image-call",
        toolName: "image",
        input: {},
        result: {
          content: [{ type: "input_image", image_url: "DATA:image/png;BASE64,bmVzdGVk" }],
        },
        isError: false,
        startedAt: 1,
        timestamp: 2,
      }),
      expectedContent: [
        { type: "toolCall", id: "nested-image-call" },
        {
          type: "toolResult",
          content: [
            {
              type: "input_image",
              omitted: true,
              bytes: Buffer.byteLength("DATA:image/png;BASE64,bmVzdGVk", "utf8"),
            },
          ],
        },
      ],
    },
  ])(
    "redacts $name from cursor deltas",
    async ({ expectedContent, imageUrl, message, sessionId, sessionKey }) => {
      await appendTranscriptMessage(
        {
          agentId: "main",
          sessionId,
          sessionKey,
          storePath: sessionStorePath,
        },
        {
          eventId: "cached",
          parentId: null,
          message: { role: "user", content: "cached", timestamp: 0 },
        },
      );
      const page = await rpcReq<{ deltaCursor?: string }>(ws, "chat.history", {
        sessionKey,
      });
      await appendTranscriptMessage(
        {
          agentId: "main",
          sessionId,
          sessionKey,
          storePath: sessionStorePath,
        },
        { eventId: "redacted", parentId: "cached", message },
      );

      const delta = await rpcReq<{
        kind?: string;
        messages?: Array<{ message?: { content?: unknown } }>;
      }>(ws, "chat.history", {
        sessionKey,
        cursor: page.payload?.deltaCursor,
      });
      expect(delta.ok).toBe(true);
      expect(delta.payload?.kind).toBe("delta");
      expect(JSON.stringify(delta.payload?.messages)).not.toContain(imageUrl);
      expect(delta.payload?.messages?.[0]?.message?.content).toMatchObject(expectedContent);
    },
  );
});
