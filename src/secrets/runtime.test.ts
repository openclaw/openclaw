/** Tests runtime SecretRef resolution across core config and auth-profile surfaces. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.ts";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import { getRuntimeConfigSnapshotRefreshHandler } from "../config/runtime-snapshot.js";
import { redactSensitiveText } from "../logging/redact.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { assertSecretOwnerAvailable } from "./runtime-degraded-state.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshotState,
} from "./runtime-state.js";
import { activateSecretsRuntimeSnapshot } from "./runtime.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const EMPTY_LOADABLE_PLUGIN_ORIGINS = new Map();
const BUNDLED_CODEX_PLUGIN_ORIGINS = new Map([["codex", "bundled" as const]]);
const { prepareSecretsRuntimeSnapshot: prepareSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type SnapshotParams = Parameters<typeof prepareSnapshot>[0];
type Snapshot = Awaited<ReturnType<typeof prepareSnapshot>>;

function prepareSecretsRuntimeSnapshot(params: SnapshotParams) {
  return prepareSnapshot({ includeAuthStoreRefs: false, ...params });
}

function ttsConfig(apiKey: unknown, config: Record<string, unknown> = {}) {
  return asConfig({
    ...explicitMainRoster(),
    ...config,
    tts: { providers: { elevenlabs: { apiKey } } },
  });
}

const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });
const provider = (apiKey: unknown, baseUrl = "https://first.example.invalid/v1") => ({
  apiKey,
  baseUrl,
  models: [],
});
function siblingConfig(firstId: string) {
  return asConfig({
    ...explicitMainRoster(),
    models: {
      providers: {
        first: provider(envRef(firstId)),
        second: provider(envRef("SECOND_KEY"), "https://second.example.invalid/v1"),
      },
    },
  });
}
function activate(snapshot: Snapshot) {
  activateSecretsRuntimeSnapshotState({ snapshot, refreshContext: null, refreshHandler: null });
}
function pluginConfig(id: string, config: Record<string, unknown>) {
  return asConfig({
    ...explicitMainRoster(),
    plugins: { entries: { [id]: { enabled: true, config } } },
  });
}
function codexConfig(literalAuthorization = false) {
  return pluginConfig("codex", {
    appServer: {
      transport: "websocket",
      url: "wss://codex-app-server.example.internal/ws",
      authToken: CODEX_APP_SERVER_TOKEN_REF,
      headers: {
        ...(literalAuthorization ? { Authorization: "Bearer literal-token" } : {}),
        "x-codex-client-session-token": "${CODEX_CLIENT_SESSION_TOKEN}",
      },
    },
  });
}

function explicitMainRoster() {
  return { agents: { entries: { main: {} } } };
}

function sandboxConfig(
  identityData: ReturnType<typeof envRef>,
  entries: Record<string, unknown>,
  { target, ...options }: { mode: string; backend: string; target?: string } = {
    mode: "all",
    backend: "ssh",
    target: "sandbox@example.com:22",
  },
) {
  return asConfig({
    agents: {
      defaults: { sandbox: { ...options, ssh: { ...(target ? { target } : {}), identityData } } },
      entries,
    },
  });
}

const CODEX_APP_SERVER_TOKEN_REF = envRef("CODEX_APP_SERVER_TOKEN");

afterEach(() => {
  resetSecretRedactionRegistryForTest();
  clearSecretsRuntimeSnapshotState();
});

const TTS_REF = envRef("ELEVENLABS_API_KEY");

function expectWarning(snapshot: Snapshot, expected: { code: string; path: string }): void {
  const warning = snapshot.warnings.find(
    (entry) => entry.code === expected.code && entry.path === expected.path,
  );
  if (!warning) {
    throw new Error(`Expected warning ${expected.code} ${expected.path}`);
  }
}

describe("secrets runtime snapshot", () => {
  it("retains resolved credentials for UI edits but re-resolves explicit and changed-input refreshes", async () => {
    const secretFile = path.join(tempDirs.make("openclaw-ui-secret-"), "secrets.json");
    await fs.writeFile(secretFile, JSON.stringify({ apiKey: "prepared-value" }), { mode: 0o600 });
    const config = asConfig({
      ...explicitMainRoster(),
      ui: { prefs: { chatShowToolCalls: false } },
      secrets: { providers: { fixture: { source: "file", path: secretFile, mode: "json" } } },
      models: {
        providers: {
          example: {
            baseUrl: "https://example.invalid/v1",
            apiKey: { source: "file", provider: "fixture", id: "/apiKey" },
            models: [],
          },
        },
      },
    });
    const env = {};
    const initial = await prepareSecretsRuntimeSnapshot({
      config,
      env,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });
    activateSecretsRuntimeSnapshot(initial);
    await fs.writeFile(secretFile, JSON.stringify({ apiKey: "refreshed-value" }));
    const displayConfig = {
      ...config,
      meta: { lastTouchedVersion: "2026.10.11" },
      ui: { prefs: { chatShowToolCalls: true } },
    };
    const displayed = await prepareSecretsRuntimeSnapshot({
      config: displayConfig,
      env,
    });
    expect(displayed.config.models?.providers?.example?.apiKey).toBe("prepared-value");
    expect(displayed.config.ui?.prefs?.chatShowToolCalls).toBe(true);
    expect(displayed.sourceConfig).toEqual(displayConfig);
    expect(displayed.secretOwners).toEqual(initial.secretOwners);
    const refresh = getRuntimeConfigSnapshotRefreshHandler();
    await expect(refresh?.refresh({ sourceConfig: displayConfig })).resolves.toBe(true);

    const changedFacts = structuredClone(displayConfig);
    changedFacts.ui.prefs.chatShowToolCalls = false;
    setConfigResolutionFacts(changedFacts, new Set());
    for (const params of [
      { config: displayConfig, env },
      { config: { ...displayConfig, ui: config.ui }, env: { DISPLAY_REFRESH: "changed" } },
      { config: changedFacts, env },
      {
        config: { ...displayConfig, ui: config.ui },
        env,
        forceColdRefKeys: new Set(["file:fixture:/apiKey"]),
      },
    ]) {
      const refreshed = await prepareSecretsRuntimeSnapshot({
        ...params,
      });
      expect(refreshed.config.models?.providers?.example?.apiKey).toBe("refreshed-value");
    }
  });

  it("refreshes healthy owners while an unchanged failed owner keeps last-known-good", async () => {
    const active = await prepareSecretsRuntimeSnapshot({
      config: siblingConfig("FIRST_KEY"),
      env: { FIRST_KEY: "first-old", SECOND_KEY: "second-old" },
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });
    activate(active);

    const candidate = await prepareSecretsRuntimeSnapshot({
      config: siblingConfig("FIRST_KEY"),
      env: { SECOND_KEY: "second-new" },
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(candidate.config.models?.providers?.first?.apiKey).toBe("first-old");
    expect(candidate.config.models?.providers?.second?.apiKey).toBe("second-new");
    expect(candidate.degradedOwners).toMatchObject([
      { ownerKind: "provider", ownerId: "first", degradationState: "stale" },
    ]);
    activate(candidate);
    expect(() => assertSecretOwnerAvailable("provider", "first")).not.toThrow();
  });

  it("makes a changed unresolved owner cold while healthy siblings refresh", async () => {
    const active = await prepareSecretsRuntimeSnapshot({
      config: siblingConfig("FIRST_KEY"),
      env: { FIRST_KEY: "first-old", SECOND_KEY: "second-old" },
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });
    activate(active);

    const changedRef = envRef("FIRST_KEY_CHANGED");
    const candidate = await prepareSecretsRuntimeSnapshot({
      config: siblingConfig(changedRef.id),
      env: { SECOND_KEY: "second-new" },
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(candidate.config.models?.providers?.first?.apiKey).toEqual(changedRef);
    expect(candidate.config.models?.providers?.second?.apiKey).toBe("second-new");
    expect(candidate.degradedOwners).toMatchObject([
      { ownerKind: "provider", ownerId: "first", degradationState: "cold" },
    ]);
    activate(candidate);
    expect(() => assertSecretOwnerAvailable("provider", "first")).toThrow(
      "configured but unavailable",
    );
  });

  it("does not send a stale provider credential to a changed endpoint", async () => {
    const apiKeyRef = envRef("PROVIDER_KEY");
    const config = (baseUrl: string) =>
      asConfig({
        ...explicitMainRoster(),
        models: {
          providers: {
            first: { apiKey: apiKeyRef, baseUrl, models: [] },
          },
        },
      });
    const active = await prepareSecretsRuntimeSnapshot({
      config: config("https://old.example.invalid/v1"),
      env: { PROVIDER_KEY: "last-known-good" },
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });
    activate(active);

    const candidate = await prepareSecretsRuntimeSnapshot({
      config: config("https://new.example.invalid/v1"),
      env: {},
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(candidate.config.models?.providers?.first).toMatchObject({
      apiKey: apiKeyRef,
      baseUrl: "https://new.example.invalid/v1",
    });
    expect(candidate.degradedOwners).toMatchObject([
      { ownerKind: "provider", ownerId: "first", degradationState: "cold" },
    ]);
  });

  it("isolates one plugin route while resolving its sibling snapshot", async () => {
    const missingRef = envRef("MISSING_WEBHOOK_SECRET");
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: pluginConfig("route-fixture", {
        routes: {
          healthy: {
            sessionKey: "agent:main:main",
            secret: envRef("HEALTHY_WEBHOOK_SECRET"),
          },
          cold: {
            sessionKey: "agent:main:main",
            secret: missingRef,
          },
          inlineCold: {
            sessionKey: "agent:main:main",
            secret: "${MISSING_INLINE_WEBHOOK_SECRET}",
          },
        },
      }),
      env: { HEALTHY_WEBHOOK_SECRET: "healthy-secret" },
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: new Map([["route-fixture", "bundled"]]),
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "route-fixture",
            configContracts: {
              secretInputs: {
                paths: [{ path: "routes.*.secret", expected: "string", ownerKind: "route" }],
              },
            },
          },
        ],
      }),
    });

    const routes = snapshot.config.plugins?.entries?.["route-fixture"]?.config?.routes as Record<
      string,
      { secret?: unknown }
    >;
    expect(routes.healthy?.secret).toBe("healthy-secret");
    expect(routes.cold?.secret).toEqual(missingRef);
    expect(routes.inlineCold?.secret).toEqual(envRef("MISSING_INLINE_WEBHOOK_SECRET"));
    expect(snapshot.degradedOwners).toMatchObject(
      ["cold", "inlineCold"].map((route) => {
        const ownerId = `plugins.entries.route-fixture.config.routes.${route}.secret`;
        return {
          ownerKind: "route",
          ownerId,
          state: "unavailable",
          paths: [ownerId],
          reason: "secret reference was not found",
        };
      }),
    );
  });

  it("registers resolved TTS values for exact redaction", async () => {
    const secret = "test-secret";
    await prepareSecretsRuntimeSnapshot({
      config: ttsConfig(TTS_REF),
      env: { ELEVENLABS_API_KEY: secret },
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(redactSensitiveText(`resolved ${secret}`, { mode: "off" })).toBe("resolved ***");
  });

  it("keeps default SSH lifecycle secrets materialized when every listed agent overrides them", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: sandboxConfig(
        envRef("DEFAULT_SSH_IDENTITY"),
        {
          worker: {
            enabled: false,
            sandbox: {
              ssh: {
                identityData: envRef("WORKER_SSH_IDENTITY"),
              },
            },
          },
        },
        { mode: "off", backend: "ssh", target: "peter@example.com:22" },
      ),
      env: {
        DEFAULT_SSH_IDENTITY: "DEFAULT PRIVATE KEY",
        WORKER_SSH_IDENTITY: "WORKER PRIVATE KEY",
      },
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.agents?.defaults?.sandbox?.ssh?.identityData).toBe(
      "DEFAULT PRIVATE KEY",
    );
    expect(snapshot.config.agents?.entries?.worker?.sandbox?.ssh?.identityData).toBe(
      "WORKER PRIVATE KEY",
    );
  });

  it("isolates only the agent whose inherited sandbox SSH SecretRef is unavailable", async () => {
    const missingRef = envRef("MISSING_COLD_SSH_IDENTITY");
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: sandboxConfig(missingRef, {
        cold: {},
        healthy: {
          sandbox: {
            ssh: {
              identityData: envRef("HEALTHY_SSH_IDENTITY"),
            },
          },
        },
      }),
      env: { HEALTHY_SSH_IDENTITY: "HEALTHY PRIVATE KEY" },
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.agents?.defaults?.sandbox?.ssh?.identityData).toEqual(missingRef);
    expect(snapshot.config.agents?.entries?.healthy?.sandbox?.ssh?.identityData).toBe(
      "HEALTHY PRIVATE KEY",
    );
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "capability",
        ownerId: "agent-sandbox:cold",
        state: "unavailable",
        paths: ["agents.defaults.sandbox.ssh.identityData"],
      },
    ]);
    expectWarning(snapshot, {
      code: "SECRETS_OWNER_UNAVAILABLE",
      path: "agents.defaults.sandbox.ssh.identityData",
    });
  });

  it("treats sandbox ssh secret refs as inactive when ssh backend is not selected", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: sandboxConfig(
        envRef("SSH_IDENTITY_DATA"),
        { main: {} },
        {
          mode: "all",
          backend: "docker",
        },
      ),
      env: {},
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.agents?.defaults?.sandbox?.ssh?.identityData).toEqual(
      envRef("SSH_IDENTITY_DATA"),
    );
    expectWarning(snapshot, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "agents.defaults.sandbox.ssh.identityData",
    });
  });

  it("resolves active bundled Codex app-server plugin SecretRefs", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: codexConfig(true),
      env: {
        CODEX_APP_SERVER_TOKEN: "resolved-app-server-token",
        CODEX_CLIENT_SESSION_TOKEN: "resolved-session-token",
      },
      loadablePluginOrigins: BUNDLED_CODEX_PLUGIN_ORIGINS,
    });

    expect(snapshot.config.plugins?.entries?.codex?.config).toMatchObject({
      appServer: {
        authToken: "resolved-app-server-token",
        headers: {
          Authorization: "Bearer literal-token",
          "x-codex-client-session-token": "resolved-session-token",
        },
      },
    });
  });

  it("fails active bundled Codex app-server plugin SecretRefs when env is missing", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: codexConfig(),
        env: {
          CODEX_CLIENT_SESSION_TOKEN: "resolved-session-token",
        },
        loadablePluginOrigins: BUNDLED_CODEX_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow('Environment variable "CODEX_APP_SERVER_TOKEN" is missing or empty.');
  });

  it("rejects owner isolation after provider policy failures", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: ttsConfig(TTS_REF, {
          secrets: {
            providers: {
              default: {
                source: "env",
                allowlist: ["OTHER_API_KEY"],
              },
            },
          },
        }),
        env: {
          ELEVENLABS_API_KEY: "test-elevenlabs-api-key",
        },
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow("not allowlisted");
  });

  it("keeps unconfigured SecretRef provider aliases fail-closed", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: ttsConfig({ ...TTS_REF, provider: "missing" }),
        env: {},
        allowUnavailableSecretOwners: true,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow('Secret provider "missing" is not configured');
  });

  it("fails when an active exec ref id contains traversal segments", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          ...explicitMainRoster(),
          talk: {
            provider: "example",
            providers: {
              example: { apiKey: { source: "exec", provider: "vault", id: "a/../b" } },
            },
          },
          secrets: {
            providers: {
              vault: {
                source: "exec",
                command: process.execPath,
              },
            },
          },
        }),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      }),
    ).rejects.toThrow(/must not include "\." or "\.\." path segments/i);
  });
});
