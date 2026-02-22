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
  InputMediaBuilder: {
    photo: (media: unknown, options?: Record<string, unknown>) => ({
      type: "photo",
      media,
      ...options,
    }),
    video: (media: unknown, options?: Record<string, unknown>) => ({
      type: "video",
      media,
      ...options,
    }),
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

describe("deliverReplies", () => {
  beforeEach(() => {
    loadWebMedia.mockReset();
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
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 4,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

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
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 4,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

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
    const runtime = createRuntime();
    const sendVoice = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "GrammyError: Call to 'sendVoice' failed! (400: Bad Request: VOICE_MESSAGES_FORBIDDEN)",
        ),
      );
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 5,
      chat: { id: "123" },
    });
    const bot = createBot({ sendVoice, sendMessage });

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
    const runtime = createRuntime();
    const sendVoice = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "GrammyError: Call to 'sendVoice' failed! (400: Bad Request: VOICE_MESSAGES_FORBIDDEN)",
        ),
      );
    const sendMessage = vi.fn();
    const bot = createBot({ sendVoice, sendMessage });

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

  // ── Media group (album) tests ──────────────────────────────────────

  it("sends multiple photos as a media group album", async () => {
    const runtime = createRuntime();
    const sendMediaGroup = vi.fn().mockResolvedValue([
      { message_id: 10, chat: { id: "123" } },
      { message_id: 11, chat: { id: "123" } },
    ]);
    const sendPhoto = vi.fn();
    const bot = createBot({ sendMediaGroup, sendPhoto });

    mockMediaLoad("a.jpg", "image/jpeg", "photo-a");
    mockMediaLoad("b.jpg", "image/jpeg", "photo-b");

    await deliverWith({
      replies: [
        {
          mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
          text: "Album caption",
        },
      ],
      runtime,
      bot,
    });

    expect(sendMediaGroup).toHaveBeenCalledTimes(1);
    // Should NOT fall back to individual sendPhoto calls.
    expect(sendPhoto).not.toHaveBeenCalled();

    const [chatId, media] = sendMediaGroup.mock.calls[0];
    expect(chatId).toBe("123");
    expect(media).toHaveLength(2);
    expect(media[0].type).toBe("photo");
    expect(media[1].type).toBe("photo");
    // Caption only on the first item.
    expect(media[0].caption).toContain("Album caption");
    expect(media[1].caption).toBeUndefined();
  });

  it("sends mixed photos and videos as a media group", async () => {
    const runtime = createRuntime();
    const sendMediaGroup = vi.fn().mockResolvedValue([
      { message_id: 20, chat: { id: "123" } },
      { message_id: 21, chat: { id: "123" } },
    ]);
    const bot = createBot({ sendMediaGroup });

    mockMediaLoad("pic.jpg", "image/jpeg", "photo");
    mockMediaLoad("clip.mp4", "video/mp4", "video");

    await deliverWith({
      replies: [
        {
          mediaUrls: ["https://example.com/pic.jpg", "https://example.com/clip.mp4"],
        },
      ],
      runtime,
      bot,
    });

    expect(sendMediaGroup).toHaveBeenCalledTimes(1);
    const media = sendMediaGroup.mock.calls[0][1];
    expect(media[0].type).toBe("photo");
    expect(media[1].type).toBe("video");
  });

  it("falls back to individual sends when media includes a gif", async () => {
    const runtime = createRuntime();
    const sendMediaGroup = vi.fn();
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 30, chat: { id: "123" } });
    const sendAnimation = vi.fn().mockResolvedValue({ message_id: 31, chat: { id: "123" } });
    const bot = createBot({ sendMediaGroup, sendPhoto, sendAnimation });

    // Media group path loads items until it finds a non-groupable one (gif),
    // then falls through to single-item loop which reloads ALL items.
    mockMediaLoad("pic.jpg", "image/jpeg", "photo"); // consumed by media group check
    mockMediaLoad("anim.gif", "image/gif", "gif"); // consumed by media group check → break
    mockMediaLoad("pic.jpg", "image/jpeg", "photo"); // consumed by single-item loop
    mockMediaLoad("anim.gif", "image/gif", "gif"); // consumed by single-item loop

    await deliverWith({
      replies: [
        {
          mediaUrls: ["https://example.com/pic.jpg", "https://example.com/anim.gif"],
        },
      ],
      runtime,
      bot,
    });

    // Should NOT use media group because of the gif.
    expect(sendMediaGroup).not.toHaveBeenCalled();
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(sendAnimation).toHaveBeenCalledTimes(1);
  });

  it("falls back to individual sends when media includes audio", async () => {
    const runtime = createRuntime();
    const sendMediaGroup = vi.fn();
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 40, chat: { id: "123" } });
    const sendAudio = vi.fn().mockResolvedValue({ message_id: 41, chat: { id: "123" } });
    const bot = createBot({ sendMediaGroup, sendPhoto, sendAudio });

    // Media group path loads first item (photo, groupable), then second (audio, not groupable)
    // → break → falls through to single-item loop which reloads ALL items.
    mockMediaLoad("pic.jpg", "image/jpeg", "photo"); // consumed by media group check
    mockMediaLoad("song.mp3", "audio/mpeg", "audio"); // consumed by media group check → break
    mockMediaLoad("pic.jpg", "image/jpeg", "photo"); // consumed by single-item loop
    mockMediaLoad("song.mp3", "audio/mpeg", "audio"); // consumed by single-item loop

    await deliverWith({
      replies: [
        {
          mediaUrls: ["https://example.com/pic.jpg", "https://example.com/song.mp3"],
        },
      ],
      runtime,
      bot,
    });

    expect(sendMediaGroup).not.toHaveBeenCalled();
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(sendAudio).toHaveBeenCalledTimes(1);
  });

  it("sends single media via sendPhoto (not media group)", async () => {
    const runtime = createRuntime();
    const sendMediaGroup = vi.fn();
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 50, chat: { id: "123" } });
    const bot = createBot({ sendMediaGroup, sendPhoto });

    mockMediaLoad("solo.jpg", "image/jpeg", "photo");

    await deliverWith({
      replies: [{ mediaUrl: "https://example.com/solo.jpg" }],
      runtime,
      bot,
    });

    // Single image should use sendPhoto, not media group.
    expect(sendMediaGroup).not.toHaveBeenCalled();
    expect(sendPhoto).toHaveBeenCalledTimes(1);
  });
});
