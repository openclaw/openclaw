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
import { expectObjectFields } from "../test-utils/mock-call-assertions.js";
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
  readPersistedInstalledPluginIndexInstallRecordsAsync,
  recordPluginInstallInRecords,
  removePluginInstallRecordFromRecords,
  withoutPluginInstallRecords,
} from "./installed-plugin-index-records.js";
import { resolveInstalledPluginIndexStorePath } from "./installed-plugin-index-store-path.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import * as metadataWorker from "./plugin-metadata-state-worker.js";
import { seedInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs = createTempDirTracker();
const makeStateDir = () => tempDirs.make("openclaw-plugin-index-records-");
const seedRecords = (
  stateDir: string,
  records: Record<string, PluginInstallRecord>,
  candidates: PluginCandidate[] = [],
) => seedInstalledPluginIndex(records, { stateDir, candidates });
const managedPlugin = (
  stateDir: string,
  pluginId: string,
  version: string,
  packageName = `@openclaw/${pluginId}`,
) => writeManagedNpmPlugin({ stateDir, packageName, pluginId, version });

function createPluginCandidate(stateDir: string, pluginId: string): PluginCandidate {
  const rootDir = path.join(stateDir, "plugins", pluginId);
  fs.mkdirSync(rootDir, { recursive: true });
  const source = path.join(rootDir, "index.ts");
  fs.writeFileSync(source, "export function register() {}\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({ id: pluginId, configSchema: { type: "object" } }),
    "utf8",
  );
  return recordPluginCandidateInstallOwner(
    { idHint: pluginId, source, rootDir, origin: "global" },
    pluginId,
  );
}

function managedGeneration(stateDir: string, version = "2026.7.1") {
  const packageName = "@openclaw/discord";
  const npmDir = path.join(stateDir, "npm");
  const packageDir = (generationKey: string) =>
    path.join(
      resolvePluginNpmGenerationProjectDir({ npmDir, packageName, generationKey }),
      "node_modules",
      ...packageName.split("/"),
    );
  managedPlugin(stateDir, "discord", version);
  const activeProjectRoot = resolvePluginNpmGenerationProjectDir({
    npmDir,
    packageName,
    generationKey: `discord-${version}`,
  });
  fs.renameSync(resolvePluginNpmProjectDir({ npmDir, packageName }), activeProjectRoot);
  return {
    packageName,
    activePackageDir: packageDir(`discord-${version}`),
    stalePackageDir: packageDir("discord-2026.6.4"),
  };
}

function npmRecord(packageName: string, version: string, installPath: string): PluginInstallRecord {
  return {
    source: "npm",
    spec: `${packageName}@${version}`,
    installPath,
    version,
    resolvedName: packageName,
    resolvedVersion: version,
    resolvedSpec: `${packageName}@${version}`,
  };
}
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.doUnmock("./installed-plugin-index-store.js");
  clearLoadInstalledPluginIndexInstallRecordsCache();
  tempDirs.cleanup();
});

