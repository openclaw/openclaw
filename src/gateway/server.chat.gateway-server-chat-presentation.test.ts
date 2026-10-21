import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { ReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.types.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { drainOpenClawAgentWriteQueuesForTest } from "../state/openclaw-agent-write-admission.test-support.js";
import { installGatewayServerChatTestSuite } from "./server.chat.gateway-server-chat.test-support.js";
import {
  collectHistoryTextValues,
  createGatewayHistoryText,
  createGatewayHistoryMessageToolCall,
  createGatewayHistoryMessageToolResult,
  createGatewayHistoryDeliveryMirror,
  hasGatewayHistoryMessageToolMirror,
} from "./session-history-fixtures.test-support.js";
import { removeChatTestDirectory as removeTempDir } from "./session-test-directories.test-support.js";
import {
  agentDiscoveryMock,
  dispatchInboundMessageMock,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { agentCommandMock } from "./test-helpers.runtime-state.js";
const YAML_PARTS = ["```yaml\nroot:\n", "  nested:\n    value: true\n```"];

function mockDispatchedReplies(kind: "final" | "block", payloads: ReplyPayload[]) {
  dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
    const [params] = args as [{ dispatcher: ReplyDispatcher }];
    for (const payload of payloads) {
      params.dispatcher[kind === "final" ? "sendFinalReply" : "sendBlockReply"](payload);
    }
    params.dispatcher.markComplete();
    await params.dispatcher.waitForIdle();
    return { queuedFinal: kind === "final", counts: params.dispatcher.getQueuedCounts() };
  });
}

let ws: WebSocket;

const gatewaySuite = installGatewayServerChatTestSuite((started) => {
  ws = started.ws;
});
const {
  expectRecordFields,
  withMainSessionStore,
  replaceMainTranscriptMessages,
  settleGatewayFixture,
  waitForAgentRunDrained,
} = gatewaySuite;
const historyAssistantBlock = (text: string, timestamp: number, type = "text") => ({
  role: "assistant",
  content: [{ type, text }],
  timestamp,
});
const sessionEntry = (sessionId: string, fields: Record<string, unknown> = {}) => ({
  sessionId,
  updatedAt: Date.now(),
  ...fields,
});
const sendHistoryChat = (id: string, fields: Record<string, unknown> = {}, target = ws) =>
  gatewaySuite.sendChat(id, "hello", fields, target);
const textFieldReply = (content: string, timestamp: number) => ({
  role: "assistant",
  text: "real text field reply",
  content,
  timestamp,
});

const readHistoryResponse = () => gatewaySuite.readHistory();

