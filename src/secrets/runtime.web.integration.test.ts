import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  loadConfig,
  writeConfigFile,
} from "../config/config.js";
import { withTempHome } from "../config/home-env.test-harness.js";
import { captureEnv } from "../test-utils/env.js";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  SECRETS_RUNTIME_INTEGRATION_TIMEOUT_MS,
} from "./runtime.integration.test-helpers.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveRuntimeWebToolsMetadata,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "./runtime.js";

vi.unmock("../version.js");

describe("secrets runtime snapshot web integration", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_BUNDLED_PLUGINS_DIR",
      "OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE",
      "OPENCLAW_VERSION",
    ]);
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    process.env.OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE = "1";
    delete process.env.OPENCLAW_VERSION;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    envSnapshot.restore();
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  it(
    "keeps last-known-good web runtime snapshot when reload introduces unresolved active web refs",
    async () => {
      await withTempHome("openclaw-secrets-runtime-web-reload-lkg-", async (home) => {
        const prepared = await prepareSecretsRuntimeSnapshot({
          config: asConfig({
            tools: {
              web: {
                search: {
                  provider: "gemini",
                },
              },
            },
            plugins: {
              entries: {
                google: {
                  config: {
                    webSearch: {
                      apiKey: {
                        source: "env",
                        provider: "default",
                        id: "WEB_SEARCH_GEMINI_API_KEY",
                      },
                    },
                  },
                },
              },
            },
          }),
          env: {
            WEB_SEARCH_GEMINI_API_KEY: "web-search-gemini-runtime-key",
          },
          agentDirs: ["/tmp/openclaw-agent-main"],
          loadAuthStore: () => loadAuthStoreWithProfiles({}),
        });

        activateSecretsRuntimeSnapshot(prepared);

        await expect(
          writeConfigFile({
            ...loadConfig(),
            plugins: {
              entries: {
                google: {
                  config: {
                    webSearch: {
                      apiKey: {
                        source: "env",
                        provider: "default",
                        id: "MISSING_WEB_SEARCH_GEMINI_API_KEY",
                      },
                    },
                  },
                },
              },
            },
            tools: {
              web: {
                search: {
                  provider: "gemini",
                },
              },
            },
          }),
        ).rejects.toThrow(
          /runtime snapshot refresh failed: .*WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK/i,
        );

        const activeAfterFailure = getActiveSecretsRuntimeSnapshot();
        expect(activeAfterFailure).not.toBeNull();
        const loadedGoogleWebSearchConfig = loadConfig().plugins?.entries?.google?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined;
        expect(loadedGoogleWebSearchConfig?.webSearch?.apiKey).toBe(
          "web-search-gemini-runtime-key",
        );
        const activeSourceGoogleWebSearchConfig = activeAfterFailure?.sourceConfig.plugins?.entries
          ?.google?.config as { webSearch?: { apiKey?: unknown } } | undefined;
        expect(activeSourceGoogleWebSearchConfig?.webSearch?.apiKey).toEqual({
          source: "env",
          provider: "default",
          id: "WEB_SEARCH_GEMINI_API_KEY",
        });
        expect(getActiveRuntimeWebToolsMetadata()?.search.selectedProvider).toBe("gemini");

        const persistedConfig = JSON.parse(
          await fs.readFile(path.join(home, ".openclaw", "openclaw.json"), "utf8"),
        ) as OpenClawConfig;
        const persistedGoogleWebSearchConfig = persistedConfig.plugins?.entries?.google?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined;
        expect(persistedGoogleWebSearchConfig?.webSearch?.apiKey).toEqual({
          source: "env",
          provider: "default",
          id: "MISSING_WEB_SEARCH_GEMINI_API_KEY",
        });
      });
    },
    SECRETS_RUNTIME_INTEGRATION_TIMEOUT_MS,
  );
});
