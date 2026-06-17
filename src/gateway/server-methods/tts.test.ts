/**
 * Tests for text-to-speech gateway methods and provider error envelopes.
 */

import { expectDefined } from "@openclaw/normalization-core";
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
  resolveTtsConfig: vi.fn(() => ({ maxTextLength: 4096 })),
  resolveTtsPrefsPath: vi.fn(() => "/tmp/tts.json"),
  resolveTtsProviderOrder: vi.fn(() => ["openai"]),
  synthesizeSpeech: vi.fn(
    async (): Promise<{
      success: boolean;
      audioBuffer?: Buffer;
      provider?: string;
      outputFormat?: string;
      fileExtension?: string;
      error?: string;
    }> => ({
      success: true,
      audioBuffer: Buffer.from([1, 2, 3]),
      provider: "openai",
      outputFormat: "mp3",
      fileExtension: ".mp3",
    }),
  ),
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
  synthesizeSpeech: mocks.synthesizeSpeech,
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
    mocks.resolveTtsConfig.mockReturnValue({ maxTextLength: 4096 });
    mocks.resolveTtsPrefsPath.mockReset();
    mocks.resolveTtsPrefsPath.mockReturnValue("/tmp/tts.json");
    mocks.resolveTtsProviderOrder.mockReset();
    mocks.resolveTtsProviderOrder.mockReturnValue(["openai"]);
    mocks.synthesizeSpeech.mockReset();
    mocks.synthesizeSpeech.mockResolvedValue({
      success: true,
      audioBuffer: Buffer.from([1, 2, 3]),
      provider: "openai",
      outputFormat: "mp3",
      fileExtension: ".mp3",
    });
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

    await expectDefined(
      ttsHandlers["tts.convert"],
      'ttsHandlers["tts.convert"] test invariant',
    )({
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

  it("tts.speak returns the synthesized clip inline with provider metadata", async () => {
    const { ttsHandlers } = await import("./tts.js");
    const respond = vi.fn();

    await expectDefined(
      ttsHandlers["tts.speak"],
      'ttsHandlers["tts.speak"] test invariant',
    )({
      params: { text: "Hello there." },
      respond,
      context: { getRuntimeConfig: mocks.getRuntimeConfig },
    } as never);

    expect(mocks.synthesizeSpeech).toHaveBeenCalledWith({ text: "Hello there.", cfg: {} });
    expect(respond).toHaveBeenCalledWith(true, {
      audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
      provider: "openai",
      outputFormat: "mp3",
      mimeType: "audio/mpeg",
      fileExtension: ".mp3",
    });
  });

  it("tts.speak rejects blank text without synthesizing", async () => {
    const { ttsHandlers } = await import("./tts.js");
    const respond = vi.fn();

    await expectDefined(
      ttsHandlers["tts.speak"],
      'ttsHandlers["tts.speak"] test invariant',
    )({
      params: { text: "   " },
      respond,
      context: { getRuntimeConfig: mocks.getRuntimeConfig },
    } as never);

    expectGatewayErrorResponse(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "tts.speak requires text",
    });
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("tts.speak rejects text above the configured max length", async () => {
    mocks.resolveTtsConfig.mockReturnValue({ maxTextLength: 10 });

    const { ttsHandlers } = await import("./tts.js");
    const respond = vi.fn();

    await expectDefined(
      ttsHandlers["tts.speak"],
      'ttsHandlers["tts.speak"] test invariant',
    )({
      params: { text: "This text is definitely too long." },
      respond,
      context: { getRuntimeConfig: mocks.getRuntimeConfig },
    } as never);

    expectGatewayErrorResponse(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "tts.speak text too long (33 chars, max 10)",
    });
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("tts.speak maps synthesis failures to UNAVAILABLE", async () => {
    mocks.synthesizeSpeech.mockResolvedValue({
      success: false,
      error: "No TTS provider is configured.",
    });

    const { ttsHandlers } = await import("./tts.js");
    const respond = vi.fn();

    await expectDefined(
      ttsHandlers["tts.speak"],
      'ttsHandlers["tts.speak"] test invariant',
    )({
      params: { text: "Hello there." },
      respond,
      context: { getRuntimeConfig: mocks.getRuntimeConfig },
    } as never);

    expectGatewayErrorResponse(respond, {
      code: ErrorCodes.UNAVAILABLE,
      message: "No TTS provider is configured.",
    });
  });
});