describe("gateway server chat", () => {
  const waitForChatEvent = (runId: string, sideResult = false) =>
    onceMessage(
      ws,
      (event) =>
        event.type === "event" &&
        event.event === (sideResult ? "chat.side_result" : "chat") &&
        (sideResult ? event.payload?.kind === "btw" : event.payload?.state === "final") &&
        event.payload?.runId === runId,
      8_000,
    );
  const sendChat = async (idempotencyKey: string, message: string) => {
    const res = await gatewaySuite.sendChat(idempotencyKey, message);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return res;
  };
  const readHistory = async () => {
    return (await gatewaySuite.readHistory())?.messages ?? [];
  };

  const loadChatHistoryWithMessages = (messages: Record<string, unknown>[]) =>
    withMainSessionStore(async () => {
      await replaceMainTranscriptMessages(messages);
      return readHistory();
    });

  test("chat.history omits argument-derived replies for partial broadcasts and retains diagnostics", async () => {
    const result = {
      kind: "broadcast",
      payload: {
        results: [
          { to: "first", ok: true, payload: { ok: true, messageId: "sent-first" } },
          { to: "second", ok: false, attempted: false },
        ],
      },
    };
    const argumentsRecord = {
      action: "send",
      channel: "telegram",
      target: "current",
      message: "Unverified argument caption.",
    };
    const call = createGatewayHistoryMessageToolCall("reused-call", argumentsRecord, 2);
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryText("user", "reply here", 1),
      call,
      createGatewayHistoryMessageToolResult("reused-call", result, 3),
      createGatewayHistoryText("assistant", "NO_REPLY", 4),
      createGatewayHistoryText("assistant", "An ordinary final reply.", 5),
    ]);

    expect(collectHistoryTextValues(historyMessages)).toEqual([
      "reply here",
      "An ordinary final reply.",
    ]);
    expect(historyMessages).toContainEqual(expect.objectContaining({ content: call.content }));
    expect(historyMessages).toContainEqual(
      expect.objectContaining({ role: "toolResult", toolCallId: "reused-call", content: result }),
    );
    expect(historyMessages.some(hasGatewayHistoryMessageToolMirror)).toBe(false);
  });

  test("chat.history retains canonical publications after tool results without caption or call-ID joins", async () => {
    const imageBlocks = ["first", "second"].map((name) => ({
      type: "image",
      artifactId: `artifact_managed_image_${name}`,
      url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${name}/full`,
      openUrl: `/api/chat/media/outgoing/agent%3Amain%3Amain/${name}/full`,
      alt: `${name}.png`,
      mimeType: "image/png",
    }));
    const publications = imageBlocks.map((image, index) => ({
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [{ type: "text", text: "Sanitized publication." }, image],
      openclawDeliveryMirror: { kind: "message-tool-source-reply", toolCallId: "different-call" },
      timestamp: index + 3,
    }));
    const result = createGatewayHistoryMessageToolResult("reused-call", { ok: true }, 5);
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryMessageToolCall(
        "reused-call",
        { action: "send", message: "Unverified argument caption." },
        1,
      ),
      result,
      ...publications,
      createGatewayHistoryText("assistant", "NO_REPLY", 6),
    ]);
    const expectPublications = (messages: unknown[]) => {
      expect(collectHistoryTextValues(messages)).toEqual(Array(2).fill("Sanitized publication."));
      for (const publication of publications) {
        expect(messages).toContainEqual(expect.objectContaining(publication));
      }
    };
    expectPublications(historyMessages);
    expect(historyMessages.some(hasGatewayHistoryMessageToolMirror)).toBe(false);
    const publicRows = historyMessages.filter(isRecord);
    expect(publicRows).toHaveLength(historyMessages.length);
    expectPublications(await loadChatHistoryWithMessages(publicRows));
  });

  test("chat.history drops retired synthetic replies without dropping canonical or forwarded messages", async () => {
    const historyMessages = await loadChatHistoryWithMessages([
      createGatewayHistoryMessageToolCall(
        "reused-call",
        { action: "send", message: "Private old arguments." },
        1,
      ),
      {
        ...createGatewayHistoryText("assistant", "Private old arguments.", 2),
        openclawMessageToolMirror: { toolName: "message", toolCallId: "reused-call" },
      },
      createGatewayHistoryDeliveryMirror("Published reply.", 3),
      {
        ...createGatewayHistoryText("assistant", "Forwarded update.", 4),
        senderLabel: "Forwarded from main",
        senderSession: { sessionKey: "agent:main:source", agentId: "main" },
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:source",
          sourceTool: "sessions_send",
        },
      },
    ]);
    expect(collectHistoryTextValues(historyMessages)).toEqual([
      "Published reply.",
      "Forwarded update.",
    ]);
    expect(historyMessages.some(hasGatewayHistoryMessageToolMirror)).toBe(false);
  });

  test.each([false, true])(
    "preserves split fenced-code indentation (side result: %s)",
    async (side) => {
      await withMainSessionStore(async () => {
        const expected = YAML_PARTS.join("");
        const runId = `idem-fenced-code-${side}`;
        mockDispatchedReplies(
          side ? "block" : "final",
          YAML_PARTS.map((text) => (side ? { text, btw: { question: "show YAML" } } : { text })),
        );
        const eventPromise = waitForChatEvent(runId, side);
        await sendChat(runId, side ? "/btw show YAML" : "show the YAML");
        const event = await eventPromise;
        if (side) {
          expectRecordFields(event.payload, {
            kind: "btw",
            runId,
            question: "show YAML",
            text: expected,
          });
        } else {
          expect(extractFirstTextBlock(event.payload?.message)).toBe(expected);
          expect(collectHistoryTextValues(await readHistory())).toContain(expected);
        }
      });
    },
  );

  test("routes slash commands without agent runs", () =>
    withMainSessionStore(async () => {
      const spy = vi.mocked(agentCommandMock);
      const callsBefore = spy.mock.calls.length;
      const eventPromise = waitForChatEvent("idem-command-1");
      await sendChat("idem-command-1", "/context list");
      await eventPromise;
      expect(spy.mock.calls.length).toBe(callsBefore);
    }));

  test("routes /btw without transcript injection", () =>
    withMainSessionStore(async () => {
      await replaceMainTranscriptMessages([
        createGatewayHistoryText("user", "main thread context", Date.now()),
      ]);
      mockDispatchedReplies("final", [{ text: "323", btw: { question: "what is 17 * 19?" } }]);
      const sideResultPromise = waitForChatEvent("idem-btw-1", true);
      const finalPromise = waitForChatEvent("idem-btw-1");

      await sendChat("idem-btw-1", "/btw what is 17 * 19?");
      await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalled(), {
        interval: 1,
      });
      const sideResult = await sideResultPromise;
      const finalEvent = await finalPromise;
      expectRecordFields(sideResult.payload, {
        kind: "btw",
        runId: "idem-btw-1",
        sessionKey: "agent:main:main",
        question: "what is 17 * 19?",
        text: "323",
      });
      expectRecordFields(finalEvent.payload, {
        runId: "idem-btw-1",
        sessionKey: "agent:main:main",
        state: "final",
      });

      expect(collectHistoryTextValues(await readHistory())).toEqual(["main thread context"]);
    }));

  test("chat.history persists assistant image data URLs as managed image blocks", async () => {
    await withMainSessionStore(
      async () => {
        const pngB64 =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
        mockDispatchedReplies("final", [
          { text: "Image reply", mediaUrls: [`data:image/png;base64,${pngB64}`] },
        ]);

        const finalPromise = waitForChatEvent("idem-managed-image-history");
        const response = await sendChat("idem-managed-image-history", "show me an image");
        expect(response.payload?.runId).toBe("idem-managed-image-history");
        await finalPromise;

        const assistantMessage = await vi.waitFor(
          async () =>
            expectRecordFields(
              (await readHistory()).find(
                (message) => isRecord(message) && message.role === "assistant",
              ),
              { role: "assistant" },
            ),
          { interval: 1, timeout: 10_000 },
        );
        const assistantContent = (assistantMessage as { content?: unknown[] }).content ?? [];
        expect(assistantContent).toHaveLength(2);
        expect(assistantContent[0]).toEqual({ type: "text", text: "Image reply" });
        expectRecordFields(assistantContent[1], {
          type: "image",
          alt: "Generated image 1",
          mimeType: "image/png",
          width: 1,
          height: 1,
          url: expect.stringContaining("/api/chat/media/outgoing/"),
          openUrl: expect.stringContaining("/full"),
        });
        const serializedAssistant = JSON.stringify(assistantMessage);
        expect(serializedAssistant).not.toContain("data:image/png;base64");
        expect(serializedAssistant).not.toContain(pngB64);
      },
      { sessionId: "sess-managed-image-history" },
    );
  });

  test("sanitizes inbound chat.send message text and rejects null bytes", async () => {
    const nullByteRes = await sendHistoryChat("idem-null-byte-1", { message: "hello\u0000world" });
    expect(nullByteRes).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/null bytes/i) },
    });

    const sanitizedRes = await sendHistoryChat("idem-sanitized-1", {
      message: "Cafe\u0301\u0007\tline",
    });
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
      const sessionRes = await sendHistoryChat("idem-session-key-1", {
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

      const blockedRes = await sendHistoryChat("idem-1", { sessionKey: "discord:group:dev" });
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
        const response = await sendHistoryChat(runId, { message, attachments: [attachment] });
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

      const defaultMsgs = (await readHistoryResponse())?.messages ?? [];
      expect(defaultMsgs.length).toBe(200);
      expect(extractFirstTextBlock(defaultMsgs[0])).toBe("m1");
    } finally {
      await settleGatewayFixture();
      Object.assign(agentDiscoveryMock, { enabled: false, models: [] });
      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;
      await Promise.all([...tempDirs.dirs].map((dir) => removeTempDir(dir)));
    }
  });

  test("chat.send accepts the backing session id returned by chat.history", async () => {
    await withMainSessionStore(async () => {
      const sessionId = (await readHistoryResponse())?.sessionId;
      expect(sessionId).toBe("sess-main");

      const runId = "idem-chat-send-history-session-id";
      const sendRes = await sendHistoryChat(runId, {
        sessionId,
        message: "/context list",
      });
      expect(sendRes.ok).toBe(true);
      expect(sendRes.payload?.status).toBe("started");

      await waitForAgentRunDrained(runId);
    });
  });

  test("chat.history redacts private upstream failures over authenticated WebSocket", async () => {
    const historyMessages = await loadChatHistoryWithMessages([
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "private upstream at secret.internal.example failed",
        timestamp: 1,
      },
    ]);
    expect(collectHistoryTextValues(historyMessages)).toEqual([
      "The agent run failed before producing a reply.",
    ]);
    const wirePayload = JSON.stringify(historyMessages);
    expect(wirePayload).not.toContain("203557");
    expect(wirePayload).not.toContain("196607");
    expect(wirePayload).not.toContain("secret.internal.example");
    expect(historyMessages[0]).not.toHaveProperty("errorCode");
    expect(historyMessages[0]).not.toHaveProperty("errorType");
    expect(historyMessages[0]).not.toHaveProperty("errorMessage");
  });

  test.each([
    {
      name: "hides assistant control replies in Responses output blocks",
      messages: [
        historyAssistantBlock("NO_REPLY", 1, "output_text"),
        historyAssistantBlock("visible response", 2, "output_text"),
        historyAssistantBlock("NO_REPLY", 3, "input_text"),
        historyAssistantBlock("visible assistant input", 4, "input_text"),
      ],
      expected: ["assistant:visible response", "assistant:visible assistant input"],
    },
    {
      name: "hides commentary-only assistant entries",
      messages: [
        createGatewayHistoryText("user", "hello", 1),
        { ...historyAssistantBlock("thinking like caveman", 2), phase: "commentary" },
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
