import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => Buffer.from("fake-audio-data")),
}));

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  resolveExplicitTtsOverrides: vi.fn(() => ({})),
  canonicalizeSpeechProviderId: vi.fn((id: string) => id || undefined),
  getSpeechProvider: vi.fn(() => ({ id: "openai" })),
  textToSpeech: vi.fn(async () => ({
    success: true,
    audioPath: "/tmp/tts.mp3",
    provider: "openai",
    outputFormat: "mp3",
    voiceCompatible: false,
    latencyMs: 120,
  })),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig:
    mocks.getRuntimeConfig as typeof import("../../config/config.js").getRuntimeConfig,
}));

vi.mock("../../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: mocks.canonicalizeSpeechProviderId,
  getSpeechProvider: mocks.getSpeechProvider,
  listSpeechProviders: vi.fn(() => []),
}));

vi.mock("../../tts/tts.js", () => ({
  getResolvedSpeechProviderConfig: vi.fn(),
  getTtsPersona: vi.fn(() => undefined),
  getTtsProvider: vi.fn(() => "openai"),
  getTtsVoiceByProvider: vi.fn(() => ({ openai: "alloy" })),
  isTtsEnabled: vi.fn(() => true),
  isTtsProviderConfigured: vi.fn(() => true),
  listTtsPersonas: vi.fn(() => []),
  resolveExplicitTtsOverrides:
    mocks.resolveExplicitTtsOverrides as typeof import("../../tts/tts.js").resolveExplicitTtsOverrides,
  resolveTtsAutoMode: vi.fn(() => false),
  resolveTtsConfig: vi.fn(() => ({})),
  resolveTtsPrefsPath: vi.fn(() => "/tmp/tts.json"),
  resolveTtsProviderOrder: vi.fn(() => ["openai"]),
  setTtsEnabled: vi.fn(),
  setTtsPersona: vi.fn(),
  setTtsProvider: vi.fn(),
  setTtsVoice: vi.fn(),
  textToSpeech: mocks.textToSpeech as typeof import("../../tts/tts.js").textToSpeech,
}));

describe("ttsHandlers", () => {
  beforeEach(() => {
    mocks.getRuntimeConfig.mockReset();
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.resolveExplicitTtsOverrides.mockReset();
    mocks.resolveExplicitTtsOverrides.mockReturnValue({});
    mocks.canonicalizeSpeechProviderId.mockReset();
    mocks.canonicalizeSpeechProviderId.mockImplementation((id: string) => id || undefined);
    mocks.getSpeechProvider.mockReset();
    mocks.getSpeechProvider.mockReturnValue({ id: "openai" });
    mocks.textToSpeech.mockReset();
    mocks.textToSpeech.mockResolvedValue({
      success: true,
      audioPath: "/tmp/tts.mp3",
      provider: "openai",
      outputFormat: "mp3",
      voiceCompatible: false,
      latencyMs: 120,
    });
  });

  it("returns INVALID_REQUEST when TTS override validation fails", async () => {
    mocks.resolveExplicitTtsOverrides.mockImplementation(() => {
      throw new Error('Unknown TTS provider "bad".');
    });

    const { ttsHandlers } = await import("./tts.js");
    const respond = vi.fn();

    await ttsHandlers["tts.convert"]({
      params: {
        text: "hello",
        provider: "bad",
      },
      respond,
      context: { getRuntimeConfig: mocks.getRuntimeConfig },
    } as never);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Error: Unknown TTS provider "bad".',
      }),
    );
    expect(mocks.textToSpeech).not.toHaveBeenCalled();
  });

  describe("tts.status", () => {
    it("includes voiceByProvider in the response", async () => {
      const { ttsHandlers } = await import("./tts.js");
      const respond = vi.fn();

      await ttsHandlers["tts.status"]({
        params: {},
        respond,
        context: { getRuntimeConfig: mocks.getRuntimeConfig },
      } as never);

      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ voiceByProvider: { openai: "alloy" } }),
      );
    });
  });

  describe("tts.setVoice", () => {
    it("returns INVALID_REQUEST when provider is missing or unregistered", async () => {
      mocks.canonicalizeSpeechProviderId.mockReturnValue(undefined as unknown as string);
      mocks.getSpeechProvider.mockReturnValue(undefined as unknown as { id: string });

      const { ttsHandlers } = await import("./tts.js");
      const respond = vi.fn();

      await ttsHandlers["tts.setVoice"]({
        params: { provider: "bad" },
        respond,
        context: { getRuntimeConfig: mocks.getRuntimeConfig },
      } as never);

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST }),
      );
    });

    it("saves voice and responds success for a valid provider", async () => {
      const { ttsHandlers } = await import("./tts.js");
      const respond = vi.fn();

      await ttsHandlers["tts.setVoice"]({
        params: { provider: "openai", voice: "alloy" },
        respond,
        context: { getRuntimeConfig: mocks.getRuntimeConfig },
      } as never);

      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ provider: "openai", voice: "alloy" }),
      );
    });

    it("clears voice when voice param is absent", async () => {
      const { ttsHandlers } = await import("./tts.js");
      const respond = vi.fn();

      await ttsHandlers["tts.setVoice"]({
        params: { provider: "openai" },
        respond,
        context: { getRuntimeConfig: mocks.getRuntimeConfig },
      } as never);

      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ provider: "openai", voice: null }),
      );
    });
  });

  describe("tts.preview", () => {
    it("returns INVALID_REQUEST when override resolution fails", async () => {
      mocks.resolveExplicitTtsOverrides.mockImplementation(() => {
        throw new Error('Unknown TTS provider "bad".');
      });

      const { ttsHandlers } = await import("./tts.js");
      const respond = vi.fn();

      await ttsHandlers["tts.preview"]({
        params: { provider: "bad", text: "hello" },
        respond,
        context: { getRuntimeConfig: mocks.getRuntimeConfig },
      } as never);

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST }),
      );
      expect(mocks.textToSpeech).not.toHaveBeenCalled();
    });

    it("returns audioDataUrl on successful synthesis", async () => {
      const { ttsHandlers } = await import("./tts.js");
      const respond = vi.fn();

      await ttsHandlers["tts.preview"]({
        params: {},
        respond,
        context: { getRuntimeConfig: mocks.getRuntimeConfig },
      } as never);

      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          audioDataUrl: expect.stringContaining("data:audio/mpeg;base64,"),
          provider: "openai",
        }),
      );
    });

    it("passes disableFallback when explicit provider is given", async () => {
      const { ttsHandlers } = await import("./tts.js");
      const respond = vi.fn();

      await ttsHandlers["tts.preview"]({
        params: { provider: "openai" },
        respond,
        context: { getRuntimeConfig: mocks.getRuntimeConfig },
      } as never);

      expect(mocks.textToSpeech).toHaveBeenCalledWith(
        expect.objectContaining({ disableFallback: true }),
      );
    });

    it("returns UNAVAILABLE when synthesis fails", async () => {
      mocks.textToSpeech.mockResolvedValue({
        success: false,
        audioPath: undefined,
        error: "provider timeout",
      } as never);

      const { ttsHandlers } = await import("./tts.js");
      const respond = vi.fn();

      await ttsHandlers["tts.preview"]({
        params: {},
        respond,
        context: { getRuntimeConfig: mocks.getRuntimeConfig },
      } as never);

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: ErrorCodes.UNAVAILABLE }),
      );
    });
  });
});
