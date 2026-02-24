import type { Bot } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import { deliverReplies } from "./delivery.js";

const loadWebMedia = vi.fn();
const baseDeliveryParams = {
  chatId: "123",
  token: "tok",
  replyToMode: "off",
  textLimit: 4000,
} as const;
type DeliverRepliesParams = Parameters<typeof deliverReplies>[0];
type DeliverWithParams = Omit<
  DeliverRepliesParams,
  "chatId" | "token" | "replyToMode" | "textLimit"
> &
  Partial<Pick<DeliverRepliesParams, "replyToMode" | "textLimit">>;
type RuntimeStub = Pick<RuntimeEnv, "error" | "log" | "exit">;

vi.mock("../../web/media.js", () => ({
  loadWebMedia: (...args: unknown[]) => loadWebMedia(...args),
}));

vi.mock("grammy", () => ({
  InputFile: class {
    constructor(
      public buffer: Buffer,
      public fileName?: string,
    ) {}
  },
  GrammyError: class GrammyError extends Error {
    description = "";
  },
}));

function createRuntime(withLog = true): RuntimeStub {
  return {
    error: vi.fn(),
    log: withLog ? vi.fn() : vi.fn(),
    exit: vi.fn(),
  };
}

function createBot(api: Record<string, unknown> = {}): Bot {
  return { api } as unknown as Bot;
}

async function deliverWith(params: DeliverWithParams) {
  await deliverReplies({
    ...baseDeliveryParams,
    ...params,
  });
}

function mockMediaLoad(fileName: string, contentType: string, data: string) {
  loadWebMedia.mockResolvedValueOnce({
    buffer: Buffer.from(data),
    contentType,
    fileName,
  });
}

function createSendMessageHarness(messageId = 4) {
  const runtime = createRuntime();
  const sendMessage = vi.fn().mockResolvedValue({
    message_id: messageId,
    chat: { id: "123" },
  });
  const bot = createBot({ sendMessage });
  return { runtime, sendMessage, bot };
}

function createVoiceMessagesForbiddenError() {
  return new Error(
    "GrammyError: Call to 'sendVoice' failed! (400: Bad Request: VOICE_MESSAGES_FORBIDDEN)",
  );
}

function createVoiceFailureHarness(params: {
  voiceError: Error;
  sendMessageResult?: { message_id: number; chat: { id: string } };
}) {
  const runtime = createRuntime();
  const sendVoice = vi.fn().mockRejectedValue(params.voiceError);
  const sendMessage = params.sendMessageResult
    ? vi.fn().mockResolvedValue(params.sendMessageResult)
    : vi.fn();
  const bot = createBot({ sendVoice, sendMessage });
  return { runtime, sendVoice, sendMessage, bot };
}

