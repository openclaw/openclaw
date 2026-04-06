import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import { validateTalkConfigResult } from "./protocol/index.js";
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
const TALK_CONFIG_DEVICE_PATH = path.join(
  os.tmpdir(),
  `openclaw-talk-config-device-${process.pid}.json`,
);
const TALK_CONFIG_DEVICE = loadOrCreateDeviceIdentity(TALK_CONFIG_DEVICE_PATH);
const GENERIC_TALK_PROVIDER_ID = "acme";
const GENERIC_TALK_API_ENV = "ACME_SPEECH_API_KEY";

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
});
