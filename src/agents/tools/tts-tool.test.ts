import { describe, expect, it, vi } from "vitest";

vi.mock("../../auto-reply/tokens.js", () => ({
  SILENT_REPLY_TOKEN: "QUIET_TOKEN",
}));

const { createTtsTool } = await import("./tts-tool.js");
const ttsModule = await import("../../tts/tts.js");

describe("createTtsTool", () => {
  it("uses SILENT_REPLY_TOKEN in guidance text", () => {
    const tool = createTtsTool();

    expect(tool.description).toContain("QUIET_TOKEN");
    expect(tool.description).not.toContain("NO_REPLY");
  });

  it("returns a media artifact for generated audio", async () => {
    vi.spyOn(ttsModule, "textToSpeech").mockResolvedValue({
      success: true,
      audioPath: "/tmp/voice.opus",
      provider: "openai",
      voiceCompatible: true,
    });

    const tool = createTtsTool();
    const result = await tool.execute("call-1", { text: "hello" });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "Generated speech audio." }],
      details: {
        audioPath: "/tmp/voice.opus",
        provider: "openai",
        media: {
          mediaUrl: "/tmp/voice.opus",
          audioAsVoice: true,
        },
      },
    });
  });
});
