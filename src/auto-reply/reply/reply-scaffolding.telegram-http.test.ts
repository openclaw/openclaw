import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sendMessageTelegram } from "../../../extensions/telegram/runtime-api.js";
import type { ReplyPayload } from "../types.js";
import {
  bindReplyDispatcherConversationContext,
  createReplyDispatcher,
} from "./reply-dispatcher.js";

function readTelegramApiField(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" ? String(value) : "";
}

describe("reply scaffolding at the real Telegram HTTP delivery boundary", () => {
  let server: Server;
  let apiRoot: string;
  const sockets = new Set<Socket>();
  const requests: Array<{ path: string; text: string; chatId: string }> = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        const fields = request.headers["content-type"]?.includes("application/json")
          ? (JSON.parse(body) as Record<string, unknown>)
          : Object.fromEntries(new URLSearchParams(body));
        const path = request.url ?? "";
        if (path.endsWith("/sendMessage")) {
          requests.push({
            path,
            text: readTelegramApiField(fields.text),
            chatId: readTelegramApiField(fields.chat_id),
          });
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              ok: true,
              result: {
                message_id: requests.length,
                date: 1_700_000_000,
                chat: { id: 123, type: "private" },
                text: readTelegramApiField(fields.text),
              },
            }),
          );
          return;
        }
        if (path.endsWith("/getChat")) {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ ok: true, result: { id: 123, type: "private" } }));
          return;
        }
        response.statusCode = 404;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: false, description: "Unexpected Telegram API call" }));
      });
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    requests.length = 0;
  });

  afterAll(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  async function dispatchFinal(payload: ReplyPayload, conversationContext?: string) {
    const errors: unknown[] = [];
    const skips: string[] = [];
    const media: ReplyPayload[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (normalized) => {
        if (normalized.mediaUrl || normalized.mediaUrls?.length || normalized.channelData) {
          media.push(normalized);
          return;
        }
        await sendMessageTelegram("123", normalized.text ?? "", {
          cfg: {
            channels: {
              telegram: {
                botToken: "123456:e2e-scaffolding-token",
                apiRoot,
              },
            },
          },
        });
      },
      onError: (error) => {
        errors.push(error);
      },
      onSkip: (_payload, info) => {
        skips.push(info.reason);
      },
    });
    if (conversationContext) {
      bindReplyDispatcherConversationContext(dispatcher, conversationContext);
    }
    const queued = dispatcher.sendFinalReply(payload);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(errors).toEqual([]);
    return { queued, skips, media };
  }

  it("sends the real assistant answer without leaked current-message context", async () => {
    const conversationContext = [
      "Current message priority: high",
      "[Current message - respond to this]",
      "[Telegram 2026-05-05T20:20:00Z] Danny: ping",
    ].join("\n");
    const text = `${conversationContext}\n\nPong.`;

    expect(await dispatchFinal({ text }, conversationContext)).toMatchObject({
      queued: true,
      skips: [],
    });
    expect(requests).toEqual([
      {
        path: "/bot123456:e2e-scaffolding-token/sendMessage",
        text: "Pong.",
        chatId: "123",
      },
    ]);
  });

  it("never makes a Telegram HTTP request for an empty internal exec placeholder", async () => {
    expect(await dispatchFinal({ text: "  (no output)\r\n" })).toMatchObject({
      queued: false,
      skips: ["empty"],
    });
    expect(requests).toEqual([]);
  });

  it("removes the complete verified multiline context before real Telegram delivery", async () => {
    const conversationContext = [
      "Current message priority: high",
      "[Current message - respond to this]",
      "[Telegram 2026-05-05T20:20:00Z] Danny: first message paragraph",
      "",
      "second message paragraph",
      "",
      "```text",
      "private fenced inbound context",
      "```",
    ].join("\n");
    const visibleReply = "First answer paragraph.\n\nSecond answer paragraph.";

    expect(
      await dispatchFinal(
        { text: `${conversationContext}\n\n${visibleReply}` },
        conversationContext,
      ),
    ).toMatchObject({ queued: true, skips: [] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.text).toBe(visibleReply);
    expect(requests[0]?.text).not.toContain("second message paragraph");
    expect(requests[0]?.text).not.toContain("private fenced inbound context");
  });

  it("never sends a CRLF inbound paragraph normalized to LF by the model", async () => {
    const echoedLfContext = [
      "[Current message - respond to this]",
      "[Telegram] first inbound paragraph",
      "",
      "private second inbound paragraph",
    ].join("\n");
    const sourceCrlfContext = echoedLfContext.replace(/\n/gu, "\r\n");
    const visibleReply = "First answer paragraph.\n\nSecond answer paragraph.";

    expect(
      await dispatchFinal({ text: `${echoedLfContext}\n\n${visibleReply}` }, sourceCrlfContext),
    ).toMatchObject({ queued: true, skips: [] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.text).toBe(visibleReply);
    expect(requests[0]?.text).not.toContain("private second inbound paragraph");
  });

  it("never delivers a repeated verified inbound context", async () => {
    const conversationContext = [
      "[Current message - respond to this]",
      "[Telegram] first inbound paragraph",
      "",
      "private second inbound paragraph",
    ].join("\n");

    expect(
      await dispatchFinal(
        { text: `${conversationContext}\n\n${conversationContext}\n\nVisible answer.` },
        conversationContext,
      ),
    ).toMatchObject({ queued: true, skips: [] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.text).toBe("Visible answer.");
    expect(requests[0]?.text).not.toContain("private second inbound paragraph");
  });

  it("removes verified inbound XML before real Telegram rendering mutates it", async () => {
    const conversationContext = [
      "[Current message - respond to this]",
      "[Telegram] explain this tool call",
      '<function_calls><invoke name="exec">private inbound XML</invoke></function_calls>',
      "",
      "private second inbound paragraph",
    ].join("\n");

    expect(
      await dispatchFinal(
        { text: `${conversationContext}\n\nVisible answer.` },
        conversationContext,
      ),
    ).toMatchObject({ queued: true, skips: [] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.text).toBe("Visible answer.");
    expect(requests[0]?.text).not.toContain("private inbound XML");
    expect(requests[0]?.text).not.toContain("private second inbound paragraph");
  });

  it("delivers literal, quoted, and fenced user-visible placeholder examples", async () => {
    const examples = [
      "The literal (no output) text is intentional.",
      "> (no output)\n\nThat is the original command output.",
      "```text\n[Current message - respond to this]\n(no output)\n```",
    ];

    for (const text of examples) {
      expect(await dispatchFinal({ text })).toMatchObject({ queued: true, skips: [] });
    }

    expect(requests).toHaveLength(examples.length);
    for (const request of requests) {
      expect(request.chatId).toBe("123");
      expect(request.text).toContain("(no output)");
    }
    expect(requests[2]?.text).toContain("[Current message - respond to this]");
  });

  it("keeps media and native channel content when placeholder-only text is removed", async () => {
    const payload: ReplyPayload = {
      text: "(no output)",
      mediaUrl: "https://example.com/photo.jpg",
      channelData: { line: { flexMessage: { type: "bubble" } } },
    };

    expect(await dispatchFinal(payload)).toMatchObject({
      queued: true,
      skips: [],
      media: [
        {
          text: "",
          mediaUrl: payload.mediaUrl,
          channelData: payload.channelData,
        },
      ],
    });
    expect(requests).toEqual([]);
  });
});
