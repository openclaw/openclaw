import { beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";

let textToSpeechSpy: ReturnType<typeof vi.spyOn>;

describe("createTtsTool", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    const ttsRuntime = await import("../../tts/tts.js");
    textToSpeechSpy = vi.spyOn(ttsRuntime, "textToSpeech");
  });

  it("uses SILENT_REPLY_TOKEN in guidance text", async () => {
    const { createTtsTool } = await import("./tts-tool.js");
    const tool = createTtsTool();

    expect(tool.description).toContain(SILENT_REPLY_TOKEN);
  });

  it("stores audio delivery in details.media", async () => {
    textToSpeechSpy.mockResolvedValue({
      success: true,
      audioPath: "/tmp/reply.opus",
      provider: "test",
      voiceCompatible: true,
    });

    const { createTtsTool } = await import("./tts-tool.js");
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
