import { describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { talkHandlers } from "./server-methods/talk.js";
import { withServer } from "./test-with-server.js";

type TalkSpeakPayload = {
  audioBase64?: string;
  provider?: string;
};

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

describe("gateway talk runtime", () => {
  it("allows extension speech providers through talk.speak", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        provider: "acme",
        providers: {
          acme: {
            voiceId: "plugin-voice",
          },
        },
      },
    });

    await withServer(async () => {
      await withSpeechProviders(
        [
          {
            pluginId: "acme-plugin",
            source: "test",
            provider: {
              id: "acme",
              label: "Acme Speech",
              isConfigured: () => true,
              synthesize: async () => ({
                audioBuffer: Buffer.from([7, 8, 9]),
                outputFormat: "mp3",
                fileExtension: ".mp3",
                voiceCompatible: false,
              }),
            },
          },
        ],
        async () => {
          const res = await invokeTalkSpeakDirect({
            text: "Hello from talk mode.",
          });
          expect(res?.ok, JSON.stringify(res?.error)).toBe(true);
          expect((res?.payload as TalkSpeakPayload | undefined)?.provider).toBe("acme");
          expect((res?.payload as TalkSpeakPayload | undefined)?.audioBase64).toBe(
            Buffer.from([7, 8, 9]).toString("base64"),
          );
        },
      );
    });
  });

  it("returns fallback-eligible details when talk provider is not configured", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({ talk: {} });

    await withServer(async () => {
      const res = await invokeTalkSpeakDirect({ text: "Hello from talk mode." });
      expect(res?.ok).toBe(false);
      expect(res?.error?.message).toContain("talk provider not configured");
      expect((res?.error as { details?: unknown } | undefined)?.details).toEqual({
        reason: "talk_unconfigured",
        fallbackEligible: true,
      });
    });
  });

  it("returns synthesis_failed details when the provider rejects synthesis", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        provider: "acme",
        providers: {
          acme: {
            voiceId: "plugin-voice",
          },
        },
      },
    });

    await withServer(async () => {
      await withSpeechProviders(
        [
          {
            pluginId: "acme-plugin",
            source: "test",
            provider: {
              id: "acme",
              label: "Acme Speech",
              isConfigured: () => true,
              synthesize: async () => {
                throw new Error("provider failed");
              },
            },
          },
        ],
        async () => {
          const res = await invokeTalkSpeakDirect({ text: "Hello from talk mode." });
          expect(res?.ok).toBe(false);
          expect(res?.error?.details).toEqual({
            reason: "synthesis_failed",
            fallbackEligible: false,
          });
        },
      );
    });
  });

  it("rejects empty audio results as invalid_audio_result", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        provider: "acme",
        providers: {
          acme: {
            voiceId: "plugin-voice",
          },
        },
      },
    });

    await withServer(async () => {
      await withSpeechProviders(
        [
          {
            pluginId: "acme-plugin",
            source: "test",
            provider: {
              id: "acme",
              label: "Acme Speech",
              isConfigured: () => true,
              synthesize: async () => ({
                audioBuffer: Buffer.alloc(0),
                outputFormat: "mp3",
                fileExtension: ".mp3",
                voiceCompatible: false,
              }),
            },
          },
        ],
        async () => {
          const res = await invokeTalkSpeakDirect({ text: "Hello from talk mode." });
          expect(res?.ok).toBe(false);
          expect(res?.error?.details).toEqual({
            reason: "invalid_audio_result",
            fallbackEligible: false,
          });
        },
      );
    });
  });
});
