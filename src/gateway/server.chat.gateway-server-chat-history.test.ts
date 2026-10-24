import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { drainOpenClawAgentWriteQueuesForTest } from "../state/openclaw-agent-write-admission.test-support.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { writeMainChatSessionTranscript } from "./server.chat-session-store.test-support.js";
import { installGatewayServerChatTestSuite } from "./server.chat.gateway-server-chat.test-support.js";
import {
  collectHistoryTextValues,
  createGatewayHistoryText,
} from "./session-history-fixtures.test-support.js";
import { removeChatTestDirectory as removeTempDir } from "./session-test-directories.test-support.js";
import {
  agentDiscoveryMock,
  connectWebchatClient,
  dispatchInboundMessageMock,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { agentCommandMock } from "./test-helpers.runtime-state.js";

let ws: WebSocket;
let port: number;

const gatewaySuite = installGatewayServerChatTestSuite((started) => {
  ws = started.ws;
  port = started.port;
});
const { settleGatewayFixture, waitForAgentRunDrained, withMainSessionStore } = gatewaySuite;
const assistantContent = (text: string, timestamp: number, type = "text") => ({
  role: "assistant",
  content: [{ type, text }],
  timestamp,
});
const sessionEntry = (sessionId: string, fields: Record<string, unknown> = {}) => ({
  sessionId,
  updatedAt: Date.now(),
  ...fields,
});
async function sendChat(idempotencyKey: string, fields: Record<string, unknown> = {}, client = ws) {
  return rpcReq(client, "chat.send", {
    sessionKey: "main",
    message: "hello",
    idempotencyKey,
    ...fields,
  });
}
async function readHistory() {
  const res = await rpcReq<{ messages?: unknown[]; sessionId?: string }>(ws, "chat.history", {
    sessionKey: "main",
  });
  expect(res.ok).toBe(true);
  return res.payload;
}
const textFieldReply = (content: string, timestamp: number) => ({
  role: "assistant",
  text: "real text field reply",
  content,
  timestamp,
});

describe("gateway server chat", () => {
  const loadChatHistoryWithMessages = async (
    messages: Array<Record<string, unknown>>,
  ): Promise<unknown[]> => {
    return withMainSessionStore(async () => {
      await replaceMainTranscriptMessages(messages);

      return (await readHistory())?.messages ?? [];
    });
  };

  const replaceMainTranscriptMessages = async (
    messages: Record<string, unknown>[],
  ): Promise<void> => {
    await writeMainChatSessionTranscript(
      messages.map((message, index) => ({ message, id: `message-${index}`, type: "message" })),
      "sess-main",
      { sessionKey: "main" },
    );
  };

  test("sanitizes inbound chat.send message text and rejects null bytes", async () => {
    const nullByteRes = await sendChat("idem-null-byte-1", { message: "hello\u0000world" });
    expect(nullByteRes).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/null bytes/i) },
    });

    const sanitizedRes = await sendChat("idem-sanitized-1", { message: "Cafe\u0301\u0007\tline" });
    expect(sanitizedRes.ok).toBe(true);
    await waitForAgentRunDrained("idem-sanitized-1");
  });

  test("handles chat send and history flows", async () => {
    const tempDirs = createTempDirTracker();
    const useStore = async (entries: Record<string, Record<string, unknown>>) => {
      const dir = tempDirs.make("openclaw-gw-");
      testState.sessionStorePath = path.join(dir, "sessions.json");
      await writeSessionStore({ entries });
    };
    let webchatWs: WebSocket | undefined;
    agentDiscoveryMock.enabled = true;
    agentDiscoveryMock.models = [
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        provider: "anthropic",
        input: ["text", "image"],
      },
    ];

    try {
      webchatWs = await connectWebchatClient({
        port,
        client: {
          id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          version: "dev",
          platform: "web",
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        },
      });

      const webchatRes = await sendChat("idem-webchat-1", {}, webchatWs);
      expect(webchatRes.ok).toBe(true);
      await waitForAgentRunDrained("idem-webchat-1");

      webchatWs.close();
      webchatWs = undefined;

      testState.agentConfig = { timeoutSeconds: 123 };
      const timeoutRes = await sendChat("idem-timeout-1");
      expect(timeoutRes.ok).toBe(true);
      expect(timeoutRes.payload?.runId).toBe("idem-timeout-1");
      await waitForAgentRunDrained("idem-timeout-1");
      testState.agentConfig = undefined;

      const sessionRes = await sendChat("idem-session-key-1", {
        sessionKey: "agent:main:subagent:abc",
      });
      expect(sessionRes.ok).toBe(true);
      expect(sessionRes.payload?.runId).toBe("idem-session-key-1");
      await waitForAgentRunDrained("idem-session-key-1");

      testState.sessionConfig = {
        sendPolicy: {
          default: "allow",
          rules: [{ action: "deny", match: { channel: "discord", chatType: "group" } }],
        },
      };

      await useStore({
        "discord:group:dev": sessionEntry("sess-discord", {
          chatType: "group",
          channel: "discord",
        }),
      });

      const blockedRes = await sendChat("idem-1", { sessionKey: "discord:group:dev" });
      expect(blockedRes).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/send blocked/i) },
      });

      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;

      testState.sessionConfig = {
        sendPolicy: {
          default: "allow",
          rules: [{ action: "deny", match: { keyPrefix: "cron:" } }],
        },
      };

      await useStore({ "cron:job-1": sessionEntry("sess-cron") });

      vi.mocked(agentCommandMock).mockClear();
      const agentAllowedRes = await rpcReq(ws, "agent", {
        sessionKey: "cron:job-1",
        message: "hi",
        idempotencyKey: "idem-2",
      });
      expect(agentAllowedRes).toMatchObject({
        ok: true,
        payload: { status: "accepted", runId: "idem-2" },
      });
      await gatewaySuite.requestExecution.waitForCompletion("idem-2");
      expect(agentCommandMock).toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      await drainOpenClawAgentWriteQueuesForTest();

      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;

      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
      // Capture the real capability resolver's inline-image decision before dispatch.
      const inlineDispatches: { runId?: string; images?: unknown[] }[] = [];
      const captureInlineDispatch = async (args: unknown) => {
        const replyOptions = (args as { replyOptions?: { runId?: string; images?: unknown[] } })
          .replyOptions;
        inlineDispatches.push({ runId: replyOptions?.runId, images: replyOptions?.images });
        return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
      };

      const expectedDispatches: { runId: string; images: unknown[] }[] = [];
      for (const [runId, message, attachment] of [
        [
          "idem-img",
          "see image",
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: pngB64 },
          },
        ],
        [
          "idem-img-only",
          "",
          {
            type: "image",
            mimeType: "image/png",
            fileName: "dot.png",
            content: `data:image/png;base64,${pngB64}`,
          },
        ],
      ] as const) {
        dispatchInboundMessageMock.mockImplementationOnce(captureInlineDispatch);
        const response = await sendChat(runId, { message, attachments: [attachment] });
        expect(response.ok).toBe(true);
        expect(typeof response.payload?.runId).toBe("string");
        await waitForAgentRunDrained(runId);
        expectedDispatches.push({ runId, images: [expect.anything()] });
        expect(inlineDispatches).toEqual(expectedDispatches);
      }

      await useStore({ main: sessionEntry("sess-main") });

      await replaceMainTranscriptMessages(
        Array.from({ length: 201 }, (_, i) => ({
          role: "user",
          content: [{ type: "text", text: `m${i}` }],
          timestamp: Date.now() + i,
        })),
      );

      const defaultMsgs = (await readHistory())?.messages ?? [];
      expect(defaultMsgs.length).toBe(200);
      expect(extractFirstTextBlock(defaultMsgs[0])).toBe("m1");
    } finally {
      await settleGatewayFixture();
      Object.assign(agentDiscoveryMock, { enabled: false, models: [] });
      testState.agentConfig = undefined;
      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;
      if (webchatWs) {
        webchatWs.close();
      }
      await Promise.all([...tempDirs.dirs].map((dir) => removeTempDir(dir)));
    }
  });

  test("chat.send accepts the backing session id returned by chat.history", async () => {
    await withMainSessionStore(async () => {
      const sessionId = (await readHistory())?.sessionId;
      expect(sessionId).toBe("sess-main");

      const runId = "idem-chat-send-history-session-id";
      const sendRes = await sendChat(runId, {
        sessionId,
        message: "/context list",
      });
      expect(sendRes.ok).toBe(true);
      expect(sendRes.payload?.status).toBe("started");

      await waitForAgentRunDrained(runId);
    });
  });

  test("chat.history applies the reset kept-tail cut and preserves its marker", async () => {
    await withMainSessionStore(async () => {
      const message = (id: string, parentId: string | null, role: string, content: string) => ({
        type: "message",
        id,
        parentId,
        message: { role, content },
      });
      await writeMainChatSessionTranscript(
        [
          message("old", null, "user", "old"),
          message("kept-user", "old", "user", "kept question"),
          message("kept-tool", "kept-user", "toolResult", "hidden tool"),
          message("kept-assistant", "kept-tool", "assistant", "kept answer"),
          {
            type: "reset",
            id: "reset-boundary",
            parentId: "kept-assistant",
            timestamp: "2026-07-22T00:00:00.000Z",
            reason: "new",
            firstKeptEntryId: "kept-user",
          },
          message("post-reset", "reset-boundary", "user", "new turn"),
        ],
        "sess-main",
        { sessionKey: "main" },
      );

      expect(collectHistoryTextValues((await readHistory())?.messages ?? [])).toEqual([
        "kept question",
        "kept answer",
        "Reset",
        "new turn",
      ]);
    });
  });

  const contextOverflowCopy =
    "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.";

  test.each([
    [
      "structured context-overflow code",
      "context_overflow",
      "private upstream body: 203557 tokens sent",
      contextOverflowCopy,
    ],
    [
      "token-per-minute rate limit",
      "rate_limit_exceeded",
      "413 request too large: 203557 tokens per minute (TPM)",
      "⚠️ The AI service needs a short break. Please try again in a few minutes.",
    ],
    [
      "private upstream failure",
      undefined,
      "private upstream at secret.internal.example failed",
      "The agent run failed before producing a reply.",
    ],
  ] as const)(
    "chat.history safely displays %s over authenticated WebSocket",
    async (_name, errorCode, errorMessage, expected) => {
      const historyMessages = await loadChatHistoryWithMessages([
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          ...(errorCode ? { errorCode } : {}),
          errorMessage,
          timestamp: 1,
        },
      ]);

      expect(collectHistoryTextValues(historyMessages)).toEqual([expected]);
      const wirePayload = JSON.stringify(historyMessages);
      expect(wirePayload).not.toContain("203557");
      expect(wirePayload).not.toContain("196607");
      expect(wirePayload).not.toContain("secret.internal.example");
      expect(historyMessages[0]).not.toHaveProperty("errorCode");
      expect(historyMessages[0]).not.toHaveProperty("errorType");
      expect(historyMessages[0]).not.toHaveProperty("errorMessage");
    },
  );

  test.each([
    {
      name: "hides assistant control replies in Responses output blocks",
      messages: [
        assistantContent("NO_REPLY", 1, "output_text"),
        assistantContent("visible response", 2, "output_text"),
        assistantContent("NO_REPLY", 3, "input_text"),
        assistantContent("visible assistant input", 4, "input_text"),
      ],
      expected: ["assistant:visible response", "assistant:visible assistant input"],
    },
    {
      name: "hides commentary-only assistant entries",
      messages: [
        createGatewayHistoryText("user", "hello", 1),
        { ...assistantContent("thinking like caveman", 2), phase: "commentary" },
        createGatewayHistoryText("assistant", "real reply", 3),
      ],
      expected: ["user:hello", "assistant:real reply"],
    },
    {
      name: "preserves literal announce/reply skip text outside its owning protocol",
      messages: [
        createGatewayHistoryText("assistant", "ANNOUNCE_SKIP", 1),
        createGatewayHistoryText("assistant", "REPLY_SKIP", 2),
        textFieldReply("ANNOUNCE_SKIP", 3),
        createGatewayHistoryText("assistant", "real reply", 4),
      ],
      expected: [
        "assistant:ANNOUNCE_SKIP",
        "assistant:REPLY_SKIP",
        "assistant:real text field reply",
        "assistant:real reply",
      ],
    },
    {
      name: "hides assistant NO_REPLY-only entries and keeps mixed-content assistant entries",
      messages: [
        createGatewayHistoryText("user", "hello", 1),
        createGatewayHistoryText("assistant", "NO_REPLY", 2),
        createGatewayHistoryText("assistant", "real reply", 3),
        textFieldReply("NO_REPLY", 4),
        createGatewayHistoryText("user", "NO_REPLY", 5),
        {
          role: "assistant",
          content: [
            { type: "text", text: "NO_REPLY" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
          ],
          timestamp: 6,
        },
      ],
      expected: [
        "user:hello",
        "assistant:real reply",
        "assistant:real text field reply",
        "user:NO_REPLY",
        "assistant:NO_REPLY",
      ],
    },
  ])("chat.history $name", async ({ messages, expected }) => {
    const historyMessages = await loadChatHistoryWithMessages(messages);
    const roleAndText = historyMessages.map((message) => {
      const entry = isRecord(message) ? message : {};
      const role = typeof entry.role === "string" ? entry.role : "unknown";
      const text = collectHistoryTextValues([message])[0] ?? "";
      return `${role}:${text}`;
    });

    expect(roleAndText).toEqual(expected);
  });
});
