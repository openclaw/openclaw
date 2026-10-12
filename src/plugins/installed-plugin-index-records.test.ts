import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createPluginInstallRecordMap,
  getPluginInstallRecordMapEntry,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import * as stateDbReadOnly from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import type { PluginCandidate } from "./discovery.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import { inspectPersistedInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-state.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
  loadInstalledPluginIndexInstallRecordsSync,
  readPersistedInstalledPluginIndexInstallRecords,
  recordPluginInstallInRecords,
  removePluginInstallRecordFromRecords,
  withoutPluginInstallRecords,
} from "./installed-plugin-index-records.js";
// Covers installed plugin index record parsing and normalization.
import { resolveInstalledPluginIndexStorePath } from "./installed-plugin-index-store-path.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import * as metadataWorker from "./plugin-metadata-state-worker.js";
import { seedInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs = createTempDirTracker();

function createPluginCandidate(stateDir: string, pluginId: string): PluginCandidate {
  const rootDir = path.join(stateDir, "plugins", pluginId);
  fs.mkdirSync(rootDir, { recursive: true });
  const source = path.join(rootDir, "index.ts");
  fs.writeFileSync(source, "export function register() {}\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      configSchema: { type: "object" },
    }),
    "utf8",
  );
  return recordPluginCandidateInstallOwner(
    {
      idHint: pluginId,
      source,
      rootDir,
      origin: "global",
    },
    pluginId,
  );
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.doUnmock("./installed-plugin-index-store.js");
  clearLoadInstalledPluginIndexInstallRecordsCache();
  tempDirs.cleanup();
});

