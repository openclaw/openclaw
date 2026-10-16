import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { autoMigrateLegacyState } from "../infra/state-migrations.doctor.js";
import { resetAutoMigrateLegacyStateDirForTest } from "../infra/state-migrations.state-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { refreshPersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { prepareLegacySessionSurfaces } from "./legacy-session-surfaces.js";
import { writeJson } from "./loader-suite.test-support.js";
import { clearPluginRegistryLoadCache } from "./loader.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs: string[] = [];

function migrationFixture(name: string) {
  const rootDir = makeTrackedTempDir(`openclaw-session-surface-${name}`, tempDirs);
  const stateDir = path.join(rootDir, "state");
  const bundledDir = path.join(rootDir, "bundled-disabled");
  fs.mkdirSync(bundledDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: rootDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_VERSION: "2026.8.1",
    VITEST: "true",
  };
  const writeOwner = (pluginId: string, channelId: string) =>
    writeSessionSurfacePlugin({ rootDir, stateDir, pluginId, channelId });
  const persist = async (
    config: OpenClawConfig,
    owners: Record<string, ReturnType<typeof writeOwner>>,
  ) => {
    await refreshPersistedInstalledPluginIndex({
      stateDir,
      env,
      config,
      reason: "source-changed",
      installRecords: Object.fromEntries(
        Object.entries(owners).map(([id, owner]) => [
          id,
          {
            source: "npm",
            spec: `@fixture/${id}@1.0.0`,
            installPath: owner.pluginDir,
          },
        ]),
      ),
    });
    clearPluginMetadataLifecycleCaches();
  };
  const migrate = async (config: OpenClawConfig, key: string, sessionId: string) => {
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    writeJson(storePath, { [key]: { sessionId, updatedAt: 1 } });
    const result = await autoMigrateLegacyState({
      cfg: config,
      env,
      homedir: () => rootDir,
      doctorOnlyStateMigrations: true,
    });
    return {
      result,
      migrated: JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, unknown>,
    };
  };
  return { rootDir, stateDir, bundledDir, env, writeOwner, persist, migrate };
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearPluginRegistryLoadCache();
  clearPluginMetadataLifecycleCaches();
  resetAutoMigrateLegacyStateDirForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

function writeSessionSurfacePlugin(params: {
  stateDir: string;
  rootDir: string;
  pluginId: string;
  channelId: string;
  bundledDir?: string;
}) {
  const packageName = `@fixture/${params.pluginId}`;
  const pluginDir = params.bundledDir
    ? path.join(params.bundledDir, params.pluginId)
    : writeManagedNpmPlugin({
        stateDir: params.stateDir,
        packageName,
        pluginId: params.pluginId,
        version: "1.0.0",
      });
  fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
  const marker = (name: string) => path.join(params.rootDir, `${params.pluginId}-${name}.marker`);
  writeJson(path.join(pluginDir, "package.json"), {
    name: packageName,
    version: "1.0.0",
    type: "module",
    openclaw: {
      extensions: ["./dist/index.js"],
      setupEntry: "./dist/setup-entry.js",
      setupFeatures: { legacySessionSurfaces: true },
      channel: {
        id: params.channelId,
        ...(params.bundledDir
          ? {
              persistedAuthState: { specifier: "./dist/auth-presence.js", exportName: "hasAuth" },
            }
          : {}),
      },
    },
  });
  writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
    id: params.pluginId,
    channels: [params.channelId],
    configSchema: { type: "object" },
  });
  fs.writeFileSync(
    path.join(pluginDir, "dist", "index.js"),
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker("full"))}, "loaded\\n");
export default { register() {} };
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "dist", "setup-plugin.js"),
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker("setup-plugin"))}, "loaded\\n");
export const setupPlugin = { id: ${JSON.stringify(params.channelId)} };
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "dist", "legacy-session-surface.js"),
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker("sidecar"))}, "loaded\\n");
export const legacySessionSurface = {
  isLegacyGroupSessionKey(key) { return key.startsWith("fixture-group:"); },
  canonicalizeLegacySessionKey({ key, agentId }) {
    return key.startsWith("fixture-group:")
      ? \`agent:\${agentId}:${params.channelId}:group:\${key.slice("fixture-group:".length).toLowerCase()}\`
      : null;
  },
};
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "dist", "setup-entry.js"),
    `import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";
export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  features: { legacySessionSurfaces: true },
  plugin: { specifier: "./setup-plugin.js", exportName: "setupPlugin" },
  legacySessionSurface: {
    specifier: "./legacy-session-surface.js",
    exportName: "legacySessionSurface",
  },
});
`,
    "utf8",
  );
  if (params.bundledDir) {
    fs.writeFileSync(
      path.join(pluginDir, "dist", "auth-presence.js"),
      `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker("auth-probe"))}, "loaded");
