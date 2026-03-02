import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../auto-reply/tokens.js", () => ({
  SILENT_REPLY_TOKEN: "QUIET_TOKEN",
}));

const textToSpeechMock = vi.fn();
vi.mock("../../tts/tts.js", () => ({
  textToSpeech: (...args: unknown[]) => textToSpeechMock(...args),
}));

const { createTtsTool } = await import("./tts-tool.js");

describe("createTtsTool", () => {
  const cfg: OpenClawConfig = {
    agents: { defaults: { model: { primary: "openai/gpt-5.2" } } },
  };

  beforeEach(() => {
    textToSpeechMock.mockReset();
  });

  it("uses SILENT_REPLY_TOKEN in guidance text", () => {
    const tool = createTtsTool();

    expect(tool.description).toContain("QUIET_TOKEN");
    expect(tool.description).not.toContain("NO_REPLY");
  });

  it("passes OpenAI runtime overrides through to textToSpeech", async () => {
    textToSpeechMock.mockResolvedValueOnce({
      success: true,
      audioPath: "/tmp/audio.mp3",
      provider: "openai",
      voiceCompatible: false,
    });
    const tool = createTtsTool({ config: cfg, agentChannel: "telegram" });

    await tool.execute?.("call-1", {
      text: "hello",
      instructions: "calm",
      stream: true,
    });

    expect(textToSpeechMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hello",
        channel: "telegram",
        overrides: { openai: { instructions: "calm", stream: true } },
      }),
    );
  });
});
