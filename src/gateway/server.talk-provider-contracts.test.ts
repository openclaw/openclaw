import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { talkHandlers } from "./server-methods/talk.js";

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
  it("synthesizes talk audio via the OpenAI speech-provider contract", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        provider: "openai",
        providers: {
          openai: {
            apiKey: "openai-talk-key", // pragma: allowlist secret
            voiceId: "alloy",
            modelId: "gpt-4o-mini-tts",
          },
        },
      },
    });

    const originalFetch = globalThis.fetch;
    const requestInits: RequestInit[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init) {
        requestInits.push(init);
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = withFetchPreconnect(fetchMock);

    try {
      const res = await invokeTalkSpeakDirect({
        text: "Hello from talk mode.",
        voiceId: "nova",
        modelId: "tts-1",
        rateWpm: 218,
      });
      expect(res?.ok, JSON.stringify(res?.error)).toBe(true);
      expect((res?.payload as TalkSpeakPayload | undefined)?.provider).toBe("openai");
      expect((res?.payload as TalkSpeakPayload | undefined)?.outputFormat).toBe("mp3");
      expect((res?.payload as TalkSpeakPayload | undefined)?.mimeType).toBe("audio/mpeg");
      expect((res?.payload as TalkSpeakPayload | undefined)?.fileExtension).toBe(".mp3");
      expect((res?.payload as TalkSpeakPayload | undefined)?.audioBase64).toBe(
        Buffer.from([1, 2, 3]).toString("base64"),
      );

      expect(fetchMock).toHaveBeenCalled();
      const requestInit = requestInits.find((init) => typeof init.body === "string");
      expect(requestInit).toBeDefined();
      const body = JSON.parse(requestInit?.body as string) as Record<string, unknown>;
      expect(body.model).toBe("tts-1");
      expect(body.voice).toBe("nova");
      expect(body.speed).toBeCloseTo(218 / 175, 5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

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

    const originalFetch = globalThis.fetch;
    let fetchUrl: string | undefined;
    const requestInits: RequestInit[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init) {
        requestInits.push(init);
      }
      return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
    });
    globalThis.fetch = withFetchPreconnect(fetchMock);

    try {
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
                ...(typeof params.modelId === "string" && params.modelId.trim().length > 0
                  ? { modelId: params.modelId.trim() }
                  : {}),
                ...(typeof params.outputFormat === "string" && params.outputFormat.trim().length > 0
                  ? { outputFormat: params.outputFormat.trim() }
                  : {}),
                ...(typeof params.latencyTier === "number"
                  ? { latencyTier: params.latencyTier }
                  : {}),
              }),
              synthesize: async (req) => {
                const config = req.providerConfig as Record<string, unknown>;
                const overrides = (req.providerOverrides ?? {}) as Record<string, unknown>;
                const voiceId =
                  (typeof overrides.voiceId === "string" && overrides.voiceId.trim().length > 0
                    ? overrides.voiceId.trim()
                    : undefined) ??
                  (typeof config.voiceId === "string" && config.voiceId.trim().length > 0
                    ? config.voiceId.trim()
                    : undefined) ??
                  DEFAULT_STUB_VOICE_ID;
                const outputFormat =
                  typeof overrides.outputFormat === "string" &&
                  overrides.outputFormat.trim().length > 0
                    ? overrides.outputFormat.trim()
                    : "mp3";
                const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`);
                url.searchParams.set("output_format", outputFormat);
                const response = await globalThis.fetch(url.href, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    text: req.text,
                    ...(typeof overrides.latencyTier === "number"
                      ? { latency_optimization_level: overrides.latencyTier }
                      : {}),
                  }),
                });
                return {
                  audioBuffer: Buffer.from(await response.arrayBuffer()),
                  outputFormat,
                  fileExtension: outputFormat.startsWith("pcm") ? ".pcm" : ".mp3",
                  voiceCompatible: false,
                };
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

      expect(fetchMock).toHaveBeenCalled();
      expect(fetchUrl).toContain(`/v1/text-to-speech/${ALIAS_STUB_VOICE_ID}`);
      expect(fetchUrl).toContain("output_format=pcm_44100");
      const init = requestInits[0];
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(bodyText) as Record<string, unknown>;
      expect(body.latency_optimization_level).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
