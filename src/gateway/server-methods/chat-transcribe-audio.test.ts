import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { MAX_PAYLOAD_BYTES } from "../server-constants.js";

const mocks = vi.hoisted(() => ({
  transcribeAudioFile: vi.fn(async () => ({
    text: "hello from audio",
    provider: "openai",
    model: "gpt-4o-transcribe",
  })),
}));

vi.mock("../../media-understanding/runtime.js", () => ({
  transcribeAudioFile:
    mocks.transcribeAudioFile as typeof import("../../media-understanding/runtime.js").transcribeAudioFile,
}));

describe("chatTranscribeAudioHandlers", () => {
  beforeEach(() => {
    mocks.transcribeAudioFile.mockReset();
    mocks.transcribeAudioFile.mockResolvedValue({
      text: "hello from audio",
      provider: "openai",
      model: "gpt-4o-transcribe",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the decoded audio cap below the base64 WebSocket frame limit", async () => {
    const { MAX_CHAT_TRANSCRIBE_AUDIO_BYTES } = await import("./chat-transcribe-audio.js");
    const base64Bytes = Math.ceil(MAX_CHAT_TRANSCRIBE_AUDIO_BYTES / 3) * 4;

    expect(base64Bytes + 64 * 1024).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(MAX_CHAT_TRANSCRIBE_AUDIO_BYTES).toBeLessThan(20 * 1024 * 1024);
  });

  it("transcribes uploaded chat dictation audio through media understanding", async () => {
    const { chatTranscribeAudioHandlers } = await import("./chat-transcribe-audio.js");
    const respond = vi.fn();

    await chatTranscribeAudioHandlers["chat.transcribeAudio"]({
      params: {
        audioDataUrl: `data:audio/webm;base64,${Buffer.from("audio").toString("base64")}`,
      },
      respond,
      context: { getRuntimeConfig: () => ({ tools: { media: {} } }) },
    } as never);

    expect(mocks.transcribeAudioFile).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: { tools: { media: {} } },
        mime: "audio/webm",
      }),
    );
    const call = (mocks.transcribeAudioFile.mock.calls as unknown as Array<[{ filePath?: string }]>)
      .at(0)
      ?.at(0);
    const filePath = call?.filePath;
    expect(filePath).toMatch(/dictation\.webm$/);
    await expect(fs.stat(filePath ?? "")).rejects.toMatchObject({ code: "ENOENT" });
    expect(respond).toHaveBeenCalledWith(true, {
      text: "hello from audio",
      provider: "openai",
      model: "gpt-4o-transcribe",
    });
  });

  it("returns INVALID_REQUEST for missing audio payloads", async () => {
    const { chatTranscribeAudioHandlers } = await import("./chat-transcribe-audio.js");
    const respond = vi.fn();

    await chatTranscribeAudioHandlers["chat.transcribeAudio"]({
      params: {},
      respond,
      context: { getRuntimeConfig: () => ({}) },
    } as never);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("requires audioDataUrl or audioBase64"),
      }),
    );
    expect(mocks.transcribeAudioFile).not.toHaveBeenCalled();
  });

  it("returns UNAVAILABLE when no transcription provider is configured", async () => {
    mocks.transcribeAudioFile.mockResolvedValue({
      text: undefined,
      decision: {
        capability: "audio",
        outcome: "skipped",
        attachments: [{ attempts: [] }],
      },
    } as never);
    const { chatTranscribeAudioHandlers } = await import("./chat-transcribe-audio.js");
    const respond = vi.fn();

    await chatTranscribeAudioHandlers["chat.transcribeAudio"]({
      params: {
        audioBase64: Buffer.from("audio").toString("base64"),
        mimeType: "audio/ogg",
      },
      respond,
      context: { getRuntimeConfig: () => ({}) },
    } as never);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message: expect.stringContaining("No audio transcription provider"),
      }),
    );
  });
});
