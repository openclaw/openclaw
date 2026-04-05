import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import { validateTalkConfigResult } from "./protocol/index.js";
import { talkHandlers } from "./server-methods/talk.js";
import {
  connectOk,
  installGatewayTestHooks,
  readConnectChallengeNonce,
  rpcReq,
} from "./test-helpers.js";
import { withServer } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

type GatewaySocket = Parameters<Parameters<typeof withServer>[0]>[0];
type SecretRef = { source?: string; provider?: string; id?: string };
type TalkConfigPayload = {
  config?: {
    talk?: {
      provider?: string;
      providers?: {
        [providerId: string]: { voiceId?: string; apiKey?: string | SecretRef } | undefined;
      };
      resolved?: {
        provider?: string;
        config?: { voiceId?: string; apiKey?: string | SecretRef };
      };
      silenceTimeoutMs?: number;
    };
    session?: { mainKey?: string };
    ui?: { seamColor?: string };
  };
};
type TalkConfig = NonNullable<NonNullable<TalkConfigPayload["config"]>["talk"]>;
type TalkSpeakPayload = {
  audioBase64?: string;
  provider?: string;
  outputFormat?: string;
  mimeType?: string;
  fileExtension?: string;
  voiceCompatible?: boolean;
};
const TALK_CONFIG_DEVICE_PATH = path.join(
  os.tmpdir(),
  `openclaw-talk-config-device-${process.pid}.json`,
);
const TALK_CONFIG_DEVICE = loadOrCreateDeviceIdentity(TALK_CONFIG_DEVICE_PATH);
const GENERIC_TALK_PROVIDER_ID = "acme";
const GENERIC_TALK_API_ENV = "ACME_SPEECH_API_KEY";
const DEFAULT_STUB_VOICE_ID = "stub-default-voice";
const ALIAS_STUB_VOICE_ID = "VoiceAlias1234567890";

async function createFreshOperatorDevice(scopes: string[], nonce: string) {
  const signedAtMs = Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: TALK_CONFIG_DEVICE.deviceId,
    clientId: "test",
    clientMode: "test",
    role: "operator",
    scopes,
    signedAtMs,
    token: "secret",
    nonce,
  });

  return {
    id: TALK_CONFIG_DEVICE.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(TALK_CONFIG_DEVICE.publicKeyPem),
    signature: signDevicePayload(TALK_CONFIG_DEVICE.privateKeyPem, payload),
    signedAt: signedAtMs,
    nonce,
  };
}

async function connectOperator(ws: GatewaySocket, scopes: string[]) {
  const nonce = await readConnectChallengeNonce(ws);
  expect(nonce).toBeTruthy();
  await connectOk(ws, {
    token: "secret",
    scopes,
    device: await createFreshOperatorDevice(scopes, String(nonce)),
  });
}

async function writeTalkConfig(config: {
  provider?: string;
  apiKey?: string | { source: "env" | "file" | "exec"; provider: string; id: string };
  voiceId?: string;
  silenceTimeoutMs?: number;
}) {
  const { writeConfigFile } = await import("../config/config.js");
  const providerId = config.provider ?? GENERIC_TALK_PROVIDER_ID;
  await writeConfigFile({
    talk: {
      provider: providerId,
      silenceTimeoutMs: config.silenceTimeoutMs,
      providers:
        config.apiKey !== undefined || config.voiceId !== undefined
          ? {
              [providerId]: {
                ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
                ...(config.voiceId !== undefined ? { voiceId: config.voiceId } : {}),
              },
            }
          : undefined,
    },
  });
}

async function fetchTalkConfig(
  ws: GatewaySocket,
  params?: { includeSecrets?: boolean } | Record<string, unknown>,
) {
  return rpcReq<TalkConfigPayload>(ws, "talk.config", params ?? {});
}

async function fetchTalkSpeak(
  ws: GatewaySocket,
  params: Record<string, unknown>,
  timeoutMs?: number,
) {
  return rpcReq(ws, "talk.speak", params, timeoutMs);
}

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

function expectTalkConfig(
  talk: TalkConfig | undefined,
  expected: {
    provider: string;
    voiceId?: string;
    apiKey?: string | SecretRef;
    silenceTimeoutMs?: number;
  },
) {
  expect(talk?.provider).toBe(expected.provider);
  expect(talk?.providers?.[expected.provider]?.voiceId).toBe(expected.voiceId);
  expect(talk?.resolved?.provider).toBe(expected.provider);
  expect(talk?.resolved?.config?.voiceId).toBe(expected.voiceId);

  if ("apiKey" in expected) {
    expect(talk?.providers?.[expected.provider]?.apiKey).toEqual(expected.apiKey);
    expect(talk?.resolved?.config?.apiKey).toEqual(expected.apiKey);
  }
  if ("silenceTimeoutMs" in expected) {
    expect(talk?.silenceTimeoutMs).toBe(expected.silenceTimeoutMs);
  }
}

