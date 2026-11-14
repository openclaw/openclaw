import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CODE_HEAVY_SPOKEN_FALLBACK } from "../tts/speech-text.js";
import { invokeTalkSpeakDirect, withSpeechProviders } from "./talk/test-helpers.js";

const synthesizeSpeechMock = vi.hoisted(() =>
  vi.fn<typeof import("../tts/tts.js").synthesizeSpeech>(),
);
// mock-isolation: Keep live provider modules out of this handler-boundary suite.
vi.mock("../tts/tts.js", () => ({ synthesizeSpeech: synthesizeSpeechMock }));
// mock-isolation: Supply synthetic speech bytes without initializing live synthesis providers.
vi.mock("../tts/tts-synthesis.js", () => ({ synthesizeTalkSpeech: synthesizeSpeechMock }));

const text = "Hello from talk mode.";
const voiceId = "VoiceAlias1234567890";
const audioResult = (
  audioBuffer = Buffer.from([7, 8, 9]),
  provider = "acme",
  outputFormat = "mp3",
  fileExtension = ".mp3",
) => ({
  success: true as const,
  audioBuffer,
  provider,
  outputFormat,
  fileExtension,
  voiceCompatible: false,
});
const synthesize = async () => {
  throw new Error("synthesize should be mocked at the handler boundary");
};
function speechProvider(
  id: string,
  hooks: Partial<Parameters<typeof withSpeechProviders>[0][number]["provider"]> = {},
) {
  return {
    pluginId: `${id}-test`,
    source: "test" as const,
    provider: { id, label: id, isConfigured: () => true, synthesize, ...hooks },
  };
}
async function setTalkConfig(talk: Record<string, unknown>) {
  const { setRuntimeConfigSnapshot } = await import("../config/config.js");
  const config = { commands: { ownerDisplaySecret: "openclaw-test-owner-display-secret" }, talk };
  setRuntimeConfigSnapshot(config, config);
}
async function withAcmeSpeechProvider(run: () => Promise<void>) {
  await setTalkConfig({ provider: "acme", providers: { acme: { voiceId: "plugin-voice" } } });
  await withSpeechProviders([speechProvider("acme")], run);
}

describe("gateway talk runtime", () => {
  beforeAll(async () => {
    await import("./talk/handlers/index.js");
    await import("../config/config.js");
  });
  beforeEach(() => {
    synthesizeSpeechMock.mockReset();
    synthesizeSpeechMock.mockResolvedValue(audioResult());
  });

  it("uses the spoken fallback for code-heavy talk.speak replies", () =>
    withAcmeSpeechProvider(async () => {
      const res = await invokeTalkSpeakDirect({
        text: "```ts\nexport function answer() {\n  return 42;\n}\n```",
      });
      expect(res?.ok, JSON.stringify(res?.error)).toBe(true);
      expect(synthesizeSpeechMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: CODE_HEAVY_SPOKEN_FALLBACK }),
      );
    }));

  it("resolves the prototype-named talk voice alias and forwards provider overrides", async () => {
    await setTalkConfig({
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          voiceId: "stub-default-voice",
          voiceAliases: { ["__proto__"]: voiceId },
        },
      },
    });
    await withSpeechProviders(
      [
        speechProvider("elevenlabs", {
          resolveTalkOverrides: ({ params }) => ({
            ...(typeof params.voiceId === "string" && params.voiceId.trim().length > 0
              ? { voiceId: params.voiceId.trim() }
              : {}),
            ...(typeof params.outputFormat === "string" && params.outputFormat.trim().length > 0
              ? { outputFormat: params.outputFormat.trim() }
              : {}),
            ...(typeof params.latencyTier === "number" ? { latencyTier: params.latencyTier } : {}),
          }),
        }),
      ],
      async () => {
        const audio = Buffer.from([4, 5, 6]);
        const providerOverrides = { voiceId, outputFormat: "pcm_44100", latencyTier: 3 };
        synthesizeSpeechMock.mockResolvedValue(
          audioResult(audio, "elevenlabs", "pcm_44100", ".pcm"),
        );
        const res = await invokeTalkSpeakDirect({
          text,
          ...providerOverrides,
          voiceId: "__PROTO__",
        });
        expect(res?.ok, JSON.stringify(res?.error)).toBe(true);
        expect(res?.payload).toMatchObject({
          provider: "elevenlabs",
          outputFormat: "pcm_44100",
          audioBase64: audio.toString("base64"),
        });
        expect(synthesizeSpeechMock).toHaveBeenCalledWith(
          expect.objectContaining({
            text,
            disableFallback: true,
            overrides: {
              provider: "elevenlabs",
              providerOverrides: { elevenlabs: providerOverrides },
            },
          }),
        );
      },
    );
  });

  it("returns fallback-eligible details when talk provider is not configured", async () => {
    await setTalkConfig({});
    const res = await invokeTalkSpeakDirect({ text });
    expect(res?.ok).toBe(false);
    expect(res?.error?.message).toContain("talk provider not configured");
    expect(res?.error?.details).toEqual({ reason: "talk_unconfigured", fallbackEligible: true });
  });

  it.each([
    { result: { success: false as const, error: "provider failed" }, reason: "synthesis_failed" },
    { result: audioResult(Buffer.alloc(0)), reason: "invalid_audio_result" },
  ])("rejects synthesis with $reason", ({ result, reason }) =>
    withAcmeSpeechProvider(async () => {
      synthesizeSpeechMock.mockResolvedValue(result);
      const res = await invokeTalkSpeakDirect({ text });
      expect(res?.ok).toBe(false);
      expect(res?.error?.details).toEqual({ reason, fallbackEligible: false });
    }),
  );
});
