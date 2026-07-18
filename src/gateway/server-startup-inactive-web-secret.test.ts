/** Gateway startup coverage for active and inactive web-provider SecretRefs. */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { getFreePort, installGatewayTestHooks, startGatewayServer } from "./test-helpers.js";

const { webSearchProviders } = vi.hoisted(() => {
  const credentialPath = "plugins.entries.google.config.webSearch.apiKey";
  return {
    webSearchProviders: [
      {
        pluginId: "google",
        id: "gemini",
        label: "Gemini",
        hint: "Gateway startup test provider",
        envVars: ["GEMINI_API_KEY"],
        placeholder: "gemini-...",
        signupUrl: "https://example.com/gemini",
        autoDetectOrder: 20,
        credentialPath,
        inactiveSecretPaths: [credentialPath],
        getCredentialValue: (config: { apiKey?: unknown } | undefined) => config?.apiKey,
        setCredentialValue: (config: { apiKey?: unknown }, value: unknown) => {
          config.apiKey = value;
        },
        getConfiguredCredentialValue: (config: OpenClawConfig | undefined) => {
          const pluginConfig = config?.plugins?.entries?.google?.config;
          return pluginConfig && typeof pluginConfig === "object"
            ? (pluginConfig as { webSearch?: { apiKey?: unknown } }).webSearch?.apiKey
            : undefined;
        },
        setConfiguredCredentialValue: () => {},
        createTool: () => null,
      },
    ],
  };
});

vi.mock("./operator-approval-store.js", async () => {
  const actual = await vi.importActual<typeof import("./operator-approval-store.js")>(
    "./operator-approval-store.js",
  );
  return {
    ...actual,
    closeOrphanedOperatorApprovals: vi.fn(() => 0),
    pruneTerminalOperatorApprovals: vi.fn(() => 0),
  };
});

vi.mock("../secrets/runtime-web-tools-manifest.runtime.js", () => ({
  resolveManifestContractPluginIds: ({ contract }: { contract: string }) =>
    contract === "webSearchProviders" ? ["google"] : [],
  resolveManifestContractOwnerPluginId: ({ value }: { value: string }) =>
    value === "gemini" ? "google" : undefined,
  resolveManifestContractPluginIdsByCompatibilityRuntimePath: () => [],
}));

vi.mock("../plugins/web-provider-public-artifacts.explicit.js", () => ({
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts: () => webSearchProviders,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts: () => [],
}));

vi.mock("../secrets/runtime-web-tools-public-artifacts.runtime.js", () => ({
  resolveBundledWebSearchProvidersFromPublicArtifacts: () => webSearchProviders,
  resolveBundledWebFetchProvidersFromPublicArtifacts: () => [],
}));

vi.mock("../secrets/runtime-web-tools-fallback.runtime.js", () => ({
  runtimeWebToolsFallbackProviders: {
    resolvePluginWebSearchProviders: () => webSearchProviders,
    resolvePluginWebFetchProviders: () => [],
  },
}));

const INACTIVE_SECRET_ENV = "OPENCLAW_TEST_INACTIVE_WEB_SEARCH_SECRET";
const ACTIVE_SECRET_ENV = "OPENCLAW_TEST_ACTIVE_WEB_SEARCH_SECRET";
const SECRET_PATH = "plugins.entries.google.config.webSearch.apiKey";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function buildConfig(params: { enabled: boolean; envVar: string }): OpenClawConfig {
  return {
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "none" },
    },
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
    tools: {
      web: {
        search: {
          enabled: params.enabled,
          provider: "gemini",
        },
      },
    },
    plugins: {
      enabled: true,
      entries: {
        google: {
          enabled: true,
          config: {
            webSearch: {
              apiKey: {
                source: "env",
                provider: "default",
                id: params.envVar,
              },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

async function writeConfig(config: OpenClawConfig): Promise<void> {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile(config);
}

describe("gateway startup web-provider SecretRefs", () => {
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    setActiveDegradedSecretOwners([]);
  });

  it("starts and warns when an unresolved web secret is provably inactive", async () => {
    await withEnvAsync({ [INACTIVE_SECRET_ENV]: undefined }, async () => {
      await writeConfig(buildConfig({ enabled: false, envVar: INACTIVE_SECRET_ENV }));

      server = await startGatewayServer(await getFreePort(), { auth: { mode: "none" } });

      expect(getActiveSecretsRuntimeSnapshot()?.warnings).toContainEqual(
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: SECRET_PATH,
        }),
      );
    });
  });

  it("starts with only the explicit active web provider unavailable", async () => {
    await withEnvAsync(
      {
        [ACTIVE_SECRET_ENV]: undefined,
        GEMINI_API_KEY: "test-gemini-api-key",
      },
      async () => {
        await writeConfig(buildConfig({ enabled: true, envVar: ACTIVE_SECRET_ENV }));

        server = await startGatewayServer(await getFreePort(), { auth: { mode: "none" } });

        const snapshot = getActiveSecretsRuntimeSnapshot();
        expect(snapshot?.degradedOwners).toContainEqual(
          expect.objectContaining({
            ownerKind: "capability",
            ownerId: "web-search:gemini",
            state: "unavailable",
            paths: [SECRET_PATH],
          }),
        );
      },
    );
  });

  it("attributes a Vault outage to an unavailable web-search owner", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-gateway-web-provider-outage-");
    const commandPath = path.join(root, "provider.sh");
    const resolverPath = path.resolve("extensions/vault/vault-secret-ref-resolver.js");
    writeFileSync(
      commandPath,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolverPath)}\n`,
      { encoding: "utf8", mode: 0o700 },
    );

    await withEnvAsync({ VAULT_ADDR: "https://vault.example.test" }, async () => {
      await writeConfig({
        ...buildConfig({ enabled: true, envVar: ACTIVE_SECRET_ENV }),
        secrets: {
          providers: {
            vault: { source: "exec", command: commandPath, passEnv: ["PATH", "VAULT_ADDR"] },
          },
        },
        plugins: {
          enabled: true,
          entries: {
            google: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: { source: "exec", provider: "vault", id: "web/gemini" },
                },
              },
            },
          },
        },
      } as OpenClawConfig);

      const port = await getFreePort();
      server = await startGatewayServer(port, { auth: { mode: "none" } });
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

      expect(ready.status).toBe(200);
      expect(getActiveSecretsRuntimeSnapshot()?.degradedOwners).toContainEqual(
        expect.objectContaining({
          ownerKind: "capability",
          ownerId: "web-search:gemini",
          providerFailures: [{ source: "exec", provider: "vault" }],
        }),
      );
    });
  });
});
