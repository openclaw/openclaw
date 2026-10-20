// Gateway server chat tests cover WebSocket chat flow, history construction,
// NO_REPLY handling, agent events, and connected control-UI delivery.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { drainOpenClawAgentWriteQueuesForTest } from "../state/openclaw-agent-write-admission.test-support.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { installGatewayServerChatTestSuite } from "./server.chat.gateway-server-chat.test-support.js";
import {
  collectHistoryTextValues,
  createGatewayHistoryText,
} from "./session-history-fixtures.test-support.js";
import { removeChatTestDirectory as removeTempDir } from "./session-test-directories.test-support.js";
import {
  agentDiscoveryMock,
  connectOk,
  dispatchInboundMessageMock,
  rpcReq,
  testState,
  trackConnectChallengeNonce,
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

describe("gateway server chat", () => {
  const loadChatHistoryWithMessages = async (
    messages: Array<Record<string, unknown>>,
  ): Promise<unknown[]> => {
    return withMainSessionStore(async () => {
      await replaceMainTranscriptMessages(messages);

      const res = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(res.ok).toBe(true);
      return res.payload?.messages ?? [];
    });
  };

  const replaceMainTranscriptMessages = async (
    messages: Record<string, unknown>[],
  ): Promise<void> => {
    const storePath = testState.sessionStorePath;
    if (!storePath) {
      throw new Error("session store path was not initialized");
    }
    const events = messages.map((message, index) => ({
      message,
      id: `message-${index}`,
      type: "message",
    }));
    await replaceTranscriptEvents(
      { agentId: "main", sessionId: "sess-main", sessionKey: "main", storePath },
      events,
    );
  };

  test("sanitizes inbound chat.send message text and rejects null bytes", async () => {
    const nullByteRes = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "hello\u0000world",
      idempotencyKey: "idem-null-byte-1",
    });
    expect(nullByteRes.ok).toBe(false);
    expect((nullByteRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
      /null bytes/i,
    );

    const sanitizedRes = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "Cafe\u0301\u0007\tline",
      idempotencyKey: "idem-sanitized-1",
    });
    expect(sanitizedRes.ok).toBe(true);
    await waitForAgentRunDrained("idem-sanitized-1");
  });

  test("handles chat send and history flows", async () => {
    const tempDirs: string[] = [];
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
      webchatWs = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      trackConnectChallengeNonce(webchatWs);
      await new Promise<void>((resolve) => {
        webchatWs?.once("open", resolve);
      });
      await connectOk(webchatWs, {
        client: {
          id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          version: "dev",
          platform: "web",
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        },
      });

      const webchatRes = await rpcReq(webchatWs, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-webchat-1",
      });
      expect(webchatRes.ok).toBe(true);
      await waitForAgentRunDrained("idem-webchat-1");

      webchatWs.close();
      webchatWs = undefined;

      testState.agentConfig = { timeoutSeconds: 123 };
      const timeoutRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-timeout-1",
      });
      expect(timeoutRes.ok).toBe(true);
      expect(timeoutRes.payload?.runId).toBe("idem-timeout-1");
      await waitForAgentRunDrained("idem-timeout-1");
      testState.agentConfig = undefined;

      const sessionRes = await rpcReq(ws, "chat.send", {
        sessionKey: "agent:main:subagent:abc",
        message: "hello",
        idempotencyKey: "idem-session-key-1",
      });
      expect(sessionRes.ok).toBe(true);
      expect(sessionRes.payload?.runId).toBe("idem-session-key-1");
      await waitForAgentRunDrained("idem-session-key-1");

      const sendPolicyDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(sendPolicyDir);
      testState.sessionStorePath = path.join(sendPolicyDir, "sessions.json");
      testState.sessionConfig = {
        sendPolicy: {
          default: "allow",
          rules: [
            {
              action: "deny",
              match: { channel: "discord", chatType: "group" },
            },
          ],
        },
      };

      await writeSessionStore({
        entries: {
          "discord:group:dev": {
            sessionId: "sess-discord",
            updatedAt: Date.now(),
            chatType: "group",
            channel: "discord",
          },
        },
      });

      const blockedRes = await rpcReq(ws, "chat.send", {
        sessionKey: "discord:group:dev",
        message: "hello",
        idempotencyKey: "idem-1",
      });
      expect(blockedRes.ok).toBe(false);
      expect((blockedRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
        /send blocked/i,
      );

      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;

      const agentBlockedDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(agentBlockedDir);
      testState.sessionStorePath = path.join(agentBlockedDir, "sessions.json");
      testState.sessionConfig = {
        sendPolicy: {
          default: "allow",
          rules: [{ action: "deny", match: { keyPrefix: "cron:" } }],
        },
      };

      await writeSessionStore({
        entries: {
          "cron:job-1": {
            sessionId: "sess-cron",
            updatedAt: Date.now(),
          },
        },
      });

      vi.mocked(agentCommandMock).mockClear();
      const agentAllowedRes = await rpcReq(ws, "agent", {
        sessionKey: "cron:job-1",
        message: "hi",
        idempotencyKey: "idem-2",
      });
      expect(agentAllowedRes.ok).toBe(true);
      expect(agentAllowedRes.payload?.status).toBe("accepted");
      expect(agentAllowedRes.payload?.runId).toBe("idem-2");
      await gatewaySuite.requestExecution.waitForCompletion("idem-2");
      expect(agentCommandMock).toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      await drainOpenClawAgentWriteQueuesForTest();

      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;

      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
      // The discovered model advertises image input, so the real capability
      // resolver must keep these attachments inline; offloading here would mean
      // the catalog lookup silently failed and returned false. Capability
      // resolution happens before dispatch, so capturing dispatch args observes
      // the real resolver's decision.
      const inlineDispatches: { runId?: string; images?: unknown[] }[] = [];
      const captureInlineDispatch = async (args: unknown) => {
        const replyOptions = (args as { replyOptions?: { runId?: string; images?: unknown[] } })
          .replyOptions;
        inlineDispatches.push({ runId: replyOptions?.runId, images: replyOptions?.images });
        return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
      };

      dispatchInboundMessageMock.mockImplementationOnce(captureInlineDispatch);
      const imgRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "see image",
        idempotencyKey: "idem-img",
        attachments: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: pngB64,
            },
          },
        ],
      });
      expect(imgRes.ok).toBe(true);
      expect(typeof imgRes.payload?.runId).toBe("string");
      await waitForAgentRunDrained("idem-img");
      expect(inlineDispatches).toEqual([{ runId: "idem-img", images: [expect.anything()] }]);
      dispatchInboundMessageMock.mockImplementationOnce(captureInlineDispatch);
      const imgOnlyRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "",
        idempotencyKey: "idem-img-only",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "dot.png",
            content: `data:image/png;base64,${pngB64}`,
          },
        ],
      });
      expect(imgOnlyRes.ok).toBe(true);
      expect(typeof imgOnlyRes.payload?.runId).toBe("string");
      await waitForAgentRunDrained("idem-img-only");
      expect(inlineDispatches).toEqual([
        { runId: "idem-img", images: [expect.anything()] },
        { runId: "idem-img-only", images: [expect.anything()] },
      ]);

      const historyDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(historyDir);
      testState.sessionStorePath = path.join(historyDir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      await replaceMainTranscriptMessages(
        Array.from({ length: 201 }, (_, i) => ({
          role: "user",
          content: [{ type: "text", text: `m${i}` }],
          timestamp: Date.now() + i,
        })),
      );

      const defaultRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(defaultRes.ok).toBe(true);
      const defaultMsgs = defaultRes.payload?.messages ?? [];
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
      await Promise.all(tempDirs.map((dir) => removeTempDir(dir)));
    }
  });

  test("chat.send accepts the backing session id returned by chat.history", async () => {
    await withMainSessionStore(async () => {
      const historyRes = await rpcReq<{ sessionId?: string }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(historyRes.ok).toBe(true);
      const sessionId = historyRes.payload?.sessionId;
      expect(sessionId).toBe("sess-main");

      const runId = "idem-chat-send-history-session-id";
      const sendRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        sessionId,
        message: "/context list",
        idempotencyKey: runId,
      });
      expect(sendRes.ok).toBe(true);
      expect(sendRes.payload?.status).toBe("started");

      await waitForAgentRunDrained(runId);
    });
  });

  test("chat.history applies the reset kept-tail cut and preserves its marker", async () => {
    await withMainSessionStore(async () => {
      const storePath = testState.sessionStorePath;
      if (!storePath) {
        throw new Error("session store path was not initialized");
      }
      await replaceTranscriptEvents(
        { agentId: "main", sessionId: "sess-main", sessionKey: "main", storePath },
        [
          { type: "message", id: "old", parentId: null, message: { role: "user", content: "old" } },
          {
            type: "message",
            id: "kept-user",
            parentId: "old",
            message: { role: "user", content: "kept question" },
          },
          {
            type: "message",
            id: "kept-tool",
            parentId: "kept-user",
            message: { role: "toolResult", content: "hidden tool" },
          },
          {
            type: "message",
            id: "kept-assistant",
            parentId: "kept-tool",
            message: { role: "assistant", content: "kept answer" },
          },
          {
            type: "reset",
            id: "reset-boundary",
            parentId: "kept-assistant",
            timestamp: "2026-07-22T00:00:00.000Z",
            reason: "new",
            firstKeptEntryId: "kept-user",
          },
          {
            type: "message",
            id: "post-reset",
            parentId: "reset-boundary",
            message: { role: "user", content: "new turn" },
          },
        ],
      );

      const history = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });

      expect(history.ok).toBe(true);
      expect(collectHistoryTextValues(history.payload?.messages ?? [])).toEqual([
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
    {
      name: "structured context-overflow code",
      fields: {
        errorCode: "context_overflow",
        errorMessage: "private upstream body: 203557 tokens sent",
      },
      expected: contextOverflowCopy,
    },

    {
      name: "token-per-minute rate limit",
      fields: {
        errorCode: "rate_limit_exceeded",
        errorMessage: "413 request too large: 203557 tokens per minute (TPM)",
      },
      expected: "⚠️ The AI service needs a short break. Please try again in a few minutes.",
    },
    {
      name: "private upstream failure",
      fields: { errorMessage: "private upstream at secret.internal.example failed" },
      expected: "The agent run failed before producing a reply.",
    },
  ])(
    "chat.history safely displays $name over authenticated WebSocket",
    async ({ fields, expected }) => {
      const historyMessages = await loadChatHistoryWithMessages([
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          ...fields,
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
        {
          role: "assistant",
          content: [{ type: "output_text", text: "NO_REPLY" }],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "output_text", text: "visible response" }],
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [{ type: "input_text", text: "NO_REPLY" }],
          timestamp: 3,
        },
        {
          role: "assistant",
          content: [{ type: "input_text", text: "visible assistant input" }],
          timestamp: 4,
        },
      ],
      expected: ["assistant:visible response", "assistant:visible assistant input"],
    },
    {
      name: "hides commentary-only assistant entries",
      messages: [
        createGatewayHistoryText("user", "hello", 1),
        {
          role: "assistant",
          phase: "commentary",
          content: [{ type: "text", text: "thinking like caveman" }],
          timestamp: 2,
        },
        createGatewayHistoryText("assistant", "real reply", 3),
      ],
      expected: ["user:hello", "assistant:real reply"],
    },
    {
      name: "preserves literal announce/reply skip text outside its owning protocol",
      messages: [
        createGatewayHistoryText("assistant", "ANNOUNCE_SKIP", 1),
        createGatewayHistoryText("assistant", "REPLY_SKIP", 2),
        {
          role: "assistant",
          text: "real text field reply",
          content: "ANNOUNCE_SKIP",
          timestamp: 3,
        },
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
        {
          role: "assistant",
          text: "real text field reply",
          content: "NO_REPLY",
          timestamp: 4,
        },
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
      const text =
        typeof entry.text === "string" ? entry.text : (extractFirstTextBlock(message) ?? "");
      return `${role}:${text}`;
    });

    expect(roleAndText).toEqual(expected);
  });
});
