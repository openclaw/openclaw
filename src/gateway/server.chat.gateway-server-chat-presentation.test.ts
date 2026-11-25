import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { ReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.types.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { installGatewayServerChatTestSuite } from "./server.chat.gateway-server-chat.test-support.js";
import {
  collectHistoryTextValues,
  createGatewayHistoryText,
  createGatewayHistoryMessageToolCall,
  createGatewayHistoryMessageToolResult,
  createGatewayHistoryDeliveryMirror,
  hasGatewayHistoryMessageToolMirror,
} from "./session-history-fixtures.test-support.js";
import { dispatchInboundMessageMock, onceMessage, rpcReq, testState } from "./test-helpers.js";
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
const { expectRecordFields, withMainSessionStore } = gatewaySuite;

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
    const res = await rpcReq(ws, "chat.send", { sessionKey: "main", message, idempotencyKey });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return res;
  };
  const readHistory = async () => {
    const res = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", { sessionKey: "main" });
    expect(res.ok).toBe(true);
    return res.payload?.messages ?? [];
  };

  const loadChatHistoryWithMessages = (messages: Record<string, unknown>[]) =>
    withMainSessionStore(async () => {
      await replaceMainTranscriptMessages(messages);
      return readHistory();
    });
  const replaceMainTranscriptMessages = async (messages: Record<string, unknown>[]) => {
    const storePath = testState.sessionStorePath;
    if (!storePath) {
      throw new Error("session store path was not initialized");
    }
    await replaceTranscriptEvents(
      { agentId: "main", sessionId: "sess-main", sessionKey: "main", storePath },
      messages.map((message, index) => ({ message, id: `message-${index}`, type: "message" })),
    );
  };

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
});
