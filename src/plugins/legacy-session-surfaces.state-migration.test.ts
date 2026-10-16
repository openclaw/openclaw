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

function migrationFixture(name: string, bundled = false) {
  const rootDir = makeTrackedTempDir(`openclaw-session-surface-${name}`, tempDirs);
  const stateDir = path.join(rootDir, "state");
  const bundledDir = path.join(rootDir, "bundled-disabled");
  fs.mkdirSync(bundledDir, { recursive: true });
  if (bundled) {
    fs.mkdirSync(stateDir);
  }
  const env: NodeJS.ProcessEnv = {
    HOME: rootDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: bundled ? "" : "1",
    ...(bundled ? { OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1" } : {}),
    OPENCLAW_VERSION: "2026.8.1",
    VITEST: "true",
  };
  const writeOwner = (pluginId: string, channelId: string) =>
    writeSessionSurfacePlugin({
      rootDir,
      stateDir,
      pluginId,
      channelId,
      ...(bundled ? { bundledDir } : {}),
    });
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
  legacySurface?: false;
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
  const writeModule = (name: string, source: string) =>
    fs.writeFileSync(path.join(pluginDir, "dist", name), source, "utf8");
  writeJson(path.join(pluginDir, "package.json"), {
    name: packageName,
    version: "1.0.0",
    type: "module",
    openclaw: {
      extensions: ["./dist/index.js"],
      ...(params.legacySurface === false
        ? {}
        : {
            setupEntry: "./dist/setup-entry.js",
            setupFeatures: { legacySessionSurfaces: true },
          }),
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
  writeModule(
    "index.js",
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker("full"))}, "loaded\\n");
export default { register() {} };
`,
  );
  if (params.bundledDir) {
    writeModule(
      "auth-presence.js",
      `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker("auth-probe"))}, "loaded");
export function hasAuth() { return false; }
`,
    );
  }
  if (params.legacySurface === false) {
    return { pluginDir, marker };
  }
  writeModule(
    "setup-plugin.js",
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker("setup-plugin"))}, "loaded\\n");
export const setupPlugin = { id: ${JSON.stringify(params.channelId)} };
`,
  );
  writeModule(
    "legacy-session-surface.js",
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
  );
  writeModule(
    "setup-entry.js",
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
  );
  return { pluginDir, marker };
}

function importedSurfaces(fixture: ReturnType<typeof writeSessionSurfacePlugin>) {
  return ["sidecar", "setup-plugin", "full"].map((name) => fs.existsSync(fixture.marker(name)));
}

describe("installed channel legacy session surfaces", () => {
  it("loads an eligible bundled migration owner without probing its authentication", () => {
    const { env, writeOwner } = migrationFixture("bundled", true);
    const fixture = writeOwner("bundled-session-owner", "bundled-chat");
    for (const key of [
      "OPENCLAW_BUNDLED_PLUGINS_DIR",
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
      "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
    ]) {
      vi.stubEnv(key, env[key]);
    }
    const prepared = prepareLegacySessionSurfaces({ config: {}, env });

    expect(prepared.failures).toEqual([]);
    expect(prepared.surfaces).toHaveLength(1);
    expect(
      prepared.surfaces[0]?.canonicalizeLegacySessionKey?.({
        key: "fixture-group:Room",
        agentId: "main",
      }),
    ).toBe("agent:main:bundled-chat:group:room");
    expect(importedSurfaces(fixture)).toEqual([true, false, false]);
    expect(fs.existsSync(fixture.marker("auth-probe"))).toBe(false);
  });

  it("loads only the selected setup sidecar and canonicalizes its legacy group key", async () => {
    const { rootDir, stateDir, bundledDir, env, writeOwner, persist, migrate } =
      migrationFixture("selected");
    const unrelated = writeSessionSurfacePlugin({
      rootDir,
      stateDir,
      bundledDir,
      pluginId: "unrelated-channel",
      channelId: "unrelated-channel",
      legacySurface: false,
    });
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
    expect(fs.existsSync(unrelated.marker("auth-probe"))).toBe(false);
    expect(prepared.failures).toEqual([]);
    expect(prepared.surfaces).toHaveLength(1);
    expect([prepared, prepared.surfaces, prepared.failures].every(Object.isFrozen)).toBe(true);
    const { result, migrated } = await migrate(config, "fixture-group:Legacy-Room", "legacy-group");

    expect(result.warnings).toEqual([]);
    expect(migrated["fixture-group:Legacy-Room"]).toBeUndefined();
    expect(Object.keys(migrated)).toEqual(["agent:main:fixture-chat:group:legacy-room"]);
    expect(migrated["agent:main:fixture-chat:group:legacy-room"]).toMatchObject({
      sessionId: "legacy-group",
    });
    expect(importedSurfaces(selected)).toEqual([true, false, false]);
    expect(importedSurfaces(blocked)).toEqual([false, false, false]);
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
    expect(importedSurfaces(fixture)).toEqual([true, false, false]);
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

    expect(result.warnings).toEqual([
      expect.stringMatching(
        /Deferred legacy session-key migration for channel owner "broken-session-owner".*must declare canonicalizeLegacySessionKey/,
      ),
    ]);
    expect(preserved["fixture-group:Keep-Raw"]).toMatchObject({
      sessionId: "deferred-group",
    });
    expect(preserved["agent:main:fixture-group:keep-raw"]).toBeUndefined();
    expect(fs.existsSync(fixture.marker("sidecar"))).toBe(true);
    expect(fs.existsSync(fixture.marker("full"))).toBe(false);
  });
});
