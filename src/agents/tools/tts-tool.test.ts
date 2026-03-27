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
    expect(tool.description).not.toContain("NO_REPLY");
  });

  it("stores audio delivery in details.media", async () => {
    vi.mocked(textToSpeech).mockResolvedValue({
      success: true,
      audioPath: "/tmp/reply.opus",
      provider: "test",
      voiceCompatible: true,
    });

    const tool = createTtsTool();
    const result = await tool.execute("call-1", { text: "hello" });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "Generated audio reply." }],
      details: {
        audioPath: "/tmp/reply.opus",
        provider: "test",
        media: {
          mediaUrl: "/tmp/reply.opus",
          audioAsVoice: true,
        },
      },
    });
    expect(JSON.stringify(result.content)).not.toContain("MEDIA:");
  });
});
