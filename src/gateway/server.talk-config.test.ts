import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDeviceAuthPayload } from "../../packages/gateway-client/src/device-auth.js";
import { validateTalkConfigResult } from "../../packages/gateway-protocol/src/index.js";
import type { TalkConfigResult } from "../../packages/gateway-protocol/src/schema/channels.js";
import { normalizeResolvedSecretInputString } from "../config/types.secrets.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withSpeechProviders } from "./talk/test-helpers.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  readConnectChallengeNonce,
  rpcReq,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type GatewaySocket = Awaited<ReturnType<GatewayHarness["openWs"]>>;
type TalkConfig = NonNullable<TalkConfigResult["config"]["talk"]>;
type SpeechProvider = Parameters<typeof withSpeechProviders>[0][number]["provider"];
const PROVIDER = "acme";
const API_ENV = "ACME_SPEECH_API_KEY";
const secretRef = { source: "env", provider: "default", id: API_ENV } as const;
const redacted = "__OPENCLAW_REDACTED__";
let harness: GatewayHarness;
let deviceSeq = 0;

beforeAll(async () => {
  harness = await createGatewaySuiteHarness({
    serverOptions: { auth: { mode: "token", token: "secret" } },
  });
});
afterAll(async () => {
  await harness.close();
});

async function withConnection(scopes: string[], run: (ws: GatewaySocket) => Promise<void>) {
  const ws = await harness.openWs();
  try {
    const nonce = await readConnectChallengeNonce(ws);
    expect(nonce).toBeTypeOf("string");
    expect(String(nonce).length).toBeGreaterThan(0);
    const identity = loadOrCreateDeviceIdentity({
      path: path.join(
        os.tmpdir(),
        `openclaw-talk-config-device-${process.pid}-${deviceSeq++}.sqlite`,
      ),
    });
    const signedAt = Date.now();
    const payload = buildDeviceAuthPayload({
      deviceId: identity.deviceId,
      clientId: "test",
      clientMode: "test",
      role: "operator",
      scopes,
      signedAtMs: signedAt,
      token: "secret",
      nonce: String(nonce),
    });
    await connectOk(ws, {
      token: "secret",
      scopes,
      device: {
        id: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        signature: signDevicePayload(identity.privateKeyPem, payload),
        signedAt,
        nonce: String(nonce),
      },
    });
    await run(ws);
  } finally {
    ws.close();
  }
}

async function writeTalkConfig(config: { apiKey?: string | typeof secretRef; voiceId?: string }) {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile({ talk: { provider: PROVIDER, providers: { [PROVIDER]: config } } });
}

async function fetchConfig(ws: GatewaySocket, params: Record<string, unknown> = {}) {
  return rpcReq<TalkConfigResult>(ws, "talk.config", params, 60_000);
}

async function fetchOkConfig(ws: GatewaySocket, params: Record<string, unknown> = {}) {
  const res = await fetchConfig(ws, params);
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  return res.payload;
}

function expectProvider(
  talk: TalkConfig | undefined,
  voiceId: string | undefined,
  sourceKey: unknown,
  resolvedKey: unknown = sourceKey,
) {
  expect(talk?.provider).toBe(PROVIDER);
  expect(talk?.resolved?.provider).toBe(PROVIDER);
  for (const config of [talk?.providers?.[PROVIDER], talk?.resolved?.config]) {
    if (voiceId === undefined) {
      expect(config).not.toHaveProperty("voiceId");
    } else {
      expect(config).toHaveProperty("voiceId", voiceId);
    }
  }
  expect(talk?.providers?.[PROVIDER]?.apiKey).toEqual(sourceKey);
  expect(talk?.resolved?.config?.apiKey).toEqual(resolvedKey);
}

function withProvider(
  resolveTalkConfig: SpeechProvider["resolveTalkConfig"],
  run: () => Promise<void>,
) {
  return withSpeechProviders(
    [
      {
        pluginId: "acme-talk-test",
        source: "test",
        provider: {
          id: PROVIDER,
          label: "Acme Speech",
          isConfigured: () => true,
          resolveTalkConfig,
          synthesize: async () => ({
            audioBuffer: Buffer.from([1]),
            outputFormat: "mp3",
            fileExtension: ".mp3",
            voiceCompatible: false,
          }),
        },
      },
    ],
    run,
  );
}

