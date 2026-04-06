import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { loadConfig } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  asConfig,
  beginSecretsRuntimeIsolationForTest,
  EMPTY_LOADABLE_PLUGIN_ORIGINS,
  endSecretsRuntimeIsolationForTest,
  loadAuthStoreWithProfiles,
  OPENAI_ENV_KEY_REF,
  type SecretsRuntimeEnvSnapshot,
} from "./runtime-auth.integration.test-helpers.js";
import { activateSecretsRuntimeSnapshot, prepareSecretsRuntimeSnapshot } from "./runtime.js";

vi.unmock("../version.js");

describe("secrets runtime snapshot activation", () => {
  let envSnapshot: SecretsRuntimeEnvSnapshot;

  beforeEach(() => {
    envSnapshot = beginSecretsRuntimeIsolationForTest();
  });

  afterEach(() => {
    endSecretsRuntimeIsolationForTest(envSnapshot);
  });

  async function prepareOpenAiRuntimeSnapshot() {
    return withEnvAsync(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
        OPENCLAW_VERSION: undefined,
      },
      async () =>
        prepareSecretsRuntimeSnapshot({
          config: asConfig({
            models: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: OPENAI_ENV_KEY_REF,
                  models: [],
                },
              },
            },
          }),
          env: { OPENAI_API_KEY: "sk-runtime" },
          agentDirs: ["/tmp/openclaw-agent-main"],
          loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
          loadAuthStore: () =>
            loadAuthStoreWithProfiles({
              "openai:default": {
                type: "api_key",
                provider: "openai",
                keyRef: OPENAI_ENV_KEY_REF,
              },
            }),
        }),
    );
  }

  it("activates runtime snapshots for loadConfig", async () => {
    const prepared = await prepareOpenAiRuntimeSnapshot();
    activateSecretsRuntimeSnapshot(prepared);

    expect(loadConfig().models?.providers?.openai?.apiKey).toBe("sk-runtime");
  });

  it("activates runtime snapshots for ensureAuthProfileStore", async () => {
    const prepared = await prepareOpenAiRuntimeSnapshot();
    activateSecretsRuntimeSnapshot(prepared);

    expect(
      ensureAuthProfileStore("/tmp/openclaw-agent-main").profiles["openai:default"],
    ).toMatchObject({
      type: "api_key",
      key: "sk-runtime",
    });
  });
});
