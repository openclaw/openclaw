import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import type { TtsSynthesisResult } from "../../tts/tts-runtime-types.js";
import { expectGatewayErrorResponse } from "./gateway-response.test-helpers.js";
import { ttsHandlers } from "./tts.js";

const mocks = vi.hoisted(() => ({
  updateTtsPrefsAsync: vi.fn(async () => {}),
  getRuntimeConfig: vi.fn(() => ({})),
  getSpeechProvider: vi.fn(),
  isTtsProviderConfiguredAsync: vi.fn(
    (_config: unknown, _provider: string | { id: string }) => true,
  ),
  listSpeechProviders: vi.fn(
    (): Array<{
      id: string;
      label: string;
      isConfigured: () => boolean;
      aliases?: readonly string[];
      autoSelectOrder?: number;
      models?: readonly string[];
      voices?: readonly string[];
    }> => [],
  ),
  resolveTtsSettingsSnapshot: vi.fn(),
  resolveTtsProviderOrder: vi.fn(() => ["openai"]),
  resolveExplicitTtsOverridesAsync: vi.fn(() => ({})),
  resolveTtsConfig: vi.fn(() => ({ maxTextLength: 4096 })),
  synthesizeSpeech: vi.fn(async (): Promise<TtsSynthesisResult> => ({
    success: true,
    audioBuffer: Buffer.from([1, 2, 3]),
    provider: "openai",
    outputFormat: "mp3",
    fileExtension: ".mp3",
  })),
  textToSpeech: vi.fn(async () => ({
    success: true,
    audioPath: "/tmp/tts.mp3",
    provider: "openai",
    outputFormat: "mp3",
    voiceCompatible: false,
  })),
}));

vi.mock("../../tts/tts-settings-write-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tts/tts-settings-write-worker.js")>()),
  updateTtsPrefsAsync: mocks.updateTtsPrefsAsync,
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig:
    mocks.getRuntimeConfig as typeof import("../../config/config.js").getRuntimeConfig,
}));

vi.mock("../../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: vi.fn(),
  getSpeechProvider: mocks.getSpeechProvider,
  listSpeechProviders: mocks.listSpeechProviders,
}));

// mock-isolation: TTS RPCs supply preference settings without reading the host machine's SQLite preference path.
vi.mock("../../tts/tts-preferences.js", () => ({
  prepareTtsPreferences: async () => ({}),
}));

vi.mock("../../tts/tts-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tts/tts-settings.js")>()),
  resolveTtsSettingsSnapshot: mocks.resolveTtsSettingsSnapshot,
}));

// mock-isolation: TTS RPCs use fixture settings and synthesis without machine preference bindings.
vi.mock("../../tts/tts.js", () => ({
  getResolvedSpeechProviderConfig: vi.fn(),
  getTtsPersona: vi.fn(() => undefined),
  getTtsProvider: vi.fn(() => "openai"),
  isTtsEnabled: vi.fn(() => true),
  isTtsProviderConfiguredAsync: mocks.isTtsProviderConfiguredAsync,
  listTtsPersonas: vi.fn(() => []),
  resolveExplicitTtsOverridesAsync: mocks.resolveExplicitTtsOverridesAsync,
  resolveTtsAutoMode: vi.fn(() => false),
  resolveTtsConfig: mocks.resolveTtsConfig,
  resolveTtsPrefsPathAsync: vi.fn(async () => "/tmp/tts.json"),
  resolveTtsProviderOrder: mocks.resolveTtsProviderOrder,
  synthesizeSpeech: mocks.synthesizeSpeech,
  textToSpeech: mocks.textToSpeech as typeof import("../../tts/tts.js").textToSpeech,
}));

async function callTts(method: string, params: Record<string, unknown> = {}) {
  const respond = vi.fn();
  await expectDefined(
    ttsHandlers[method],
    `TTS handler ${method}`,
  )({
    params,
    respond,
    context: { getRuntimeConfig: mocks.getRuntimeConfig },
  } as never);
  return respond;
}

function settings(provider = "openai", prefsPath = "/tmp/tts.json") {
  return {
    autoMode: "off",
    config: {
      maxTextLength: 4096,
      provider,
      providerSource: provider ? "config" : "default",
      sourceConfig: {},
    },
    maxLength: 1500,
    prefsPath,
    ...(provider
      ? { preferredProvider: provider, providerPreference: { provider, source: "config" } }
      : {}),
    summarize: true,
  };
}

function makeProvider(id: string, label: string, configured: boolean, autoSelectOrder?: number) {
  return {
    id,
    label,
    autoSelectOrder,
    models: [`${id}-speech-model`],
    voices: [`${id}-voice`],
    isConfigured: vi.fn(() => configured),
  };
}

function providerView(id: string, name: string, configured: boolean) {
  return { id, name, configured, models: [`${id}-speech-model`], voices: [`${id}-voice`] };
}

function expectProviderResponse(respond: ReturnType<typeof vi.fn>, payload: object) {
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(payload));
}

