import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { validateTalkConfigResult } from "../../packages/gateway-protocol/src/index.js";
import type { TalkConfigResult } from "../../packages/gateway-protocol/src/schema/channels.js";
import { normalizeResolvedSecretInputString } from "../config/types.secrets.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withSpeechProviders } from "./talk/test-helpers.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type GatewaySocket = Awaited<ReturnType<GatewayHarness["openWs"]>>;
type TalkConfig = NonNullable<TalkConfigResult["config"]["talk"]>;
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
afterAll(() => harness.close());

async function withConnection<T>(scopes: string[], run: (ws: GatewaySocket) => Promise<T>) {
  const ws = await harness.openWs();
  try {
    await connectOk(ws, {
      deviceIdentityPath: path.join(
        process.env.OPENCLAW_STATE_DIR!,
        `talk-config-device-${deviceSeq++}`,
        "client",
        "credentials.sqlite",
      ),
      scopes,
      token: "secret",
    });
    return await run(ws);
  } finally {
    ws.close();
  }
}

async function writeTalkConfig(config: { apiKey?: string | typeof secretRef; voiceId?: string }) {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile({ talk: { provider: PROVIDER, providers: { [PROVIDER]: config } } });
}

async function fetchOkConfig(ws: GatewaySocket, params: Record<string, unknown> = {}) {
  const res = await rpcReq<TalkConfigResult>(ws, "talk.config", params, 60_000);
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  return res.payload;
}

const readConfig = (params: Record<string, unknown> = {}, scopes = ["operator.read"]) =>
  withConnection(scopes, (ws) => fetchOkConfig(ws, params));

function expectProvider(
  talk: TalkConfig | undefined,
  voiceId: string | undefined,
  sourceKey: unknown,
  resolvedKey: unknown = sourceKey,
) {
  expect([talk?.provider, talk?.resolved?.provider]).toEqual([PROVIDER, PROVIDER]);
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

function withSecretRefProvider(run: () => Promise<void>) {
  const provider: SpeechProviderPlugin = {
    id: PROVIDER,
    label: "Acme Speech",
    isConfigured: () => true,
    resolveTalkConfig: ({ talkProviderConfig }) => ({
      ...talkProviderConfig,
      apiKey: normalizeResolvedSecretInputString({
        value: talkProviderConfig.apiKey,
        path: `talk.providers.${PROVIDER}.apiKey`,
      }),
    }),
    synthesize: async () => {
      throw new Error("talk.config must not synthesize audio");
    },
  };
  return withEnvAsync({ [API_ENV]: "env-acme-key" }, () =>
    withSpeechProviders([{ pluginId: "acme-talk-test", source: "test", provider }], run),
  );
}

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
  const payload = await readConfig();
  expectProvider(payload?.config.talk, "voice-123", redacted);
  expect(payload?.config).toMatchObject({
    talk: { speechLocale: "ru-RU", silenceTimeoutMs: 1500 },
    session: { mainKey: "main-test" },
    ui: { seamColor: "#112233" },
  });
});

it.each([
  ["yes", { message: expect.stringContaining("invalid talk.config params") }],
  [
    true,
    {
      code: "FORBIDDEN",
      message: "missing scope: operator.talk.secrets",
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.talk.secrets",
        requiredScopes: ["operator.read", "operator.talk.secrets"],
      },
    },
  ],
] as const)("rejects includeSecrets=%s with only read scope", async (includeSecrets, error) => {
  await writeTalkConfig({ apiKey: "secret-key-abc" });
  const response = await withConnection(["operator.read"], (ws) =>
    rpcReq<TalkConfigResult>(ws, "talk.config", { includeSecrets }, 60_000),
  );
  expect(response).toMatchObject({ ok: false, error });
});

it("returns secrets for operator.admin scope", async () => {
  await writeTalkConfig({ apiKey: "secret-key-abc" });
  const payload = await readConfig({ includeSecrets: true }, ["operator.read", "operator.admin"]);
  expectProvider(payload?.config.talk, undefined, redacted, "secret-key-abc");
});

it("redacts SecretRef apiKey after strict provider resolver accepts it", async () => {
  // #72496: provider resolvers must receive materialized secrets; read scope still gets redaction.
  await writeTalkConfig({ apiKey: secretRef, voiceId: "voice-secretref" });
  await withSecretRefProvider(async () => {
    const payload = await readConfig();
    expectProvider(payload?.config.talk, "voice-secretref", {
      id: redacted,
      provider: redacted,
      source: redacted,
    });
    await withConnection(
      ["operator.read", "operator.write", "operator.talk.secrets"],
      async (ws) => {
        const secrets = await import("../secrets/runtime.js");
        const snapshot = await secrets.prepareSecretsRuntimeSnapshot({
          config: (await (await import("../config/config.js")).readConfigFileSnapshot()).config,
          env: process.env,
          includeAuthStoreRefs: false,
          loadablePluginOrigins: new Map(),
        });
        const response = fetchOkConfig(ws, { includeSecrets: true });
        secrets.activateSecretsRuntimeSnapshot(snapshot);
        const secretPayload = await response;
        expect(validateTalkConfigResult(secretPayload)).toBe(true);
        expectProvider(secretPayload?.config.talk, "voice-secretref", secretRef, "env-acme-key");
      },
    );
  });
});
