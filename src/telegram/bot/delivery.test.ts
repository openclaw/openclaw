import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "grammy";

import { deliverReplies } from "./delivery.js";

const loadWebMedia = vi.fn();

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
}));

describe("deliverReplies", () => {
  beforeEach(() => {
    loadWebMedia.mockReset();
  });

  it("skips audioAsVoice-only payloads without logging an error", async () => {
    const runtime = { error: vi.fn() };
    const bot = { api: {} } as unknown as Bot;

    await deliverReplies({
      replies: [{ audioAsVoice: true }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
    });

    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("invokes onVoiceRecording before sending a voice note", async () => {
    const events: string[] = [];
    const runtime = { error: vi.fn() };
    const sendVoice = vi.fn(async () => {
      events.push("sendVoice");
      return { message_id: 1, chat: { id: "123" } };
    });
    const bot = { api: { sendVoice } } as unknown as Bot;
    const onVoiceRecording = vi.fn(async () => {
      events.push("recordVoice");
    });

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      fileName: "note.ogg",
    });

    await deliverReplies({
      replies: [{ mediaUrl: "https://example.com/note.ogg", audioAsVoice: true }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
      onVoiceRecording,
    });

    expect(onVoiceRecording).toHaveBeenCalledTimes(1);
    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["recordVoice", "sendVoice"]);
  });

  it("renders markdown in media captions", async () => {
    const runtime = { error: vi.fn(), log: vi.fn() };
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 2,
      chat: { id: "123" },
    });
    const bot = { api: { sendPhoto } } as unknown as Bot;

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await deliverReplies({
      replies: [{ mediaUrl: "https://example.com/photo.jpg", text: "hi **boss**" }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
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
});
