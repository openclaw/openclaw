/** Tests command-scoped secret resolution from active runtime snapshots. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { resolveCommandSecretsFromActiveRuntimeSnapshot } from "./runtime-command-secrets.js";
import { createEmptyRuntimeWebToolsMetadata } from "./runtime-fast-path.js";
import { activateSecretsRuntimeSnapshotState } from "./runtime-state.js";
import { activateSecretsRuntimeSnapshot } from "./runtime.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";
import { discoverConfigSecretTargetsByIds } from "./target-registry.js";

const firecrawlPath = "plugins.entries.firecrawl.config.webSearch.apiKey";
function webConfig(
  web: NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>,
  enabled: boolean,
) {
  return asConfig({
    tools: { web },
    plugins: {
      entries: {
        firecrawl: {
          enabled,
          config: {
            webSearch: { apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" } },
          },
        },
      },
    },
  });
}
const forcedFallbackConfig = webConfig(
  {
    search: { enabled: false, provider: "brave" },
    fetch: { provider: "firecrawl" },
  },
  true,
);
const forcedWebProviderConfig = webConfig({ search: { enabled: true, provider: "exa" } }, false);

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

function activateWebSnapshot(config: OpenClawConfig, key: string) {
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", "extensions");
  vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
  activateMinimalSecretsRuntimeSnapshot({
    config,
    env: {
      FIRECRAWL_API_KEY: key,
      HOME: process.env.HOME,
      OPENCLAW_BUNDLED_PLUGINS_DIR: "extensions",
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    },
  });
}

function expectWebResolution(
  resolved: Awaited<ReturnType<typeof resolveCommandSecretsFromActiveRuntimeSnapshot>>,
  value: string,
) {
  expect(resolved.assignments).toMatchObject([{ path: firecrawlPath, value }]);
  expect(resolved.diagnostics).toEqual([]);
  expect(resolved.inactiveRefPaths).toEqual([]);
}

describe("runtime command secrets", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("returns forced fallback assignments from the active gateway snapshot", async () => {
    activateWebSnapshot(forcedFallbackConfig, "gateway-only-firecrawl-key");

    const resolved = await resolveCommandSecretsFromActiveRuntimeSnapshot({
      commandName: "infer web fetch",
      targetIds: new Set([firecrawlPath]),
      forcedActivePaths: new Set([firecrawlPath]),
    });

    expectWebResolution(resolved, "gateway-only-firecrawl-key");
  });

  it("re-resolves forced command-selected web provider paths with gateway env", async () => {
    activateWebSnapshot(forcedWebProviderConfig, "gateway-selected-firecrawl-key");

    const resolved = await resolveCommandSecretsFromActiveRuntimeSnapshot({
      commandName: "infer web search",
      targetIds: new Set([firecrawlPath]),
      allowedPaths: new Set([firecrawlPath]),
      forcedActivePaths: new Set([firecrawlPath]),
    });

    expectWebResolution(resolved, "gateway-selected-firecrawl-key");
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
    () =>
      withTempDir("openclaw-command-secret-exec-", async (root) => {
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
      }),
  );
});
