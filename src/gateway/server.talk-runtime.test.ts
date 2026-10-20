import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CODE_HEAVY_SPOKEN_FALLBACK } from "../tts/speech-text.js";
import { invokeTalkSpeakDirect, withSpeechProviders } from "./talk/test-helpers.js";

const synthesizeSpeechMock = vi.hoisted(() =>
  vi.fn<typeof import("../tts/tts.js").synthesizeSpeech>(),
);

// mock-isolation: Exercise speech dispatch without loading the live TTS provider runtime.
vi.mock("../tts/tts.js", () => ({ synthesizeSpeech: synthesizeSpeechMock }));

vi.mock("../tts/tts-synthesis.js", () => ({ synthesizeTalkSpeech: synthesizeSpeechMock }));

const ALIAS_STUB_VOICE_ID = "VoiceAlias1234567890";
const audioResult = (audioBuffer = Buffer.from([7, 8, 9])) => ({
  success: true as const,
  audioBuffer,
  provider: "acme",
  outputFormat: "mp3",
  fileExtension: ".mp3",
  voiceCompatible: false,
});
const synthesize = async () => {
  throw new Error("synthesize should be mocked at the handler boundary");
};
function speechProvider(
  id: string,
  hooks: Partial<Parameters<typeof withSpeechProviders>[0][number]["provider"]>,
) {
  return {
    pluginId: `${id}-test`,
    source: "test" as const,
    provider: { id, label: id, isConfigured: () => true, synthesize, ...hooks },
  };
}

async function setTalkConfig(talk: Record<string, unknown>) {
  const { setRuntimeConfigSnapshot } = await import("../config/config.js");
  const config = {
    commands: { ownerDisplaySecret: "openclaw-test-owner-display-secret" },
    talk,
  };
  setRuntimeConfigSnapshot(config, config);
}

async function withAcmeSpeechProvider(run: () => Promise<void>) {
  await setTalkConfig({ provider: "acme", providers: { acme: { voiceId: "plugin-voice" } } });
  await withSpeechProviders(
    [
      speechProvider("acme", {
        resolveTalkConfig: ({ talkProviderConfig }) => ({
          ...talkProviderConfig,
          resolvedBy: "acme-test-provider",
        }),
      }),
    ],
    run,
  );
}

async function expectSynthesisFailure(
  result: Awaited<ReturnType<typeof synthesizeSpeechMock>>,
  reason: string,
) {
  await withAcmeSpeechProvider(async () => {
    synthesizeSpeechMock.mockResolvedValue(result);
    const res = await invokeTalkSpeakDirect({ text: "Hello from talk mode." });
    expect(res?.ok).toBe(false);
    expect(res?.error?.details).toEqual({ reason, fallbackEligible: false });
  });
}

function expectSingleSynthesizeSpeechCall() {
  expect(synthesizeSpeechMock).toHaveBeenCalledTimes(1);
  const params = synthesizeSpeechMock.mock.calls.at(0)?.[0];
  if (params === undefined) {
    throw new Error("expected synthesizeSpeech call params");
  }
  return params;
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

  it("uses the spoken fallback for code-heavy talk.speak replies", async () => {
    await withAcmeSpeechProvider(async () => {
      const res = await invokeTalkSpeakDirect({
        text: "```ts\nexport function answer() {\n  return 42;\n}\n```",
      });

      expect(res?.ok, JSON.stringify(res?.error)).toBe(true);
      const synthesis = expectSingleSynthesizeSpeechCall();
      expect(synthesis.text).toBe(CODE_HEAVY_SPOKEN_FALLBACK);
      expect(synthesis.cfg).toMatchObject({
        tts: {
          provider: "acme",
          providers: { acme: { resolvedBy: "acme-test-provider", voiceId: "plugin-voice" } },
        },
      });
    });
  });

  it("resolves the prototype-named talk voice alias and forwards provider overrides", async () => {
    const voiceId = "__PROTO__";
    await setTalkConfig({
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          voiceId: "stub-default-voice",
          voiceAliases: { Clawd: ALIAS_STUB_VOICE_ID, ["__proto__"]: ALIAS_STUB_VOICE_ID },
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
        synthesizeSpeechMock.mockResolvedValue({
          ...audioResult(),
          audioBuffer: Buffer.from([4, 5, 6]),
          provider: "elevenlabs",
          outputFormat: "pcm_44100",
          fileExtension: ".pcm",
        });

        const res = await invokeTalkSpeakDirect({
          text: "Hello from talk mode.",
          voiceId,
          outputFormat: "pcm_44100",
          latencyTier: 3,
        });

        expect(res?.ok, JSON.stringify(res?.error)).toBe(true);
        expect(res?.payload).toMatchObject({
          provider: "elevenlabs",
          outputFormat: "pcm_44100",
          audioBase64: Buffer.from([4, 5, 6]).toString("base64"),
        });
        const synthesizeParams = expectSingleSynthesizeSpeechCall();
        expect(synthesizeParams.text).toBe("Hello from talk mode.");
        expect(synthesizeParams.overrides).toEqual({
          provider: "elevenlabs",
          providerOverrides: {
            elevenlabs: {
              voiceId: ALIAS_STUB_VOICE_ID,
              outputFormat: "pcm_44100",
              latencyTier: 3,
            },
          },
        });
        expect(synthesizeParams.disableFallback).toBe(true);
      },
    );
  });

  it("returns fallback-eligible details when talk provider is not configured", async () => {
    await setTalkConfig({});

    const res = await invokeTalkSpeakDirect({ text: "Hello from talk mode." });
    expect(res?.ok).toBe(false);
    expect(res?.error?.message).toContain("talk provider not configured");
    expect(res?.error?.details).toEqual({
      reason: "talk_unconfigured",
      fallbackEligible: true,
    });
  });

  it("returns synthesis_failed details when the provider rejects synthesis", async () => {
    await expectSynthesisFailure({ success: false, error: "provider failed" }, "synthesis_failed");
  });

  it("rejects empty audio results as invalid_audio_result", async () => {
    await expectSynthesisFailure(audioResult(Buffer.alloc(0)), "invalid_audio_result");
  });
});