describe("gateway talk.config", () => {
  it("returns redacted talk config for read scope", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        provider: GENERIC_TALK_PROVIDER_ID,
        providers: {
          [GENERIC_TALK_PROVIDER_ID]: {
            voiceId: "voice-123",
            apiKey: "secret-key-abc", // pragma: allowlist secret
          },
        },
        silenceTimeoutMs: 1500,
      },
      session: {
        mainKey: "main-test",
      },
      ui: {
        seamColor: "#112233",
      },
    });

    await withServer(async (ws) => {
      await connectOperator(ws, ["operator.read"]);
      const res = await fetchTalkConfig(ws);
      expect(res.ok).toBe(true);
      expectTalkConfig(res.payload?.config?.talk, {
        provider: GENERIC_TALK_PROVIDER_ID,
        voiceId: "voice-123",
        apiKey: "__OPENCLAW_REDACTED__",
        silenceTimeoutMs: 1500,
      });
      expect(res.payload?.config?.session?.mainKey).toBe("main");
      expect(res.payload?.config?.ui?.seamColor).toBe("#112233");
    });
  });

  it("rejects invalid talk.config params", async () => {
    await writeTalkConfig({ apiKey: "secret-key-abc" }); // pragma: allowlist secret

    await withServer(async (ws) => {
      await connectOperator(ws, ["operator.read"]);
      const res = await fetchTalkConfig(ws, { includeSecrets: "yes" });
      expect(res.ok).toBe(false);
      expect(res.error?.message).toContain("invalid talk.config params");
    });
  });

  it("requires operator.talk.secrets for includeSecrets", async () => {
    await writeTalkConfig({ apiKey: "secret-key-abc" }); // pragma: allowlist secret

    await withServer(async (ws) => {
      await connectOperator(ws, ["operator.read"]);
      const res = await fetchTalkConfig(ws, { includeSecrets: true });
      expect(res.ok).toBe(false);
      expect(res.error?.message).toContain("missing scope: operator.talk.secrets");
    });
  });

  it.each([
    ["operator.talk.secrets", ["operator.read", "operator.write", "operator.talk.secrets"]],
    ["operator.admin", ["operator.read", "operator.admin"]],
  ] as const)("returns secrets for %s scope", async (_label, scopes) => {
    await writeTalkConfig({ apiKey: "secret-key-abc" }); // pragma: allowlist secret

    await withServer(async (ws) => {
      await connectOperator(ws, [...scopes]);
      const res = await fetchTalkConfig(ws, { includeSecrets: true });
      expect(res.ok).toBe(true);
      expectTalkConfig(res.payload?.config?.talk, {
        provider: GENERIC_TALK_PROVIDER_ID,
        apiKey: "secret-key-abc",
      });
    });
  });

  it("returns Talk SecretRef payloads that satisfy the protocol schema", async () => {
    await writeTalkConfig({
      apiKey: {
        source: "env",
        provider: "default",
        id: GENERIC_TALK_API_ENV,
      },
    });

    await withEnvAsync({ [GENERIC_TALK_API_ENV]: "env-acme-key" }, async () => {
      await withServer(async (ws) => {
        await connectOperator(ws, ["operator.read", "operator.write", "operator.talk.secrets"]);
        const res = await fetchTalkConfig(ws, { includeSecrets: true });
        expect(res.ok, JSON.stringify(res.error)).toBe(true);
        expect(validateTalkConfigResult(res.payload)).toBe(true);
        const secretRef = {
          source: "env",
          provider: "default",
          id: GENERIC_TALK_API_ENV,
        } satisfies SecretRef;
        expectTalkConfig(res.payload?.config?.talk, {
          provider: GENERIC_TALK_PROVIDER_ID,
          apiKey: secretRef,
        });
      });
    });
  });

  it("resolves plugin-owned Talk defaults before redaction", async () => {
    await writeTalkConfig({
      provider: GENERIC_TALK_PROVIDER_ID,
      voiceId: "voice-from-config",
    });

    await withEnvAsync({ [GENERIC_TALK_API_ENV]: "env-acme-key" }, async () => {
      await withSpeechProviders(
        [
          {
            pluginId: "acme-talk-defaults-test",
            source: "test",
            provider: {
              id: GENERIC_TALK_PROVIDER_ID,
              label: "Acme Speech",
              isConfigured: () => true,
              resolveTalkConfig: ({ talkProviderConfig }) => ({
                ...talkProviderConfig,
                apiKey:
                  typeof process.env[GENERIC_TALK_API_ENV] === "string"
                    ? process.env[GENERIC_TALK_API_ENV]
                    : undefined,
              }),
              synthesize: async () => ({
                audioBuffer: Buffer.from([1]),
                outputFormat: "mp3",
                fileExtension: ".mp3",
                voiceCompatible: false,
              }),
            },
          },
        ],
        async () => {
          await withServer(async (ws) => {
            await connectOperator(ws, ["operator.read"]);
            const res = await fetchTalkConfig(ws);
            expect(res.ok, JSON.stringify(res.error)).toBe(true);
            expectTalkConfig(res.payload?.config?.talk, {
              provider: GENERIC_TALK_PROVIDER_ID,
              voiceId: "voice-from-config",
              apiKey: "__OPENCLAW_REDACTED__",
            });
          });
        },
      );
    });
  });

  it("returns canonical provider talk payloads", async () => {
    await writeTalkConfig({
      provider: GENERIC_TALK_PROVIDER_ID,
      voiceId: "voice-normalized",
    });

    await withServer(async (ws) => {
      await connectOperator(ws, ["operator.read"]);
      const res = await fetchTalkConfig(ws);
      expect(res.ok).toBe(true);
      expectTalkConfig(res.payload?.config?.talk, {
        provider: GENERIC_TALK_PROVIDER_ID,
        voiceId: "voice-normalized",
      });
    });
  });

  it("synthesizes talk audio via the active talk provider", async () => {
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

  it("resolves talk voice aliases case-insensitively and forwards output format", async () => {
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
            text: "Hello from plugin talk mode.",
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

    await withServer(async (ws) => {
      await connectOperator(ws, ["operator.read", "operator.write"]);
      const res = await fetchTalkSpeak(ws, { text: "Hello from talk mode." });
      expect(res.ok).toBe(false);
      expect(res.error?.message).toContain("talk provider not configured");
      expect((res.error as { details?: unknown } | undefined)?.details).toEqual({
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
