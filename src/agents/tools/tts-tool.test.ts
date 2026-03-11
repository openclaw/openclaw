import { describe, expect, it, vi } from "vitest";

vi.mock("../../auto-reply/tokens.js", () => ({
  SILENT_REPLY_TOKEN: "QUIET_TOKEN",
}));

const textToSpeechMock = vi.hoisted(() => vi.fn());
vi.mock("../../tts/tts.js", () => ({
  textToSpeech: textToSpeechMock,
}));

const { createTtsTool } = await import("./tts-tool.js");

describe("createTtsTool", () => {
  it("uses SILENT_REPLY_TOKEN in guidance text", () => {
    const tool = createTtsTool();

    expect(tool.description).toContain("QUIET_TOKEN");
    expect(tool.description).not.toContain("NO_REPLY");
  });

  it("returns metadata only in deliveryMode=return", async () => {
    textToSpeechMock.mockResolvedValueOnce({
      success: true,
      audioPath: "/tmp/openclaw/tts-test/voice.mp3",
      provider: "openai",
      voiceCompatible: false,
    });
    const tool = createTtsTool();

    const result = await tool.execute("call-1", {
      text: "hello",
      deliveryMode: "return",
    });

    expect(result.content[0]?.type).toBe("text");
    expect((result.content[0] as { text: string }).text).not.toContain("MEDIA:");
    expect(result.details).toMatchObject({
      ok: true,
      deliveryMode: "return",
      audioPath: "/tmp/openclaw/tts-test/voice.mp3",
      mimeType: "audio/mpeg",
      sent: false,
    });
  });

  it("uses audio/ogg mimeType for voice-compatible return output", async () => {
    textToSpeechMock.mockResolvedValueOnce({
      success: true,
      audioPath: "/tmp/openclaw/tts-test/voice.opus",
      provider: "openai",
      voiceCompatible: true,
    });
    const tool = createTtsTool();

    const result = await tool.execute("call-voice", {
      text: "hello",
      channel: "telegram",
      deliveryMode: "return",
    });

    expect(result.details).toMatchObject({
      ok: true,
      deliveryMode: "return",
      mimeType: "audio/ogg",
    });
  });

  it("includes ok=true in send mode success details", async () => {
    textToSpeechMock.mockResolvedValueOnce({
      success: true,
      audioPath: "/tmp/openclaw/tts-test/voice.mp3",
      provider: "openai",
      voiceCompatible: false,
    });
    const tool = createTtsTool();

    const result = await tool.execute("call-send", {
      text: "hello",
      deliveryMode: "send",
    });

    expect(result.details).toMatchObject({ ok: true, deliveryMode: "send" });
  });

  it("returns validation error for invalid deliveryMode", async () => {
    const tool = createTtsTool();
    const result = await tool.execute("call-2", {
      text: "hello",
      deliveryMode: "invalid-mode",
    });

    expect((result.details as { error?: { code?: string } }).error?.code).toBe("VALIDATION_ERROR");
    expect((result.content[0] as { text: string }).text).toContain("deliveryMode must be one of");
  });
});