describe("ttsHandlers", () => {
  beforeEach(() => {
    setActiveDegradedSecretOwners([]);
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.resolveTtsSettingsSnapshot.mockReturnValue(settings());
  });

  it.each([
    { method: "tts.status", providerField: "provider" },
    { method: "tts.providers", providerField: "active" },
  ] as const)(
    "$method reuses one provider pass for automatic primary selection",
    async ({ method, providerField }) => {
      const providers = [
        makeProvider("openai", "OpenAI", false, 1),
        makeProvider("google", "Google", true, 2),
      ];
      mocks.listSpeechProviders.mockReturnValue(providers);
      mocks.isTtsProviderConfiguredAsync.mockImplementation((_config, provider) => {
        const providerId = typeof provider === "string" ? provider : provider.id;
        return providerId === "google";
      });
      mocks.resolveTtsProviderOrder.mockReturnValue(["google", "openai"]);
      mocks.resolveTtsSettingsSnapshot.mockReturnValue(settings("", "/tmp/tts-auto.json"));

      const respond = await callTts(method, {});

      expect(mocks.listSpeechProviders).toHaveBeenCalledOnce();
      expect(mocks.isTtsProviderConfiguredAsync.mock.calls.map((call) => call[1])).toEqual(
        providers,
      );
      expectProviderResponse(respond, { [providerField]: "google" });
      if (method === "tts.providers") {
        expect(respond).toHaveBeenCalledWith(true, {
          active: "google",
          providers: [
            providerView("openai", "OpenAI", false),
            providerView("google", "Google", true),
          ],
        });
      }
    },
  );

  it("probes configured fallbacks missing from the prepared inventory", async () => {
    const providers = [
      { id: "openai", label: "OpenAI", isConfigured: vi.fn(() => true) },
      { id: "google", label: "Google", isConfigured: vi.fn(() => false) },
    ];
    mocks.listSpeechProviders.mockReturnValue(providers);
    mocks.resolveTtsProviderOrder.mockReturnValue(["openai", "google", "voice-model-only"]);
    mocks.isTtsProviderConfiguredAsync.mockImplementation((_config, provider) => {
      const providerId = typeof provider === "string" ? provider : provider.id;
      return providerId !== "google";
    });

    const respond = await callTts("tts.status", {});

    expect(mocks.listSpeechProviders).toHaveBeenCalledOnce();
    expect(mocks.resolveTtsProviderOrder).toHaveBeenCalledWith("openai", {}, providers);
    expect(mocks.isTtsProviderConfiguredAsync.mock.calls.map((call) => call[1])).toEqual([
      providers[0],
      providers[1],
      "voice-model-only",
    ]);
    expectProviderResponse(respond, {
      fallbackProvider: "voice-model-only",
      fallbackProviders: ["voice-model-only"],
      providerStates: [
        { id: "openai", label: "OpenAI", configured: true },
        { id: "google", label: "Google", configured: false },
      ],
    });
  });

  it.each(["tts.status", "tts.providers"] as const)(
    "%s keeps invalid providers in the catalog as unconfigured",
    async (method) => {
      const invalidProvider = {
        id: "gradium",
        label: "Gradium",
        isConfigured: vi.fn(() => {
          throw new Error("Invalid Gradium baseUrl");
        }),
      };
      mocks.listSpeechProviders.mockReturnValue([invalidProvider]);
      mocks.resolveTtsProviderOrder.mockReturnValue(["openai", "gradium"]);
      mocks.isTtsProviderConfiguredAsync.mockImplementation((_config, provider) => {
        const providerId = typeof provider === "string" ? provider : provider.id;
        return providerId !== "gradium";
      });
      const respond = await callTts(method, {});

      expectProviderResponse(respond, {
        [method === "tts.status" ? "providerStates" : "providers"]: [
          expect.objectContaining({ id: "gradium", configured: false }),
        ],
      });
      expect(invalidProvider.isConfigured).not.toHaveBeenCalled();
    },
  );

  it("returns INVALID_REQUEST when TTS override validation fails", async () => {
    mocks.resolveExplicitTtsOverridesAsync.mockImplementation(() => {
      throw new Error('Unknown TTS provider "bad".');
    });

    const respond = await callTts("tts.convert", {
      text: "hello",
      provider: "bad",
    });

    expectGatewayErrorResponse(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Error: Unknown TTS provider "bad".',
    });
    expect(mocks.textToSpeech).not.toHaveBeenCalled();
  });

  it("tts.speak returns the synthesized clip inline with provider metadata", async () => {
    const respond = await callTts("tts.speak", { text: "Hello there." });

    expect(mocks.synthesizeSpeech).toHaveBeenCalledWith({ text: "Hello there.", cfg: {} });
    expect(respond).toHaveBeenCalledWith(true, {
      audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
      provider: "openai",
      outputFormat: "mp3",
      mimeType: "audio/mpeg",
      fileExtension: ".mp3",
    });
  });

  it.each([
    { text: "   ", message: "tts.speak requires text" },
    {
      text: "This text is definitely too long.",
      message: "tts.speak text too long (33 chars, max 10)",
    },
    { failure: "synthesis", message: "No TTS provider is configured." },
    {
      failure: "secret",
      message:
        "SecretSurfaceUnavailableError: Secret owner capability:tts is configured but unavailable (secret reference was not found).: code=SECRET_SURFACE_UNAVAILABLE",
    },
  ])("tts.speak rejects $message", async ({ text = "Hello", failure, message }) => {
    mocks.resolveTtsConfig.mockReturnValue({ maxTextLength: 10 });
    if (failure === "synthesis") {
      mocks.synthesizeSpeech.mockResolvedValue({ success: false, error: message });
    } else if (failure === "secret") {
      setActiveDegradedSecretOwners([
        {
          ownerKind: "capability",
          ownerId: "tts",
          state: "unavailable",
          paths: ["tts.providers.elevenlabs.apiKey"],
          refKeys: ["env:default:ELEVENLABS_API_KEY"],
          reason: "secret reference was not found",
        },
      ]);
    }
    const respond = await callTts("tts.speak", { text });
    expectGatewayErrorResponse(respond, {
      code: failure ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
      message,
    });
    if (failure === "secret") {
      expect(respond.mock.calls[0]?.[2]).toMatchObject({
        details: { reason: "SECRET_SURFACE_UNAVAILABLE", ownerKind: "capability", ownerId: "tts" },
      });
    }
    if (failure !== "synthesis") {
      expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
    }
  });
});
