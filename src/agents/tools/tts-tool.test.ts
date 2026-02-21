import { describe, expect, it, vi } from "vitest";

vi.mock("../../auto-reply/tokens.js", () => ({
  SILENT_REPLY_TOKEN: "QUIET_TOKEN",
}));

vi.mock("../../tts/tts.js", () => ({
  textToSpeech: vi.fn(),
}));

const { createTtsTool } = await import("./tts-tool.js");
const { textToSpeech } = await import("../../tts/tts.js");

describe("createTtsTool", () => {
  it("uses SILENT_REPLY_TOKEN in guidance text", () => {
    const tool = createTtsTool();

    expect(tool.description).toContain("QUIET_TOKEN");
    expect(tool.description).toContain('delivery="path"');
    expect(tool.description).not.toContain("NO_REPLY");
  });

  it("emits MEDIA output by default", async () => {
    vi.mocked(textToSpeech).mockResolvedValueOnce({
      success: true,
      audioPath: "/tmp/voice.ogg",
      provider: "edge",
      voiceCompatible: true,
    });

    const tool = createTtsTool({ config: {} as never });
    const result = await tool.execute("tool-1", { text: "hello" });
    const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("[[audio_as_voice]]");
    expect(text).toContain("MEDIA:/tmp/voice.ogg");
  });

  it("returns AUDIO_PATH in delivery=path mode to avoid duplicate auto-sends", async () => {
    vi.mocked(textToSpeech).mockResolvedValueOnce({
      success: true,
      audioPath: "/tmp/voice.ogg",
      provider: "edge",
      voiceCompatible: true,
    });

    const tool = createTtsTool({ config: {} as never });
    const result = await tool.execute("tool-2", { text: "hello", delivery: "path" });
    const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toBe("AUDIO_PATH:/tmp/voice.ogg");
    expect(text).not.toContain("MEDIA:");
    expect(text).not.toContain("[[audio_as_voice]]");
  });
});