export function hasAuth() { return false; }
`,
    );
  }
  return { pluginDir, marker };
}

describe("installed channel legacy session surfaces", () => {
  it("loads an eligible bundled migration owner without probing its authentication", () => {
    const rootDir = makeTrackedTempDir("openclaw-session-surface-bundled", tempDirs);
    const stateDir = path.join(rootDir, "state");
    fs.mkdirSync(stateDir);
    const bundledDir = path.join(rootDir, "bundled");
    const fixture = writeSessionSurfacePlugin({
      stateDir,
      rootDir,
      bundledDir,
      pluginId: "bundled-session-owner",
      channelId: "bundled-chat",
    });
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "");
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    const env = {
      HOME: rootDir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "",
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      VITEST: "true",
    } as NodeJS.ProcessEnv;
    const prepared = prepareLegacySessionSurfaces({ config: {}, env });

    expect(prepared.failures).toEqual([]);
    expect(prepared.surfaces).toHaveLength(1);
    expect(
      prepared.surfaces[0]?.canonicalizeLegacySessionKey?.({
        key: "fixture-group:Room",
        agentId: "main",
      }),
    ).toBe("agent:main:bundled-chat:group:room");
    expect(fs.existsSync(fixture.marker("sidecar"))).toBe(true);
    expect(fs.existsSync(fixture.marker("setup-plugin"))).toBe(false);
    expect(fs.existsSync(fixture.marker("full"))).toBe(false);
    expect(fs.existsSync(fixture.marker("auth-probe"))).toBe(false);
  });

  it("loads only the selected setup sidecar and canonicalizes its legacy group key", async () => {
    const { rootDir, stateDir, bundledDir, env, writeOwner, persist, migrate } =
      migrationFixture("selected");
    const unrelatedDir = path.join(bundledDir, "unrelated-channel");
    const authProbeMarker = path.join(rootDir, "unrelated-auth-probe.marker");
    fs.mkdirSync(unrelatedDir);
    writeJson(path.join(unrelatedDir, "package.json"), {
      name: "@fixture/unrelated-channel",
      type: "module",
      openclaw: {
        extensions: ["./index.js"],
        channel: {
          id: "unrelated-channel",
          persistedAuthState: { specifier: "./auth-presence.js", exportName: "hasAuth" },
        },
      },
    });
    writeJson(path.join(unrelatedDir, "openclaw.plugin.json"), {
      id: "unrelated-channel",
      channels: ["unrelated-channel"],
      configSchema: { type: "object" },
    });
    fs.writeFileSync(path.join(unrelatedDir, "index.js"), "export default { register() {} };\n");
    fs.writeFileSync(
      path.join(unrelatedDir, "auth-presence.js"),
      `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(authProbeMarker)}, "loaded");