describe("deliverReplies", () => {
  beforeEach(() => {
    loadWebMedia.mockClear();
  });

  it("skips audioAsVoice-only payloads without logging an error", async () => {
    const runtime = createRuntime(false);

    await deliverWith({
      replies: [{ audioAsVoice: true }],
      runtime,
      bot: createBot(),
    });

    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("invokes onVoiceRecording before sending a voice note", async () => {
    const events: string[] = [];
    const runtime = createRuntime(false);
    const sendVoice = vi.fn(async () => {
      events.push("sendVoice");
      return { message_id: 1, chat: { id: "123" } };
    });
    const bot = createBot({ sendVoice });
    const onVoiceRecording = vi.fn(async () => {
      events.push("recordVoice");
    });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await deliverWith({
      replies: [{ mediaUrl: "https://example.com/note.ogg", audioAsVoice: true }],
      runtime,
      bot,
      onVoiceRecording,
    });

    expect(onVoiceRecording).toHaveBeenCalledTimes(1);
    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["recordVoice", "sendVoice"]);
  });

  it("renders markdown in media captions", async () => {
    const runtime = createRuntime();
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 2,
      chat: { id: "123" },
    });
    const bot = createBot({ sendPhoto });

    mockMediaLoad("photo.jpg", "image/jpeg", "image");

    await deliverWith({
      replies: [{ mediaUrl: "https://example.com/photo.jpg", text: "hi **boss**" }],
      runtime,
      bot,
    });

    expect(sendPhoto).toHaveBeenCalledWith(
      "123",
      expect.anything(),
      expect.objectContaining({
        caption: "hi <b>boss</b>",
        parse_mode: "HTML",
      }),
    );
  });

  it("passes mediaLocalRoots to media loading", async () => {
    const runtime = createRuntime();
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 12,
      chat: { id: "123" },
    });
    const bot = createBot({ sendPhoto });
    const mediaLocalRoots = ["/tmp/workspace-work"];

    mockMediaLoad("photo.jpg", "image/jpeg", "image");

    await deliverWith({
      replies: [{ mediaUrl: "/tmp/workspace-work/photo.jpg" }],
      runtime,
      bot,
      mediaLocalRoots,
    });

    expect(loadWebMedia).toHaveBeenCalledWith("/tmp/workspace-work/photo.jpg", {
      localRoots: mediaLocalRoots,
    });
  });

  it("includes link_preview_options when linkPreview is false", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 3,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [{ text: "Check https://example.com" }],
      runtime,
      bot,
      linkPreview: false,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.objectContaining({
        link_preview_options: { is_disabled: true },
      }),
    );
  });

  it("includes message_thread_id for DM topics", async () => {
    const { runtime, sendMessage, bot } = createSendMessageHarness();

    await deliverWith({
      replies: [{ text: "Hello" }],
      runtime,
      bot,
      thread: { id: 42, scope: "dm" },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.objectContaining({
        message_thread_id: 42,
      }),
    );
  });

  it("does not include link_preview_options when linkPreview is true", async () => {
    const { runtime, sendMessage, bot } = createSendMessageHarness();

    await deliverWith({
      replies: [{ text: "Check https://example.com" }],
      runtime,
      bot,
      linkPreview: true,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.not.objectContaining({
        link_preview_options: expect.anything(),
      }),
    );
  });

  it("falls back to plain text when markdown renders to empty HTML in threaded mode", async () => {
    const runtime = { error: vi.fn(), log: vi.fn() };
    const sendMessage = vi.fn(async (_chatId: string, text: string) => {
      if (text === "") {
        throw new Error("400: Bad Request: message text is empty");
      }
      return {
        message_id: 6,
        chat: { id: "123" },
      };
    });
    const bot = { api: { sendMessage } } as unknown as Bot;

    await deliverReplies({
      replies: [{ text: ">" }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
      thread: { id: 42, scope: "forum" },
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      ">",
      expect.objectContaining({
        message_thread_id: 42,
      }),
    );
  });

  it("throws when formatted and plain fallback text are both empty", async () => {
    const runtime = { error: vi.fn(), log: vi.fn() };
    const sendMessage = vi.fn();
    const bot = { api: { sendMessage } } as unknown as Bot;

    await expect(
      deliverReplies({
        replies: [{ text: "   " }],
        chatId: "123",
        token: "tok",
        runtime,
        bot,
        replyToMode: "off",
        textLimit: 4000,
      }),
    ).rejects.toThrow("empty formatted text and empty plain fallback");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("uses reply_to_message_id when quote text is provided", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 10,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [{ text: "Hello there", replyToId: "500" }],
      runtime,
      bot,
      replyToMode: "all",
      replyQuoteText: "quoted text",
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.objectContaining({
        reply_to_message_id: 500,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.not.objectContaining({
        reply_parameters: expect.anything(),
      }),
    );
  });

  it("falls back to text when sendVoice fails with VOICE_MESSAGES_FORBIDDEN", async () => {
    const { runtime, sendVoice, sendMessage, bot } = createVoiceFailureHarness({
      voiceError: createVoiceMessagesForbiddenError(),
      sendMessageResult: {
        message_id: 5,
        chat: { id: "123" },
      },
    });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await deliverWith({
      replies: [
        { mediaUrl: "https://example.com/note.ogg", text: "Hello there", audioAsVoice: true },
      ],
      runtime,
      bot,
    });

    // Voice was attempted but failed
    expect(sendVoice).toHaveBeenCalledTimes(1);
    // Fallback to text succeeded
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Hello there"),
      expect.any(Object),
    );
  });

  it("rethrows non-VOICE_MESSAGES_FORBIDDEN errors from sendVoice", async () => {
    const runtime = createRuntime();
    const sendVoice = vi.fn().mockRejectedValue(new Error("Network error"));
    const sendMessage = vi.fn();
    const bot = createBot({ sendVoice, sendMessage });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await expect(
      deliverWith({
        replies: [{ mediaUrl: "https://example.com/note.ogg", text: "Hello", audioAsVoice: true }],
        runtime,
        bot,
      }),
    ).rejects.toThrow("Network error");

    expect(sendVoice).toHaveBeenCalledTimes(1);
    // Text fallback should NOT be attempted for other errors
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rethrows VOICE_MESSAGES_FORBIDDEN when no text fallback is available", async () => {
    const { runtime, sendVoice, sendMessage, bot } = createVoiceFailureHarness({
      voiceError: createVoiceMessagesForbiddenError(),
    });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await expect(
      deliverWith({
        replies: [{ mediaUrl: "https://example.com/note.ogg", audioAsVoice: true }],
        runtime,
        bot,
      }),
    ).rejects.toThrow("VOICE_MESSAGES_FORBIDDEN");

    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
