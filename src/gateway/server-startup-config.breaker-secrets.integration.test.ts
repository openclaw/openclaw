import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../secrets/runtime-telegram.test-support.ts";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
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
import { withEnvAsync } from "../test-utils/env.js";
import { prepareGatewayStartupConfig } from "./server-startup-config-helpers.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";
import { buildTestConfigSnapshot } from "./test-helpers.config-snapshots.js";

const GATEWAY_TOKEN_ENV = "BREAKER_GATEWAY_AUTH_TOKEN";
const CHANNEL_TOKEN_ENV = "BREAKER_TELEGRAM_BOT_TOKEN";
const envRef = (id: string) => ({ source: "env", provider: "default", id }) as const;

describe("gateway breaker SecretRef integration", () => {
  let envSnapshot: SecretsRuntimeEnvSnapshot;
  beforeEach(() => {
    envSnapshot = beginSecretsRuntimeIsolationForTest();
  });
  afterEach(() => {
    endSecretsRuntimeIsolationForTest(envSnapshot);
  });

  it(
    "keeps unavailable channel owners isolated in the active startup config",
    async () => {
      await withEnvAsync(
        {
          [GATEWAY_TOKEN_ENV]: "resolved-gateway-token",
          [CHANNEL_TOKEN_ENV]: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
          OPENCLAW_SKIP_CHANNELS: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_VERSION: undefined,
        },
        async () => {
          const gatewayTokenRef = envRef(GATEWAY_TOKEN_ENV);
          const channelTokenRef = envRef(CHANNEL_TOKEN_ENV);
          const config = asConfig({
            secrets: { providers: { default: { source: "env" } } },
            gateway: { auth: { mode: "token", token: { ...gatewayTokenRef } } },
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
            configSnapshot: buildTestConfigSnapshot({
              path: "/tmp/openclaw-breaker-secrets-integration.json",
              exists: true,
              raw: `${JSON.stringify(config, null, 2)}\n`,
              parsed: config,
              valid: true,
              config,
              issues: [],
              legacyIssues: [],
            }),
            activateRuntimeSecrets,
          });
          expect(startup.cfg.gateway?.auth?.token).toBe("resolved-gateway-token");
          expect(startup.cfg.channels?.telegram?.botToken).toEqual(channelTokenRef);
          const activeStartup = getActiveSecretsRuntimeSnapshot();
          if (!activeStartup) {
            throw new Error("Expected an active startup secrets snapshot");
          }
          expect(activeStartup.sourceConfig.gateway?.auth?.token).toEqual(gatewayTokenRef);
          expect(activeStartup.sourceConfig.channels?.telegram?.botToken).toEqual(channelTokenRef);
          expect(activeStartup.config.channels?.telegram?.botToken).toEqual(channelTokenRef);
          expect(activeStartup.degradedOwners).toMatchObject([
            {
              ownerKind: "account",
              ownerId: "telegram:default",
              state: "unavailable",
              paths: ["channels.telegram.botToken"],
            },
          ]);
          process.env[CHANNEL_TOKEN_ENV] = "restored-channel-token";
          const reloaded = await activateRuntimeSecrets(activeStartup.sourceConfig, {
            reason: "reload",
            activate: true,
          });
          expect(reloaded.sourceConfig.channels?.telegram?.botToken).toEqual(channelTokenRef);
          expect(reloaded.config.gateway?.auth?.token).toBe("resolved-gateway-token");
          expect(reloaded.config.channels?.telegram?.botToken).toBe("restored-channel-token");
          expect(getActiveSecretsRuntimeSnapshot()?.config.channels?.telegram?.botToken).toBe(
            "restored-channel-token",
          );
        },
      );
    },
    SECRETS_RUNTIME_INTEGRATION_TIMEOUT_MS,
  );
});
