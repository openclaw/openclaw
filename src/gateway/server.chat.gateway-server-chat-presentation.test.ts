// Gateway server chat tests cover WebSocket chat flow, history construction,
// NO_REPLY handling, agent events, and connected control-UI delivery.
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
const CHAT_RESPONSE_TIMEOUT_MS = 10_000;

function mockDispatchedReplies(kind: "final" | "block", payloads: ReplyPayload[]) {
  dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
    const [params] = args as [{ dispatcher: ReplyDispatcher }];
    for (const payload of payloads) {
      if (kind === "final") {
        params.dispatcher.sendFinalReply(payload);
      } else {
        params.dispatcher.sendBlockReply(payload);
      }
    }
    params.dispatcher.markComplete();
    await params.dispatcher.waitForIdle();
    return { queuedFinal: kind === "final", counts: params.dispatcher.getQueuedCounts() };
  });
}

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

let ws: WebSocket;

const gatewaySuite = installGatewayServerChatTestSuite((started) => {
  ws = started.ws;
});
const { expectRecordFields, withMainSessionStore } = gatewaySuite;

describe("gateway server chat", () => {
  const waitForChatEvent = (runId: string, state = "final") =>
    onceMessage(
      ws,
      (event) =>
        event.type === "event" &&
        event.event === "chat" &&
        event.payload?.state === state &&
        event.payload?.runId === runId,
      8_000,
    );

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
    expect(collectHistoryTextValues(historyMessages)).toEqual([
      "Sanitized publication.",
      "Sanitized publication.",
    ]);
    for (const publication of publications) {
      expect(historyMessages).toContainEqual(expect.objectContaining(publication));
    }
    expect(historyMessages.some(hasGatewayHistoryMessageToolMirror)).toBe(false);
    const publicRows = historyMessages.filter(isRecord);
    expect(publicRows).toHaveLength(historyMessages.length);
    const reprojected = await loadChatHistoryWithMessages(publicRows);
    expect(collectHistoryTextValues(reprojected)).toEqual([
      "Sanitized publication.",
      "Sanitized publication.",
    ]);
    for (const publication of publications) {
      expect(reprojected).toContainEqual(expect.objectContaining(publication));
    }
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

  test("preserves split fenced-code indentation in chat.send events and history", async () => {
    await withMainSessionStore(async () => {
      const expected = "```yaml\nroot:\n  nested:\n    value: true\n```";
      mockDispatchedReplies("final", [
        { text: "```yaml\nroot:\n" },
        { text: "  nested:\n    value: true\n```" },
      ]);
      const finalPromise = waitForChatEvent("idem-fenced-code-indentation");

      const result = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "show the YAML",
        idempotencyKey: "idem-fenced-code-indentation",
      });
      expect(result.ok).toBe(true);
      const finalEvent = await finalPromise;
      expect(extractFirstTextBlock(finalEvent.payload?.message)).toBe(expected);

      const history = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(history.ok).toBe(true);
      expect(collectHistoryTextValues(history.payload?.messages ?? [])).toContain(expected);
    });
  });

  test("routes chat.send slash commands without agent runs", async () => {
    await withMainSessionStore(async () => {
      const spy = vi.mocked(agentCommandMock);
      const callsBefore = spy.mock.calls.length;
      const eventPromise = waitForChatEvent("idem-command-1");
      const res = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "/context list",
        idempotencyKey: "idem-command-1",
      });
      expect(res.ok).toBe(true);
      await eventPromise;
      expect(spy.mock.calls.length).toBe(callsBefore);
    });
  });

  test("routes /btw replies through side-result events without transcript injection", async () => {
    await withMainSessionStore(async () => {
      await replaceMainTranscriptMessages([
        createGatewayHistoryText("user", "main thread context", Date.now()),
      ]);
      mockDispatchedReplies("final", [{ text: "323", btw: { question: "what is 17 * 19?" } }]);
      const sideResultPromise = onceMessage(
        ws,
        (o) =>
          o.type === "event" &&
          o.event === "chat.side_result" &&
          o.payload?.kind === "btw" &&
          o.payload?.runId === "idem-btw-1",
        8000,
      );
      const finalPromise = waitForChatEvent("idem-btw-1");

      const res = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "/btw what is 17 * 19?",
        idempotencyKey: "idem-btw-1",
      });

      expect(res.ok).toBe(true);
      await waitForFast(() => {
        expect(dispatchInboundMessageMock).toHaveBeenCalled();
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

      const historyRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(historyRes.ok).toBe(true);
      const historyTexts = collectHistoryTextValues(historyRes.payload?.messages ?? []);
      expect(historyTexts).toEqual(["main thread context"]);
    });
  });

  test("preserves split fenced-code indentation in /btw side-result events", async () => {
    await withMainSessionStore(async () => {
      mockDispatchedReplies("block", [
        { text: "```yaml\nroot:\n", btw: { question: "show YAML" } },
        { text: "  nested:\n    value: true\n```", btw: { question: "show YAML" } },
      ]);
      const sideResultPromise = onceMessage(
        ws,
        (event) =>
          event.type === "event" &&
          event.event === "chat.side_result" &&
          event.payload?.kind === "btw" &&
          event.payload?.runId === "idem-btw-fenced-code-indentation",
        8_000,
      );

      const result = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "/btw show YAML",
        idempotencyKey: "idem-btw-fenced-code-indentation",
      });
      expect(result.ok).toBe(true);
      expectRecordFields((await sideResultPromise).payload, {
        kind: "btw",
        runId: "idem-btw-fenced-code-indentation",
        question: "show YAML",
        text: "```yaml\nroot:\n  nested:\n    value: true\n```",
      });
    });
  });

  test("chat.history persists assistant image data URLs as managed image blocks", async () => {
    await withMainSessionStore(
      async () => {
        // Keep the connected owner's profile and media in the suite-owned state directory.
        const pngB64 =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
        mockDispatchedReplies("final", [
          { text: "Image reply", mediaUrls: [`data:image/png;base64,${pngB64}`] },
        ]);

        const finalPromise = waitForChatEvent("idem-managed-image-history");
        await Promise.all([
          rpcReq(ws, "chat.send", {
            sessionKey: "main",
            message: "show me an image",
            idempotencyKey: "idem-managed-image-history",
          }).then((res) => {
            expect(res.ok, JSON.stringify(res)).toBe(true);
            expect(res.payload?.runId).toBe("idem-managed-image-history");
          }),
          finalPromise,
        ]);

        let assistantMessage: Record<string, unknown> | undefined;
        await waitForFast(
          async () => {
            const historyRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
              sessionKey: "main",
            });
            expect(historyRes.ok).toBe(true);
            const messages = historyRes.payload?.messages ?? [];
            assistantMessage = messages.find(
              (message): message is Record<string, unknown> =>
                typeof message === "object" &&
                message !== null &&
                (message as { role?: unknown }).role === "assistant",
            );
            if (!assistantMessage) {
              throw new Error("Expected assistant history message");
            }
          },
          { timeout: CHAT_RESPONSE_TIMEOUT_MS },
        );
        const assistantContent = (assistantMessage as { content?: unknown[] }).content ?? [];
        expect(assistantContent).toHaveLength(2);
        expect(assistantContent[0]).toEqual({ type: "text", text: "Image reply" });
        const imageBlock = expectRecordFields(assistantContent[1], {
          type: "image",
          alt: "Generated image 1",
          mimeType: "image/png",
          width: 1,
          height: 1,
        });
        expect(String(imageBlock.url)).toContain("/api/chat/media/outgoing/");
        expect(String(imageBlock.openUrl)).toContain("/full");
        const serializedAssistant = JSON.stringify(assistantMessage);
        expect(serializedAssistant).not.toContain("data:image/png;base64");
        expect(serializedAssistant).not.toContain(pngB64);
      },
      { sessionId: "sess-managed-image-history" },
    );
  });
});
