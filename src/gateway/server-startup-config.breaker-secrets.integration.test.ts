import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../secrets/runtime-telegram.test-support.ts";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import { resolveOpenAIModelRoutes } from "../agents/openai-model-routes.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  asConfig,
  beginSecretsRuntimeIsolationForTest,
  EMPTY_LOADABLE_PLUGIN_ORIGINS,
  endSecretsRuntimeIsolationForTest,
  loadAuthStoreWithProfiles,
  SECRETS_RUNTIME_INTEGRATION_TIMEOUT_MS,
  type SecretsRuntimeEnvSnapshot,
} from "../secrets/runtime.integration.test-helpers.js";
import {
  activateSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { prepareGatewayStartupConfig } from "./server-startup-config-helpers.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";
import { buildTestConfigSnapshot } from "./test-helpers.config-snapshots.js";

const GATEWAY_ENV = "BREAKER_GATEWAY_AUTH_TOKEN";
const CHANNEL_ENV = "BREAKER_TELEGRAM_BOT_TOKEN";
const envRef = (id: string) => ({ source: "env", provider: "default", id }) as const;
const model = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
};
const gatewayAuth = (token: unknown) => ({
  gateway: { auth: { mode: "token", token } },
  secrets: { providers: { default: { source: "env" } } },
});
function expectTokens(config: OpenClawConfig, gateway: unknown, channel: unknown) {
  expect(config.gateway?.auth?.token).toEqual(gateway);
  expect(config.channels?.telegram?.botToken).toEqual(channel);
}

function stubEnv(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
}

function startupSnapshot(source: OpenClawConfig, config = source) {
  return {
    ...buildTestConfigSnapshot({
      path: "/tmp/openclaw-startup-model-routes.json",
      exists: true,
      raw: JSON.stringify(source),
      parsed: source,
      valid: true,
      config,
      issues: [],
      legacyIssues: [],
    }),
    sourceConfig: source,
  };
}

let envSnapshot: SecretsRuntimeEnvSnapshot;
beforeEach(() => {
  envSnapshot = beginSecretsRuntimeIsolationForTest();
});
afterEach(() => {
  endSecretsRuntimeIsolationForTest(envSnapshot);
  vi.unstubAllEnvs();
});

it.each(["provider-ref", "gateway-ref"] as const)(
  "keeps catalog defaults out of authored route policy after %s startup",
  async (credentials) => {
    stubEnv({
      [GATEWAY_ENV]: "resolved-gateway-token",
      OPENAI_BASE_URL: undefined,
      ROUTE_KEY: "synthetic-api-key",
    });
    const token = credentials === "gateway-ref" ? envRef(GATEWAY_ENV) : "startup-test-token";
    const apiKey = credentials === "provider-ref" ? envRef("ROUTE_KEY") : "synthetic-api-key";
    const source = asConfig({
      ...gatewayAuth(token),
      models: { providers: { openai: { apiKey, models: [{ ...model }] } } },
    });
    const runtime = structuredClone(source);
    const compat = { supportsTemperature: false, codeMode: "preferred" } as const;
    runtime.models!.providers!.openai!.models[0]!.compat = compat;
    await prepareGatewayStartupConfig({
      configSnapshot: startupSnapshot(source, runtime),
      activateRuntimeSecrets: createRuntimeSecretsActivator({
        logSecrets: createInfoWarnErrorLogger(),
        emitStateEvent: vi.fn(),
        manifestRegistry: { plugins: [] },
      }),
    });
    const published = getRuntimeConfigSnapshot()!;
    expect(published.models?.providers?.openai?.models[0]?.compat).toEqual(compat);
    expect(
      resolveOpenAIModelRoutes({
        provider: "openai",
        modelId: "gpt-5.6-sol",
        config: published,
        env: {},
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [
        {
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex", "agentsapi"] },
        },
      ],
    });
  },
);

it(
  "keeps unavailable channel owners isolated in the active startup config",
  async () => {
    stubEnv({
      [GATEWAY_ENV]: "resolved-gateway-token",
      [CHANNEL_ENV]: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_SKIP_CHANNELS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_VERSION: undefined,
    });
    const gatewayTokenRef = envRef(GATEWAY_ENV);
    const channelTokenRef = envRef(CHANNEL_ENV);
    const config = asConfig({
      ...gatewayAuth({ ...gatewayTokenRef }),
      channels: { telegram: { enabled: true, botToken: { ...channelTokenRef } } },
    });
    const activateRuntimeSecrets = createRuntimeSecretsActivator({
      logSecrets: createInfoWarnErrorLogger(),
      emitStateEvent: vi.fn(),
      prepareRuntimeSecretsSnapshot: async (params) =>
        prepareSecretsRuntimeSnapshot({
          ...params,
          agentDirs: ["/tmp/openclaw-agent-main"],
          loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
          loadAuthStore: () => loadAuthStoreWithProfiles({}),
        }),
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshot,
    });
    const startup = await prepareGatewayStartupConfig({
      configSnapshot: startupSnapshot(config),
      activateRuntimeSecrets,
    });
    expectTokens(startup.cfg, "resolved-gateway-token", channelTokenRef);
    const activeStartup = expectDefined(getActiveSecretsRuntimeSnapshot(), "startup snapshot");
    expectTokens(activeStartup.sourceConfig, gatewayTokenRef, channelTokenRef);
    expect(activeStartup.config.channels?.telegram?.botToken).toEqual(channelTokenRef);
    expect(activeStartup.degradedOwners).toMatchObject([
      {
        ownerKind: "account",
        ownerId: "telegram:default",
        state: "unavailable",
        paths: ["channels.telegram.botToken"],
      },
    ]);
    process.env[CHANNEL_ENV] = "restored-channel-token";
    const reloaded = await activateRuntimeSecrets(activeStartup.sourceConfig, {
      reason: "reload",
      activate: true,
    });
    expect(reloaded.sourceConfig.channels?.telegram?.botToken).toEqual(channelTokenRef);
    expectTokens(reloaded.config, "resolved-gateway-token", "restored-channel-token");
    expect(getActiveSecretsRuntimeSnapshot()?.config.channels?.telegram?.botToken).toBe(
      "restored-channel-token",
    );
  },
  SECRETS_RUNTIME_INTEGRATION_TIMEOUT_MS,
);