describe("gateway talk.config", () => {
  it("returns redacted talk config for read scope", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        provider: PROVIDER,
        providers: { [PROVIDER]: { voiceId: "voice-123", apiKey: "secret-key-abc" } },
        speechLocale: "ru-RU",
        silenceTimeoutMs: 1500,
      },
      session: { mainKey: "main-test" },
      ui: { seamColor: "#112233" },
    });
    await withConnection(["operator.read"], async (ws) => {
      const payload = await fetchOkConfig(ws);
      expectProvider(payload?.config.talk, "voice-123", redacted);
      expect(payload?.config).toMatchObject({
        talk: { speechLocale: "ru-RU", silenceTimeoutMs: 1500 },
        session: { mainKey: "main-test" },
        ui: { seamColor: "#112233" },
      });
    });
  });

  it("rejects invalid talk.config params", async () => {
    await writeTalkConfig({ apiKey: "secret-key-abc" });
    await withConnection(["operator.read"], async (ws) => {
      const res = await fetchConfig(ws, { includeSecrets: "yes" });
      expect(res.ok).toBe(false);
      expect(res.error?.message).toContain("invalid talk.config params");
    });
  });

  it("requires operator.talk.secrets for includeSecrets", async () => {
    await writeTalkConfig({ apiKey: "secret-key-abc" });
    await withConnection(["operator.read"], async (ws) => {
      const res = await fetchConfig(ws, { includeSecrets: true });
      expect(res.ok).toBe(false);
      expect(res.error).toMatchObject({
        code: "FORBIDDEN",
        message: "missing scope: operator.talk.secrets",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.talk.secrets",
          requiredScopes: ["operator.read", "operator.talk.secrets"],
        },
      });
    });
  });

  it("returns secrets for operator.admin scope", async () => {
    await writeTalkConfig({ apiKey: "secret-key-abc" });
    await withConnection(["operator.read", "operator.admin"], async (ws) => {
      const payload = await fetchOkConfig(ws, { includeSecrets: true });
      expectProvider(payload?.config.talk, undefined, redacted, "secret-key-abc");
    });
  });

  it("redacts SecretRef apiKey after strict provider resolver accepts it", async () => {
    // #72496: provider resolvers must receive materialized secrets; read scope still gets redaction.
    await writeTalkConfig({ apiKey: secretRef, voiceId: "voice-secretref" });
    await withEnvAsync({ [API_ENV]: "env-acme-key" }, async () => {
      await withProvider(
        ({ talkProviderConfig }) => {
          const apiKey = normalizeResolvedSecretInputString({
            value: talkProviderConfig.apiKey,
            path: `talk.providers.${PROVIDER}.apiKey`,
          });
          return { ...talkProviderConfig, ...(apiKey === undefined ? {} : { apiKey }) };
        },
        async () => {
          await withConnection(["operator.read"], async (ws) => {
            const payload = await fetchOkConfig(ws);
            expectProvider(payload?.config.talk, "voice-secretref", {
              id: redacted,
              provider: redacted,
              source: redacted,
            });
          });
          await withConnection(
            ["operator.read", "operator.write", "operator.talk.secrets"],
            async (ws) => {
              const secrets = await import("../secrets/runtime.js");
              const snapshot = await secrets.prepareSecretsRuntimeSnapshot({
                config: (await (await import("../config/config.js")).readConfigFileSnapshot())
                  .config,
                env: process.env,
                includeAuthStoreRefs: false,
                loadablePluginOrigins: new Map(),
              });
              const response = fetchOkConfig(ws, { includeSecrets: true });
              secrets.activateSecretsRuntimeSnapshot(snapshot);
              const payload = await response;
              expect(validateTalkConfigResult(payload)).toBe(true);
              expectProvider(payload?.config.talk, "voice-secretref", secretRef, "env-acme-key");
            },
          );
        },
      );
    });
  });
});
