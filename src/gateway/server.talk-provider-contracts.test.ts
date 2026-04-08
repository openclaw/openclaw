import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { talkHandlers } from "./server-methods/talk.js";

const synthesizeSpeechMock = vi.hoisted(() =>
  vi.fn(async () => ({
    success: true,
    audioBuffer: Buffer.from([4, 5, 6]),
    provider: "elevenlabs",
    outputFormat: "pcm_44100",
    fileExtension: ".pcm",
    voiceCompatible: false,
  })),
);

vi.mock("../tts/tts.js", () => ({
  synthesizeSpeech: synthesizeSpeechMock,
}));

type TalkSpeakPayload = {
  audioBase64?: string;
  provider?: string;
  outputFormat?: string;
  mimeType?: string;
  fileExtension?: string;
};

const DEFAULT_STUB_VOICE_ID = "stub-default-voice";
const ALIAS_STUB_VOICE_ID = "VoiceAlias1234567890";

async function invokeTalkSpeakDirect(params: Record<string, unknown>) {
  let response:
    | {
        ok: boolean;
        payload?: unknown;
        error?: { code?: string; message?: string; details?: unknown };
      }
    | undefined;
  await talkHandlers["talk.speak"]({
    req: { type: "req", id: "test", method: "talk.speak", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      response = { ok, payload, error };
    },
    context: {} as never,
  });
  return response;
}

async function withSpeechProviders<T>(
  speechProviders: NonNullable<ReturnType<typeof createEmptyPluginRegistry>["speechProviders"]>,
  run: () => Promise<T>,
): Promise<T> {
  const previousRegistry = getActivePluginRegistry() ?? createEmptyPluginRegistry();
  setActivePluginRegistry({
    ...createEmptyPluginRegistry(),
    speechProviders,
  });
  try {
    return await run();
  } finally {
    setActivePluginRegistry(previousRegistry);
  }
}

describe("gateway talk provider contracts", () => {
  it("resolves elevenlabs talk voice aliases case-insensitively and forwards output format", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: "elevenlabs-talk-key", // pragma: allowlist secret
            voiceId: DEFAULT_STUB_VOICE_ID,
            voiceAliases: {
              Clawd: ALIAS_STUB_VOICE_ID,
            },
          },
        },
      },
    });

    const res = await withSpeechProviders(
      [
        {
          pluginId: "elevenlabs-test",
          source: "test",
          provider: {
            id: "elevenlabs",
            label: "ElevenLabs",
            isConfigured: () => true,
            resolveTalkOverrides: ({ params }) => ({
              ...(typeof params.voiceId === "string" && params.voiceId.trim().length > 0
                ? { voiceId: params.voiceId.trim() }
                : {}),
              ...(typeof params.outputFormat === "string" && params.outputFormat.trim().length > 0
                ? { outputFormat: params.outputFormat.trim() }
                : {}),
              ...(typeof params.latencyTier === "number"
                ? { latencyTier: params.latencyTier }
                : {}),
            }),
            synthesize: async () => {
              throw new Error("synthesize should be mocked at the handler boundary");
            },
          },
        },
      ],
      async () =>
        await invokeTalkSpeakDirect({
          text: "Hello from talk mode.",
          voiceId: "clawd",
          outputFormat: "pcm_44100",
          latencyTier: 3,
        }),
    );
    expect(res?.ok, JSON.stringify(res?.error)).toBe(true);
    expect((res?.payload as TalkSpeakPayload | undefined)?.provider).toBe("elevenlabs");
    expect((res?.payload as TalkSpeakPayload | undefined)?.outputFormat).toBe("pcm_44100");
    expect((res?.payload as TalkSpeakPayload | undefined)?.audioBase64).toBe(
      Buffer.from([4, 5, 6]).toString("base64"),
    );

    expect(synthesizeSpeechMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello from talk mode.",
        overrides: {
          provider: "elevenlabs",
          providerOverrides: {
            elevenlabs: {
              voiceId: ALIAS_STUB_VOICE_ID,
              outputFormat: "pcm_44100",
              latencyTier: 3,
            },
          },
        },
        disableFallback: true,
      }),
    );
  });
});
