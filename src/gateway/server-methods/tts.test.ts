/**
 * Tests for text-to-speech gateway methods and provider error envelopes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { SpeechProviderPlugin } from "../../plugins/types.js";
import { expectGatewayErrorResponse } from "./gateway-response.test-helpers.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  getResolvedSpeechProviderConfig: vi.fn((_config: unknown, provider: string) => ({
    id: provider,
  })),
  getTtsPersona: vi.fn(() => undefined),
  getTtsProvider: vi.fn(() => "openai"),
  isTtsEnabled: vi.fn(() => true),
  listSpeechProviders: vi.fn<() => SpeechProviderPlugin[]>(() => []),
  listTtsPersonas: vi.fn(() => []),
  resolveExplicitTtsOverrides: vi.fn(() => ({})),
  resolveTtsAutoMode: vi.fn(() => false),
  resolveTtsConfig: vi.fn(() => ({})),
  resolveTtsPrefsPath: vi.fn(() => "/tmp/tts.json"),
  resolveTtsProviderOrder: vi.fn(() => ["openai"]),
  textToSpeech: vi.fn(async () => ({
    success: true,
    audioPath: "/tmp/tts.mp3",
    provider: "openai",
    outputFormat: "mp3",
    voiceCompatible: false,
  })),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig:
    mocks.getRuntimeConfig as typeof import("../../config/config.js").getRuntimeConfig,
}));

vi.mock("../../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: vi.fn(),
  getSpeechProvider: vi.fn(),
  listSpeechProviders: mocks.listSpeechProviders,
}));

vi.mock("../../tts/tts.js", () => ({
  getResolvedSpeechProviderConfig: mocks.getResolvedSpeechProviderConfig,
  getTtsPersona: mocks.getTtsPersona,
  getTtsProvider: mocks.getTtsProvider,
  isTtsEnabled: mocks.isTtsEnabled,
  listTtsPersonas: mocks.listTtsPersonas,
  resolveExplicitTtsOverrides:
    mocks.resolveExplicitTtsOverrides as typeof import("../../tts/tts.js").resolveExplicitTtsOverrides,
  resolveTtsAutoMode: mocks.resolveTtsAutoMode,
  resolveTtsConfig: mocks.resolveTtsConfig,
  resolveTtsPrefsPath: mocks.resolveTtsPrefsPath,
  resolveTtsProviderOrder: mocks.resolveTtsProviderOrder,
  setTtsEnabled: vi.fn(),
  setTtsPersona: vi.fn(),
  setTtsProvider: vi.fn(),
  textToSpeech: mocks.textToSpeech as typeof import("../../tts/tts.js").textToSpeech,
}));

describe("ttsHandlers", () => {
  beforeEach(() => {
    mocks.getRuntimeConfig.mockReset();
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.getResolvedSpeechProviderConfig.mockReset();
    mocks.getResolvedSpeechProviderConfig.mockImplementation(
      (_config: unknown, provider: string) => ({
        id: provider,
      }),
    );
    mocks.getTtsPersona.mockReset();
    mocks.getTtsPersona.mockReturnValue(undefined);
    mocks.getTtsProvider.mockReset();
    mocks.getTtsProvider.mockReturnValue("openai");
    mocks.isTtsEnabled.mockReset();
    mocks.isTtsEnabled.mockReturnValue(true);
    mocks.listSpeechProviders.mockReset();
    mocks.listSpeechProviders.mockReturnValue([]);
    mocks.listTtsPersonas.mockReset();
    mocks.listTtsPersonas.mockReturnValue([]);
    mocks.resolveExplicitTtsOverrides.mockReset();
    mocks.resolveExplicitTtsOverrides.mockReturnValue({});
    mocks.resolveTtsAutoMode.mockReset();
    mocks.resolveTtsAutoMode.mockReturnValue(false);
    mocks.resolveTtsConfig.mockReset();
    mocks.resolveTtsConfig.mockReturnValue({});
    mocks.resolveTtsPrefsPath.mockReset();
    mocks.resolveTtsPrefsPath.mockReturnValue("/tmp/tts.json");
    mocks.resolveTtsProviderOrder.mockReset();
    mocks.resolveTtsProviderOrder.mockReturnValue(["openai"]);
    mocks.textToSpeech.mockReset();
    mocks.textToSpeech.mockResolvedValue({
      success: true,
      audioPath: "/tmp/tts.mp3",
      provider: "openai",
      outputFormat: "mp3",
      voiceCompatible: false,
    });
  });

  it("yields before TTS status provider diagnostics and reuses one configured-state pass", async () => {
    const openaiConfigured = vi.fn(() => true);
    const googleConfigured = vi.fn(() => true);
    const providers: SpeechProviderPlugin[] = [
      {
        id: "openai",
        label: "OpenAI",
        isConfigured: openaiConfigured,
        synthesize: vi.fn(async () => ({
          audioBuffer: Buffer.from("openai-audio"),
          outputFormat: "mp3",
          fileExtension: ".mp3",
          voiceCompatible: false,
        })),
      },
      {
        id: "google",
        label: "Google",
        isConfigured: googleConfigured,
        synthesize: vi.fn(async () => ({
          audioBuffer: Buffer.from("google-audio"),
          outputFormat: "mp3",
          fileExtension: ".mp3",
          voiceCompatible: false,
        })),
      },
    ];
    mocks.listSpeechProviders.mockReturnValue(providers);
    mocks.resolveTtsProviderOrder.mockReturnValue(["openai", "google"]);

    const { ttsHandlers } = await import("./tts.js");
    const respond = vi.fn();
    const observedTurns: string[] = [];
    setImmediate(() => observedTurns.push("sibling"));

    await ttsHandlers["tts.status"]({
      params: {},
      respond,
      context: { getRuntimeConfig: mocks.getRuntimeConfig },
    } as never);

    expect(observedTurns).toEqual(["sibling"]);
    expect(mocks.listSpeechProviders).toHaveBeenCalledOnce();
    expect(mocks.resolveTtsProviderOrder).toHaveBeenCalledWith("openai", {}, providers);
    expect(openaiConfigured).toHaveBeenCalledOnce();
    expect(googleConfigured).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        fallbackProvider: "google",
        fallbackProviders: ["google"],
        providerStates: [
          { id: "openai", label: "OpenAI", configured: true },
          { id: "google", label: "Google", configured: true },
        ],
      }),
    );
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

    expectGatewayErrorResponse(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Error: Unknown TTS provider "bad".',
    });
    expect(mocks.textToSpeech).not.toHaveBeenCalled();
  });
});
