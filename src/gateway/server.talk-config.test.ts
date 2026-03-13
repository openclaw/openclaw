import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
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
        elevenlabs?: { voiceId?: string; apiKey?: string | SecretRef };
      };
      resolved?: {
        provider?: string;
        config?: { voiceId?: string; apiKey?: string | SecretRef };
      };
      apiKey?: string | SecretRef;
      voiceId?: string;
      silenceTimeoutMs?: number;
    };
    session?: { mainKey?: string };
    ui?: { seamColor?: string };
  };
};
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
  await writeConfigFile({ talk: config });
}

async function fetchTalkConfig(
  ws: GatewaySocket,
  params?: { includeSecrets?: boolean } | Record<string, unknown>,
) {
  return rpcReq<TalkConfigPayload>(ws, "talk.config", params ?? {});
}

function expectElevenLabsTalkConfig(
  talk: TalkConfigPayload["config"] extends { talk?: infer T } ? T : never,
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
  expect(talk?.voiceId).toBe(expected.voiceId);

  if ("apiKey" in expected) {
    expect(talk?.providers?.elevenlabs?.apiKey).toEqual(expected.apiKey);
    expect(talk?.resolved?.config?.apiKey).toEqual(expected.apiKey);
    expect(talk?.apiKey).toEqual(expected.apiKey);
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
        voiceId: "voice-123",
        apiKey: "secret-key-abc", // pragma: allowlist secret
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

  it("prefers normalized provider payload over conflicting legacy talk keys", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            voiceId: "voice-normalized",
          },
        },
        voiceId: "voice-legacy",
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
});
