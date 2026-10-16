/** Tests command-scoped secret resolution from active runtime snapshots. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveCommandSecretsFromActiveRuntimeSnapshot,
  resolveWebSearchProviderForRun,
} from "./runtime-command-secrets.js";
import { createEmptyRuntimeWebToolsMetadata } from "./runtime-fast-path.js";
import {
  activateSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotState,
} from "./runtime-state.js";
import { activateSecretsRuntimeSnapshot, clearSecretsRuntimeSnapshot } from "./runtime.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";
import { discoverConfigSecretTargetsByIds } from "./target-registry.js";

const firecrawlPath = "plugins.entries.firecrawl.config.webSearch.apiKey";
const forcedFallbackConfig = {
  tools: {
    web: {
      search: { enabled: false, provider: "brave" },
      fetch: { provider: "firecrawl" },
    },
  },
  plugins: {
    entries: {
      firecrawl: {
        enabled: true,
        config: {
          webSearch: {
            apiKey: {
              source: "env",
              provider: "default",
              id: "FIRECRAWL_API_KEY",
            },
          },
        },
      },
    },
  },
} as OpenClawConfig;
const forcedWebProviderConfig = {
  tools: {
    web: {
      search: { enabled: true, provider: "exa" },
    },
  },
  plugins: {
    entries: {
      firecrawl: {
        enabled: false,
        config: {
          webSearch: {
            apiKey: {
              source: "env",
              provider: "default",
              id: "FIRECRAWL_API_KEY",
            },
          },
        },
      },
    },
  },
} as OpenClawConfig;

discoverConfigSecretTargetsByIds(forcedFallbackConfig, new Set([firecrawlPath]));

function activateMinimalSecretsRuntimeSnapshot(params: {
  config: OpenClawConfig;
  resolvedConfig?: OpenClawConfig;
  env: Record<string, string | undefined>;
}) {
  const snapshot = {
    sourceConfig: structuredClone(params.config),
    config: structuredClone(params.resolvedConfig ?? params.config),
    authStores: [],
    authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
    authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
    warnings: [],
    webTools: createEmptyRuntimeWebToolsMetadata(),
  };
  activateSecretsRuntimeSnapshotState({
    snapshot,
    refreshContext: {
      env: params.env,
      explicitAgentDirs: null,
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    },
    refreshHandler: null,
  });
}

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("runtime command secrets", () => {
  it("resolves a run-only non-env SecretRef without publishing it or resolving fetch", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "run-search-secret-"));
    try {
      const secretPath = path.join(dir, "secret.json");
      await fs.writeFile(secretPath, JSON.stringify({ key: "synthetic-file-search-key" }), {
        mode: 0o600,
      });
      const config: OpenClawConfig = {
        secrets: { providers: { fixture: { source: "file", path: secretPath, mode: "json" } } },
        tools: { web: { search: { provider: "duckduckgo" }, fetch: { provider: "firecrawl" } } },
        plugins: {
          entries: {
            brave: {
              enabled: true,
              config: {
                webSearch: { apiKey: { source: "file", provider: "fixture", id: "/key" } },
              },
            },
            firecrawl: {
              enabled: true,
              config: {
                webFetch: { apiKey: { source: "file", provider: "fixture", id: "/missing-fetch" } },
              },
            },
          },
        },
      };
      const original = structuredClone(config);
      activateMinimalSecretsRuntimeSnapshot({ config, env: {} });
      const activeBefore = structuredClone(getActiveSecretsRuntimeSnapshotState());
      const scoped = await resolveWebSearchProviderForRun({ config, providerId: "brave" });
      expect(scoped.runtimeWebSearch).toMatchObject({
        selectedProvider: "brave",
        selectedProviderKeySource: "secretRef",
      });
      expect(scoped.config.plugins?.entries?.brave?.config?.webSearch).toEqual({
        apiKey: "synthetic-file-search-key",
      });
      expect(config).toEqual(original);
      expect(getActiveSecretsRuntimeSnapshotState()).toEqual(activeBefore);
      await fs.writeFile(secretPath, "{}", { mode: 0o600 });
      await expect(
        resolveWebSearchProviderForRun({ config, providerId: "brave" }),
      ).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a selected provider with missing credentials before execution", async () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          brave: {
            enabled: true,
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "MISSING_RUN_SEARCH_FIXTURE" },
              },
            },
          },
        },
      },
    };
    activateMinimalSecretsRuntimeSnapshot({ config, env: {} });
    await expect(resolveWebSearchProviderForRun({ config, providerId: "brave" })).rejects.toThrow();
  });

  const previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  const previousTrustBundledPluginsDir = process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    if (previousBundledPluginsDir === undefined) {
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = previousBundledPluginsDir;
    }
    if (previousTrustBundledPluginsDir === undefined) {
      delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = previousTrustBundledPluginsDir;
    }
  });

  it("returns forced fallback assignments from the active gateway snapshot", async () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "extensions";
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
    activateMinimalSecretsRuntimeSnapshot({
      config: forcedFallbackConfig,
      env: {
        FIRECRAWL_API_KEY: "gateway-only-firecrawl-key",
        HOME: process.env.HOME,
        OPENCLAW_BUNDLED_PLUGINS_DIR: "extensions",
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      },
    });

    const resolved = await resolveCommandSecretsFromActiveRuntimeSnapshot({
      commandName: "infer web fetch",
      targetIds: new Set([firecrawlPath]),
      forcedActivePaths: new Set([firecrawlPath]),
    });

    expect(resolved.assignments).toMatchObject([
      {
        path: "plugins.entries.firecrawl.config.webSearch.apiKey",
        value: "gateway-only-firecrawl-key",
      },
    ]);
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.inactiveRefPaths).toEqual([]);
  });

  it("re-resolves forced command-selected web provider paths with gateway env", async () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "extensions";
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
    activateMinimalSecretsRuntimeSnapshot({
      config: forcedWebProviderConfig,
      env: {
        FIRECRAWL_API_KEY: "gateway-selected-firecrawl-key",
        HOME: process.env.HOME,
        OPENCLAW_BUNDLED_PLUGINS_DIR: "extensions",
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      },
    });

    const resolved = await resolveCommandSecretsFromActiveRuntimeSnapshot({
      commandName: "infer web search",
      targetIds: new Set([firecrawlPath]),
      allowedPaths: new Set([firecrawlPath]),
      forcedActivePaths: new Set([firecrawlPath]),
    });

    expect(resolved.assignments).toMatchObject([
      {
        path: firecrawlPath,
        value: "gateway-selected-firecrawl-key",
      },
    ]);
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.inactiveRefPaths).toEqual([]);
  });

  it("returns authoritative assignments from an incomplete runtime snapshot", async () => {
    const sourceConfig = asConfig({
      talk: {
        providers: {
          gateway: {
            apiKey: { source: "env", provider: "default", id: "GATEWAY_TALK_KEY" },
          },
          local: {
            apiKey: { source: "env", provider: "default", id: "LOCAL_TALK_KEY" },
          },
        },
      },
    });
    const resolvedConfig = structuredClone(sourceConfig);
    resolvedConfig.talk!.providers!.gateway!.apiKey = "gateway-owned-key";
    activateMinimalSecretsRuntimeSnapshot({
      config: sourceConfig,
      resolvedConfig,
      env: {},
    });

    const resolved = await resolveCommandSecretsFromActiveRuntimeSnapshot({
      commandName: "reply",
      targetIds: new Set(["talk.providers.*.apiKey"]),
    });

    expect(resolved.assignments).toEqual([
      {
        path: "talk.providers.gateway.apiKey",
        pathSegments: ["talk", "providers", "gateway", "apiKey"],
        value: "gateway-owned-key",
      },
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "serves an exec SecretRef materialized during runtime preparation",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-command-secret-exec-"));
      try {
        const resolverPath = path.join(root, "resolver.sh");
        await fs.writeFile(
          resolverPath,
          [
            "#!/bin/sh",
            "cat >/dev/null",
            'printf \'{"protocolVersion":1,"values":{"talk/key":"gateway-exec-key"}}\'',
          ].join("\n"),
          { mode: 0o700 },
        );
        const config = asConfig({
          secrets: {
            providers: {
              command: {
                source: "exec",
                command: resolverPath,
                jsonOnly: true,
              },
            },
          },
          talk: {
            providers: {
              acme: {
                apiKey: { source: "exec", provider: "command", id: "talk/key" },
              },
            },
          },
        });
        const snapshot = await prepareSecretsRuntimeSnapshot({
          config,
          agentDirs: [path.join(root, "agent")],
          loadAuthStore: () => ({ version: 1, profiles: {} }),
        });
        activateSecretsRuntimeSnapshot(snapshot);

        const resolved = await resolveCommandSecretsFromActiveRuntimeSnapshot({
          commandName: "reply",
          targetIds: new Set(["talk.providers.*.apiKey"]),
        });

        expect(resolved.assignments).toMatchObject([
          { path: "talk.providers.acme.apiKey", value: "gateway-exec-key" },
        ]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