describe("plugin index install records store", () => {
  it.each([{ code: "ERR_SQLITE_ERROR", errcode: 6, errstr: "database table is locked" }])(
    "preserves read errors without recovery or cache poisoning: %j",
    async (details) => {
      const stateDir = tempDirs.make("openclaw-plugin-index-records-");
      const records = { authoritative: { source: "npm", spec: "authoritative@1.0.0" } } as const;
      await seedInstalledPluginIndex(records, { stateDir, candidates: [] });
      writeManagedNpmPlugin({
        stateDir,
        packageName: "recoverable",
        pluginId: "recoverable",
        version: "1.0.0",
      });
      const error = Object.assign(new Error("plugin index read failed"), details);
      const readSpy = vi.spyOn(stateDbReadOnly, "withExistingOpenClawStateDatabaseReadOnly");
      const scanSpy = vi.spyOn(fs, "readdirSync");
      for (const read of [
        inspectPersistedInstalledPluginIndexInstallRecordsSync,
        readPersistedInstalledPluginIndexInstallRecords,
        loadInstalledPluginIndexInstallRecordsSync,
      ]) {
        readSpy.mockImplementationOnce(() => {
          throw error;
        });
        await expect
          .soft(
            Promise.resolve().then(() => read({ stateDir })),
            read.name,
          )
          .rejects.toBe(error);
      }
      const asyncReadSpy = vi
        .spyOn(metadataWorker, "readPluginMetadataStateRow")
        .mockRejectedValueOnce(error);
      await expect(loadInstalledPluginIndexInstallRecords({ stateDir })).rejects.toBe(error);
      expect(scanSpy).not.toHaveBeenCalled();
      asyncReadSpy.mockRestore();
      readSpy.mockRestore();
      scanSpy.mockRestore();

      const restored = await loadInstalledPluginIndexInstallRecords({ stateDir });
      expect(restored.authoritative).toEqual(records.authoritative);
      expect(restored.recoverable).toMatchObject({ source: "npm", spec: "recoverable@1.0.0" });
      expect(loadInstalledPluginIndexInstallRecordsSync({ stateDir })).toEqual(restored);
    },
  );

  it("writes machine-managed install records outside config", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const candidate = createPluginCandidate(stateDir, "twitch");

    await seedInstalledPluginIndex(
      {
        twitch: {
          source: "npm",
          spec: "@openclaw/plugin-twitch@1.0.0",
          installPath: "plugins/npm/@openclaw/plugin-twitch",
        },
      },
      {
        stateDir,
        candidates: [candidate],
        now: () => new Date(1777118400000),
      },
    );

    const indexPath = resolveInstalledPluginIndexStorePath({ stateDir });
    expect(indexPath).toBe(path.join(stateDir, "state", "openclaw.sqlite"));
    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    if (!persisted) {
      throw new Error("Expected persisted plugin index");
    }
    expect(persisted.version).toBe(1);
    expect(persisted.generatedAtMs).toBe(1777118400000);
    expectRecordFields(persisted.installRecords?.twitch, {
      source: "npm",
      spec: "@openclaw/plugin-twitch@1.0.0",
      installPath: "plugins/npm/@openclaw/plugin-twitch",
    });
    expect(persisted.plugins).toHaveLength(1);
    expect(persisted.plugins?.[0]?.pluginId).toBe("twitch");
    expect(persisted.plugins?.[0]?.installRecordHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(readPersistedInstalledPluginIndexInstallRecords({ stateDir })).toEqual({
      twitch: {
        source: "npm",
        spec: "@openclaw/plugin-twitch@1.0.0",
        installPath: "plugins/npm/@openclaw/plugin-twitch",
      },
    });
  });

  it("preserves newer shared-state schema errors while loading install records", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    await seedInstalledPluginIndex(
      {
        persisted: {
          source: "npm",
          spec: "persisted@1.0.0",
        },
      },
      { stateDir, candidates: [] },
    );
    await closeOpenClawStateDatabaseAsync();
    const databasePath = resolveInstalledPluginIndexStorePath({ stateDir });
    fs.renameSync(databasePath, `${databasePath}.template`);
    fs.copyFileSync(`${databasePath}.template`, databasePath, fs.constants.COPYFILE_EXCL);
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    database.close();

    expect(() => loadInstalledPluginIndexInstallRecordsSync({ stateDir })).toThrow(
      expect.objectContaining({
        name: "SqliteSchemaVersionError",
        message: expect.stringContaining(
          `uses newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
        ),
      }),
    );
  });

  it("keeps persisted install record metadata over recovered npm records", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const customInstallPath = path.join(stateDir, "custom", "node_modules", "@openclaw", "discord");
    writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/discord",
      pluginId: "discord",
      version: "2026.5.2",
    });
    const candidate = createPluginCandidate(stateDir, "discord");
    await seedInstalledPluginIndex(
      {
        discord: {
          source: "npm",
          spec: "@openclaw/discord@beta",
          installPath: customInstallPath,
          integrity: "sha512-persisted",
        },
      },
      { stateDir, candidates: [candidate] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded.discord, {
      source: "npm",
      spec: "@openclaw/discord@beta",
      installPath: customInstallPath,
      integrity: "sha512-persisted",
    });
  });

  it.each([
    {
      expectedSpec: "@openclaw/discord@2026.7.1",
      label: "obsolete exact-version",
      persistedVersion: "2026.6.4",
      recoveredVersion: "2026.7.1",
      spec: "@openclaw/discord@2026.6.4",
    },
  ])(
    "recovers a valid managed generation with a compatible $label selector",
    async ({ expectedSpec, persistedVersion, recoveredVersion, spec }) => {
      const stateDir = tempDirs.make("openclaw-plugin-index-records-");
      const packageName = "@openclaw/discord";
      const fixtureProjectRoot = resolvePluginNpmProjectDir({
        npmDir: path.join(stateDir, "npm"),
        packageName,
      });
      writeManagedNpmPlugin({
        stateDir,
        packageName,
        pluginId: "discord",
        version: recoveredVersion,
      });
      const staleProjectRoot = resolvePluginNpmGenerationProjectDir({
        npmDir: path.join(stateDir, "npm"),
        packageName,
        generationKey: "discord-2026.6.4",
      });
      const activeProjectRoot = resolvePluginNpmGenerationProjectDir({
        npmDir: path.join(stateDir, "npm"),
        packageName,
        generationKey: `discord-${recoveredVersion}`,
      });
      fs.renameSync(fixtureProjectRoot, activeProjectRoot);
      const stalePackageDir = path.join(
        staleProjectRoot,
        "node_modules",
        ...packageName.split("/"),
      );
      const activePackageDir = path.join(
        activeProjectRoot,
        "node_modules",
        ...packageName.split("/"),
      );

      await seedInstalledPluginIndex(
        {
          discord: {
            source: "npm",
            spec,
            installPath: stalePackageDir,
            version: persistedVersion,
            resolvedName: packageName,
            resolvedVersion: persistedVersion,
            resolvedSpec: `${packageName}@${persistedVersion}`,
            integrity: "sha512-stale",
          },
        },
        { stateDir, candidates: [] },
      );

      const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
      const record = expectRecordFields(loaded.discord, {
        source: "npm",
        spec: expectedSpec,
        installPath: activePackageDir,
        version: recoveredVersion,
        resolvedName: packageName,
        resolvedVersion: recoveredVersion,
        resolvedSpec: `${packageName}@${recoveredVersion}`,
      });
      expect(record.integrity).toBeUndefined();

      clearLoadInstalledPluginIndexInstallRecordsCache();
      expectRecordFields(loadInstalledPluginIndexInstallRecordsSync({ stateDir }).discord, {
        installPath: activePackageDir,
        resolvedVersion: recoveredVersion,
      });
    },
  );

  it("recovers a Windows managed generation when the persisted root casing differs", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const packageName = "@openclaw/discord";
    const npmDir = path.join(stateDir, "npm");
    const fixtureProjectRoot = resolvePluginNpmProjectDir({ npmDir, packageName });
    writeManagedNpmPlugin({
      stateDir,
      packageName,
      pluginId: "discord",
      version: "2026.7.1",
    });
    const activeProjectRoot = resolvePluginNpmGenerationProjectDir({
      npmDir,
      packageName,
      generationKey: "discord-2026.7.1",
    });
    fs.renameSync(fixtureProjectRoot, activeProjectRoot);
    const activePackageDir = path.join(
      activeProjectRoot,
      "node_modules",
      ...packageName.split("/"),
    );
    const staleProjectRoot = resolvePluginNpmGenerationProjectDir({
      npmDir,
      packageName,
      generationKey: "discord-2026.6.4",
    });
    const stalePackageDir = path
      .join(staleProjectRoot, "node_modules", ...packageName.split("/"))
      .replace(stateDir, stateDir.toUpperCase());

    await seedInstalledPluginIndex(
      {
        discord: {
          source: "npm",
          spec: "@openclaw/discord@latest",
          installPath: stalePackageDir,
          resolvedName: packageName,
          resolvedVersion: "2026.6.4",
        },
      },
      { stateDir, candidates: [] },
    );

    // Platform spoofing changes the coordinator directory captured by the seeded worker.
    await closeOpenClawStateDatabaseAsync();
    const loaded = await withMockedWindowsPlatform(() =>
      loadInstalledPluginIndexInstallRecords({ stateDir }),
    );
    expectRecordFields(loaded.discord, {
      installPath: activePackageDir,
      resolvedVersion: "2026.7.1",
    });
  });

  it("recovers managed npm metadata when the persisted record points at an older package version", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const codexDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/codex",
      pluginId: "codex",
      version: "2026.5.18-beta.1",
    });
    const candidate = createPluginCandidate(stateDir, "codex");
    await seedInstalledPluginIndex(
      {
        codex: {
          source: "npm",
          spec: "@openclaw/codex@2026.5.16-beta.1",
          installPath: codexDir,
          version: "2026.5.16-beta.1",
          resolvedName: "@openclaw/codex",
          resolvedVersion: "2026.5.16-beta.1",
          resolvedSpec: "@openclaw/codex@2026.5.16-beta.1",
          integrity: "sha512-stale",
          shasum: "stale",
          installedAt: "2026-05-16T01:42:54.609Z",
          resolvedAt: "2026-05-16T01:42:52.981Z",
        },
      },
      { stateDir, candidates: [candidate] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    const record = expectRecordFields(loaded.codex, {
      source: "npm",
      spec: "@openclaw/codex@2026.5.18-beta.1",
      installPath: codexDir,
      version: "2026.5.18-beta.1",
      resolvedName: "@openclaw/codex",
      resolvedVersion: "2026.5.18-beta.1",
      resolvedSpec: "@openclaw/codex@2026.5.18-beta.1",
    });
    expect(record.integrity).toBeUndefined();
    expect(record.shasum).toBeUndefined();
    expect(record.installedAt).toBeUndefined();
    expect(record.resolvedAt).toBeUndefined();

    const loadedSync = loadInstalledPluginIndexInstallRecordsSync({ stateDir });
    expectRecordFields(loadedSync.codex, {
      version: "2026.5.18-beta.1",
      resolvedVersion: "2026.5.18-beta.1",
    });
  });

  it("updates and removes records without mutating caller state", () => {
    const records = createPluginInstallRecordMap<PluginInstallRecord>();
    const keep = { source: "npm" as const, spec: "keep@1.0.0" };
    const constructorRecord = { source: "path" as const };
    const toStringRecord = { source: "git" as const };
    const protoRecord = { source: "archive" as const };
    setPluginInstallRecordMapEntry(records, "keep", keep);
    setPluginInstallRecordMapEntry(records, "constructor", constructorRecord);
    setPluginInstallRecordMapEntry(records, "toString", toStringRecord);
    setPluginInstallRecordMapEntry(records, "__proto__", protoRecord);
    const withInstall = recordPluginInstallInRecords(records, {
      pluginId: "demo",
      source: "npm",
      spec: "demo@latest",
      installedAt: "2026-04-25T00:00:00.000Z",
    });

    expect(Object.getPrototypeOf(withInstall)).toBeNull();
    expect(Object.keys(records)).toEqual(["keep", "constructor", "toString", "__proto__"]);
    expectRecordFields(withInstall.demo, {
      source: "npm",
      spec: "demo@latest",
      installedAt: "2026-04-25T00:00:00.000Z",
    });
    expect(withInstall.keep).toBe(keep);
    expect(getPluginInstallRecordMapEntry(withInstall, "constructor")).toBe(constructorRecord);
    expect(getPluginInstallRecordMapEntry(withInstall, "toString")).toBe(toStringRecord);
    expect(getPluginInstallRecordMapEntry(withInstall, "__proto__")).toBe(protoRecord);
    const removed = removePluginInstallRecordFromRecords(withInstall, "demo");
    expect(removed).toEqual(records);
    expect(Object.getPrototypeOf(removed)).toBeNull();
    expect(removed.keep).toBe(keep);
    expect(getPluginInstallRecordMapEntry(removed, "constructor")).toBe(constructorRecord);
    expect(getPluginInstallRecordMapEntry(removed, "toString")).toBe(toStringRecord);
    expect(getPluginInstallRecordMapEntry(removed, "__proto__")).toBe(protoRecord);
    const withoutProto = removePluginInstallRecordFromRecords(removed, "__proto__");
    expect(Object.hasOwn(withoutProto, "__proto__")).toBe(false);
    expect(getPluginInstallRecordMapEntry(withoutProto, "constructor")).toBe(constructorRecord);
    expect(getPluginInstallRecordMapEntry(withoutProto, "toString")).toBe(toStringRecord);
  });

  it("preserves an authored empty plugins section while stripping transient install records", () => {
    expect(
      withoutPluginInstallRecords(
        {
          plugins: {
            installs: {
              twitch: { source: "npm", spec: "twitch@1.0.0" },
            },
          },
        },
        { preserveEmptyPlugins: true },
      ),
    ).toEqual({ plugins: {} });
  });

  it("returns empty records when the persisted plugin index is missing", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");

    expect(readPersistedInstalledPluginIndexInstallRecords({ stateDir })).toBeNull();
    const records = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expect(Object.keys(records)).toEqual([]);
    expect(Object.getPrototypeOf(records)).toBeNull();
  });
});
