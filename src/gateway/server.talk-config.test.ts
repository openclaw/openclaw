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
import {
  connectOk,
  installGatewayTestHooks,
  readConnectChallengeNonce,
  resetTestPluginRegistry,
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
        elevenlabs?: { voiceId?: string; apiKey?: string | SecretRef };
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
const TALK_CONFIG_DEVICE_PATH = path.join(
  os.tmpdir(),
  `openclaw-talk-config-device-${process.pid}.json`,
);
const TALK_CONFIG_DEVICE = loadOrCreateDeviceIdentity(TALK_CONFIG_DEVICE_PATH);

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
  apiKey?: string | { source: "env" | "file" | "exec"; provider: string; id: string };
  voiceId?: string;
  silenceTimeoutMs?: number;
}) {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile({
    talk: {
      silenceTimeoutMs: config.silenceTimeoutMs,
      providers:
        config.apiKey !== undefined || config.voiceId !== undefined
          ? {
              elevenlabs: {
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

function expectElevenLabsTalkConfig(
  talk: TalkConfig | undefined,
  expected: {
    voiceId?: string;
    apiKey?: string | SecretRef;
    silenceTimeoutMs?: number;
  },
) {
  expect(talk?.provider).toBe("elevenlabs");
  expect(talk?.providers?.elevenlabs?.voiceId).toBe(expected.voiceId);
  expect(talk?.resolved?.provider).toBe("elevenlabs");
  expect(talk?.resolved?.config?.voiceId).toBe(expected.voiceId);

  if ("apiKey" in expected) {
    expect(talk?.providers?.elevenlabs?.apiKey).toEqual(expected.apiKey);
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
        providers: {
          elevenlabs: {
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
      expectElevenLabsTalkConfig(res.payload?.config?.talk, {
        voiceId: "voice-123",
        apiKey: "__OPENCLAW_REDACTED__",
        silenceTimeoutMs: 1500,
      });
      expect(res.payload?.config?.session?.mainKey).toBe("main-test");
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
      expectElevenLabsTalkConfig(res.payload?.config?.talk, {
        apiKey: "secret-key-abc",
      });
    });
  });

  it("returns Talk SecretRef payloads that satisfy the protocol schema", async () => {
    await writeTalkConfig({
      apiKey: {
        source: "env",
        provider: "default",
        id: "ELEVENLABS_API_KEY",
      },
    });

    await withEnvAsync({ ELEVENLABS_API_KEY: "env-elevenlabs-key" }, async () => {
      await withServer(async (ws) => {
        await connectOperator(ws, ["operator.read", "operator.write", "operator.talk.secrets"]);
        const res = await fetchTalkConfig(ws, { includeSecrets: true });
        expect(res.ok).toBe(true);
        expect(validateTalkConfigResult(res.payload)).toBe(true);
        const secretRef = {
          source: "env",
          provider: "default",
          id: "ELEVENLABS_API_KEY",
        } satisfies SecretRef;
        expectElevenLabsTalkConfig(res.payload?.config?.talk, { apiKey: secretRef });
      });
    });
  });

  it("returns canonical provider talk payloads", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            voiceId: "voice-normalized",
          },
        },
      },
    });

    await withServer(async (ws) => {
      await connectOperator(ws, ["operator.read"]);
      const res = await fetchTalkConfig(ws);
      expect(res.ok).toBe(true);
      expectElevenLabsTalkConfig(res.payload?.config?.talk, {
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
      await withServer(async (ws) => {
        resetTestPluginRegistry();
        await connectOperator(ws, ["operator.read", "operator.write"]);
        const res = await fetchTalkSpeak(
          ws,
          {
            text: "Hello from talk mode.",
            voiceId: "nova",
            modelId: "tts-1",
            speed: 1.25,
          },
          30_000,
        );
        expect(res.ok, JSON.stringify(res)).toBe(true);
        expect(res.payload?.provider).toBe("openai");
        expect(res.payload?.outputFormat).toBe("mp3");
        expect(res.payload?.mimeType).toBe("audio/mpeg");
        expect(res.payload?.fileExtension).toBe(".mp3");
        expect(res.payload?.audioBase64).toBe(Buffer.from([1, 2, 3]).toString("base64"));
      });

      expect(fetchMock).toHaveBeenCalled();
      const requestInit = requestInits.find((init) => typeof init.body === "string");
      expect(requestInit).toBeDefined();
      const body = JSON.parse(requestInit?.body as string) as Record<string, unknown>;
      expect(body.model).toBe("tts-1");
      expect(body.voice).toBe("nova");
      expect(body.speed).toBe(1.25);
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
            voiceId: "voice-default",
            voiceAliases: {
              Clawd: "EXAVITQu4vr4xnSDxMaL",
            },
          },
        },
      },
    });

    const originalFetch = globalThis.fetch;
    let fetchUrl: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      fetchUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
    });
    globalThis.fetch = withFetchPreconnect(fetchMock);

    try {
      await withServer(async (ws) => {
        resetTestPluginRegistry();
        await connectOperator(ws, ["operator.read", "operator.write"]);
        const res = await fetchTalkSpeak(ws, {
          text: "Hello from talk mode.",
          voiceId: "clawd",
          outputFormat: "pcm_44100",
        });
        expect(res.ok, JSON.stringify(res)).toBe(true);
        expect(res.payload?.provider).toBe("elevenlabs");
        expect(res.payload?.outputFormat).toBe("pcm_44100");
        expect(res.payload?.audioBase64).toBe(Buffer.from([4, 5, 6]).toString("base64"));
      });

      expect(fetchMock).toHaveBeenCalled();
      expect(fetchUrl).toContain("/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL");
      expect(fetchUrl).toContain("output_format=pcm_44100");
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

    await withServer(async (ws) => {
      const previousRegistry = getActivePluginRegistry() ?? createEmptyPluginRegistry();
      setActivePluginRegistry({
        ...createEmptyPluginRegistry(),
        speechProviders: [
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
      });
      try {
        await connectOperator(ws, ["operator.read", "operator.write"]);
        const res = await fetchTalkSpeak(ws, {
          text: "Hello from plugin talk mode.",
        });
        expect(res.ok, JSON.stringify(res)).toBe(true);
        expect(res.payload?.provider).toBe("acme");
        expect(res.payload?.audioBase64).toBe(Buffer.from([7, 8, 9]).toString("base64"));
      } finally {
        setActivePluginRegistry(previousRegistry);
      }
    });
  });
});
