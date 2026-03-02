import { describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn();
vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

const textToSpeechMock = vi.fn();
vi.mock("../../tts/tts.js", () => ({
  OPENAI_TTS_MODELS: ["gpt-4o-mini-tts"],
  OPENAI_TTS_RESPONSE_FORMATS: ["mp3", "opus", "aac", "flac", "wav", "pcm"],
  OPENAI_TTS_STREAM_FORMATS: ["audio", "sse"],
  OPENAI_TTS_VOICES: ["alloy"],
  getTtsProvider: () => "openai",
  isTtsEnabled: () => true,
  isTtsProviderConfigured: () => true,
  resolveTtsAutoMode: () => "always",
  resolveTtsApiKey: () => "k",
  resolveTtsConfig: () => ({}),
  resolveTtsPrefsPath: () => "/tmp/tts.json",
  resolveTtsProviderOrder: () => ["openai", "edge"],
  setTtsEnabled: vi.fn(),
  setTtsProvider: vi.fn(),
  textToSpeech: (...args: unknown[]) => textToSpeechMock(...args),
}));

const { ttsHandlers } = await import("./tts.js");

describe("tts server methods", () => {
  it("passes OpenAI runtime overrides to textToSpeech", async () => {
    loadConfigMock.mockReturnValue({});
    textToSpeechMock.mockResolvedValueOnce({
      success: true,
      audioPath: "/tmp/out.mp3",
      provider: "openai",
      outputFormat: "mp3",
      voiceCompatible: false,
    });
    const respond = vi.fn();

    await ttsHandlers["tts.convert"]({
      req: { type: "req", id: "1", method: "tts.convert", params: {} },
      params: {
        text: "hello",
        channel: "telegram",
        instructions: "calm",
        stream: true,
        responseFormat: "flac",
        speed: 1.25,
        streamFormat: "audio",
      },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(textToSpeechMock).toHaveBeenCalledWith({
      text: "hello",
      cfg: {},
      channel: "telegram",
      overrides: {
        openai: {
          instructions: "calm",
          stream: true,
          responseFormat: "flac",
          speed: 1.25,
          streamFormat: "audio",
        },
      },
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        audioPath: "/tmp/out.mp3",
        provider: "openai",
      }),
    );
  });

  it("rejects invalid OpenAI runtime responseFormat", async () => {
    loadConfigMock.mockReturnValue({});
    const respond = vi.fn();

    await ttsHandlers["tts.convert"]({
      req: { type: "req", id: "1", method: "tts.convert", params: {} },
      params: { text: "hello", responseFormat: "ogg" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