export function hasAuth() { return false; }
`,
    );
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "");
    const selected = writeOwner("fixture-session-owner", "fixture-chat");
    const blocked = writeOwner("blocked-session-owner", "blocked-chat");
    const config = {
      channels: {
        "fixture-chat": { enabled: true },
        "blocked-chat": { enabled: true },
      },
      plugins: {
        allow: ["fixture-session-owner", "blocked-session-owner"],
        entries: {
          "fixture-session-owner": { enabled: true },
          "blocked-session-owner": { enabled: false },
        },
      },
    } as OpenClawConfig;

    await persist(config, { "fixture-session-owner": selected, "blocked-session-owner": blocked });
    const persisted = loadPluginMetadataSnapshot({
      config,
      env,
      stateDir,
    });
    const selectedRecord = persisted.manifestRegistry.plugins.find(
      (record) => record.id === "fixture-session-owner",
    );
    expect(persisted.registrySource).toBe("persisted");
    expect(persisted.index.installRecords["fixture-session-owner"]).toMatchObject({
      source: "npm",
      installPath: selected.pluginDir,
    });
    expect(selectedRecord).toMatchObject({
      origin: "global",
      channels: ["fixture-chat"],
      setupSource: fs.realpathSync(path.join(selected.pluginDir, "dist", "setup-entry.js")),
      packageManifest: { setupFeatures: { legacySessionSurfaces: true } },
    });
    const prepared = prepareLegacySessionSurfaces({ config, env });
    expect(fs.existsSync(authProbeMarker)).toBe(false);
    expect(prepared.failures).toEqual([]);
    expect(prepared.surfaces).toHaveLength(1);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.surfaces)).toBe(true);
    expect(Object.isFrozen(prepared.failures)).toBe(true);
    const { result, migrated } = await migrate(config, "fixture-group:Legacy-Room", "legacy-group");

    expect(result.warnings).toEqual([]);
    expect(migrated["fixture-group:Legacy-Room"]).toBeUndefined();
    expect(Object.keys(migrated)).toEqual(["agent:main:fixture-chat:group:legacy-room"]);
    expect(migrated["agent:main:fixture-chat:group:legacy-room"]).toMatchObject({
      sessionId: "legacy-group",
    });
    expect(fs.existsSync(selected.marker("sidecar"))).toBe(true);
    expect(fs.existsSync(selected.marker("setup-plugin"))).toBe(false);
    expect(fs.existsSync(selected.marker("full"))).toBe(false);
    expect(fs.existsSync(blocked.marker("sidecar"))).toBe(false);
    expect(fs.existsSync(blocked.marker("setup-plugin"))).toBe(false);
    expect(fs.existsSync(blocked.marker("full"))).toBe(false);
  });

  it("loads an explicitly enabled owner without a channel presence signal", async () => {
    const { writeOwner, persist, migrate } = migrationFixture("enabled-only");
    const fixture = writeOwner("enabled-only-session-owner", "enabled-only-chat");
    const config = {
      plugins: {
        allow: ["enabled-only-session-owner"],
        entries: { "enabled-only-session-owner": { enabled: true } },
      },
    } as OpenClawConfig;
    await persist(config, { "enabled-only-session-owner": fixture });
    const { result, migrated } = await migrate(
      config,
      "fixture-group:Enabled-Only",
      "enabled-only-group",
    );

    expect(result.warnings).toEqual([]);
    expect(migrated["fixture-group:Enabled-Only"]).toBeUndefined();
    expect(migrated["agent:main:enabled-only-chat:group:enabled-only"]).toMatchObject({
      sessionId: "enabled-only-group",
    });
    expect(fs.existsSync(fixture.marker("sidecar"))).toBe(true);
    expect(fs.existsSync(fixture.marker("setup-plugin"))).toBe(false);
    expect(fs.existsSync(fixture.marker("full"))).toBe(false);
  });

  it("defers reinterpretation when a selected owner's sidecar has no canonicalizer", async () => {
    const { writeOwner, persist, migrate } = migrationFixture("failure");
    const fixture = writeOwner("broken-session-owner", "broken-chat");
    fs.writeFileSync(
      path.join(fixture.pluginDir, "dist", "legacy-session-surface.js"),
      `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(fixture.marker("sidecar"))}, "loaded\\n");
export const legacySessionSurface = {
  isLegacyGroupSessionKey(key) { return key.startsWith("fixture-group:"); },
};
`,
      "utf8",
    );
    const config = {
      channels: { "broken-chat": { enabled: true } },
      plugins: {
        allow: ["broken-session-owner"],
        entries: { "broken-session-owner": { enabled: true } },
      },
    } as OpenClawConfig;
    await persist(config, { "broken-session-owner": fixture });
    const { result, migrated: preserved } = await migrate(
      config,
      "fixture-group:Keep-Raw",
      "deferred-group",
    );

    expect(result.warnings).toContainEqual(
      expect.stringContaining(
        'Deferred legacy session-key migration for channel owner "broken-session-owner"',
      ),
    );
    expect(result.warnings).toContainEqual(
      expect.stringContaining("must declare canonicalizeLegacySessionKey"),
    );
    expect(result.warnings).toHaveLength(1);
    expect(preserved["fixture-group:Keep-Raw"]).toMatchObject({
      sessionId: "deferred-group",
    });
    expect(preserved["agent:main:fixture-group:keep-raw"]).toBeUndefined();
    expect(fs.existsSync(fixture.marker("sidecar"))).toBe(true);
    expect(fs.existsSync(fixture.marker("full"))).toBe(false);
  });
});