describe("plugin index install records store", () => {
  it("preserves read errors without recovery or cache poisoning", async () => {
    const stateDir = makeStateDir();
    const records = { authoritative: { source: "npm", spec: "authoritative@1.0.0" } } as const;
    await seedRecords(stateDir, records);
    managedPlugin(stateDir, "recoverable", "1.0.0", "recoverable");
    const error = Object.assign(new Error("plugin index read failed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 6,
      errstr: "database table is locked",
    });
    const readSpy = vi.spyOn(stateDbReadOnly, "withExistingOpenClawStateDatabaseReadOnly");
    const scanSpy = vi.spyOn(fs, "readdirSync");
    for (const read of [
      inspectPersistedInstalledPluginIndexInstallRecordsSync,
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
    const asyncReadSpy = vi.spyOn(metadataWorker, "readPluginMetadataStateRow");
    for (const read of [
      readPersistedInstalledPluginIndexInstallRecordsAsync,
      loadInstalledPluginIndexInstallRecords,
    ]) {
      asyncReadSpy.mockRejectedValueOnce(error);
      await expect(read({ stateDir })).rejects.toBe(error);
    }
    expect(scanSpy).not.toHaveBeenCalled();
    asyncReadSpy.mockRestore();
    readSpy.mockRestore();
    scanSpy.mockRestore();

    const restored = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expect(restored.authoritative).toEqual(records.authoritative);
    expect(restored.recoverable).toMatchObject({ source: "npm", spec: "recoverable@1.0.0" });
    expect(loadInstalledPluginIndexInstallRecordsSync({ stateDir })).toEqual(restored);
  });

  it("writes machine-managed install records outside config", async () => {
    const stateDir = makeStateDir();
    const candidate = createPluginCandidate(stateDir, "twitch");

    const records = {
      twitch: {
        source: "npm" as const,
        spec: "@openclaw/plugin-twitch@1.0.0",
        installPath: "plugins/npm/@openclaw/plugin-twitch",
      },
    };
    await seedInstalledPluginIndex(records, {
      stateDir,
      candidates: [candidate],
      now: () => new Date(1777118400000),
    });

    expect(resolveInstalledPluginIndexStorePath({ stateDir })).toBe(
      path.join(stateDir, "state", "openclaw.sqlite"),
    );
    expect(await readPersistedInstalledPluginIndex({ stateDir })).toMatchObject({
      version: 1,
      generatedAtMs: 1777118400000,
      installRecords: { twitch: records.twitch },
      plugins: [
        { pluginId: "twitch", installRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      ],
    });
    expect(await readPersistedInstalledPluginIndexInstallRecordsAsync({ stateDir })).toEqual(
      records,
    );
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
    const stateDir = makeStateDir();
    const customInstallPath = path.join(stateDir, "custom", "node_modules", "@openclaw", "discord");
    managedPlugin(stateDir, "discord", "2026.5.2");
    const record: PluginInstallRecord = {
      source: "npm",
      spec: "@openclaw/discord@beta",
      installPath: customInstallPath,
      integrity: "sha512-persisted",
    };
    await seedRecords(stateDir, { discord: record }, [createPluginCandidate(stateDir, "discord")]);
    expect((await loadInstalledPluginIndexInstallRecords({ stateDir })).discord).toMatchObject(
      record,
    );
  });

  it("recovers a valid managed generation with an obsolete exact-version selector", async () => {
    const recoveredVersion = "2026.7.1";
    const stateDir = makeStateDir();
    const { packageName, stalePackageDir, activePackageDir } = managedGeneration(stateDir);
    await seedRecords(stateDir, {
      discord: {
        ...npmRecord(packageName, "2026.6.4", stalePackageDir),
        integrity: "sha512-stale",
      },
    });

    expectObjectFields((await loadInstalledPluginIndexInstallRecords({ stateDir })).discord, {
      ...npmRecord(packageName, recoveredVersion, activePackageDir),
      integrity: undefined,
    });

    clearLoadInstalledPluginIndexInstallRecordsCache();
    expect(loadInstalledPluginIndexInstallRecordsSync({ stateDir }).discord).toMatchObject({
      installPath: activePackageDir,
      resolvedVersion: recoveredVersion,
    });
  });

  it("recovers a Windows managed generation when the persisted root casing differs", async () => {
    const stateDir = makeStateDir();
    const { packageName, activePackageDir, stalePackageDir } = managedGeneration(stateDir);

    await seedRecords(stateDir, {
      discord: {
        source: "npm",
        spec: "@openclaw/discord@latest",
        installPath: stalePackageDir.replace(stateDir, stateDir.toUpperCase()),
        resolvedName: packageName,
        resolvedVersion: "2026.6.4",
      },
    });

    // Platform spoofing changes the coordinator directory captured by the seeded worker.
    await closeOpenClawStateDatabaseAsync();
    const loaded = await withMockedWindowsPlatform(() =>
      loadInstalledPluginIndexInstallRecords({ stateDir }),
    );
    expect(loaded.discord).toMatchObject({
      installPath: activePackageDir,
      resolvedVersion: "2026.7.1",
    });
  });

  it("recovers managed npm metadata when the persisted record points at an older package version", async () => {
    const stateDir = makeStateDir();
    const codexDir = managedPlugin(stateDir, "codex", "2026.5.18-beta.1");
    await seedRecords(
      stateDir,
      {
        codex: {
          ...npmRecord("@openclaw/codex", "2026.5.16-beta.1", codexDir),
          integrity: "sha512-stale",
          shasum: "stale",
          installedAt: "2026-05-16T01:42:54.609Z",
          resolvedAt: "2026-05-16T01:42:52.981Z",
        },
      },
      [createPluginCandidate(stateDir, "codex")],
    );

    expectObjectFields((await loadInstalledPluginIndexInstallRecords({ stateDir })).codex, {
      ...npmRecord("@openclaw/codex", "2026.5.18-beta.1", codexDir),
      integrity: undefined,
      shasum: undefined,
      installedAt: undefined,
      resolvedAt: undefined,
    });

    expect(loadInstalledPluginIndexInstallRecordsSync({ stateDir }).codex).toMatchObject({
      version: "2026.5.18-beta.1",
      resolvedVersion: "2026.5.18-beta.1",
    });
  });

  it("updates and removes records without mutating caller state", () => {
    const records = createPluginInstallRecordMap<PluginInstallRecord>();
    const keep = { source: "npm" as const, spec: "keep@1.0.0" };
    const entries = [
      ["keep", keep],
      ["constructor", { source: "path" }],
      ["toString", { source: "git" }],
      ["__proto__", { source: "archive" }],
    ] as const;
    for (const [id, record] of entries) {
      setPluginInstallRecordMapEntry(records, id, record);
    }
    const withInstall = recordPluginInstallInRecords(records, {
      pluginId: "demo",
      source: "npm",
      spec: "demo@latest",
      installedAt: "2026-04-25T00:00:00.000Z",
    });

    expect(Object.getPrototypeOf(withInstall)).toBeNull();
    expect(Object.keys(records)).toEqual(["keep", "constructor", "toString", "__proto__"]);
    expect(withInstall.demo).toMatchObject({
      source: "npm",
      spec: "demo@latest",
      installedAt: "2026-04-25T00:00:00.000Z",
    });
    const removed = removePluginInstallRecordFromRecords(withInstall, "demo");
    expect(removed).toEqual(records);
    expect(Object.getPrototypeOf(removed)).toBeNull();
    for (const [id, record] of entries) {
      expect(getPluginInstallRecordMapEntry(withInstall, id)).toBe(record);
      expect(getPluginInstallRecordMapEntry(removed, id)).toBe(record);
    }
    const withoutProto = removePluginInstallRecordFromRecords(removed, "__proto__");
    expect(Object.hasOwn(withoutProto, "__proto__")).toBe(false);
    for (const [id, record] of entries.slice(1, 3)) {
      expect(getPluginInstallRecordMapEntry(withoutProto, id)).toBe(record);
    }
  });

  it("preserves an authored empty plugins section while stripping transient install records", () => {
    expect(
      withoutPluginInstallRecords(
        { plugins: { installs: { twitch: { source: "npm", spec: "twitch@1.0.0" } } } },
        { preserveEmptyPlugins: true },
      ),
    ).toEqual({ plugins: {} });
  });

  it("returns empty records when the persisted plugin index is missing", async () => {
    const stateDir = makeStateDir();

    expect(await readPersistedInstalledPluginIndexInstallRecordsAsync({ stateDir })).toBeNull();
    const records = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expect(Object.keys(records)).toEqual([]);
    expect(Object.getPrototypeOf(records)).toBeNull();
  });
});
