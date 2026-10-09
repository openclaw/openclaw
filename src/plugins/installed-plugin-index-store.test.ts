// Covers installed plugin index store persistence and recovery behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginInstallRecordMap,
  getPluginInstallRecordMapEntry,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  getCurrentPluginMetadataSnapshot,
  setGatewayPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import {
  refreshPersistedInstalledPluginIndex,
  restorePersistedInstalledPluginIndexIfCurrent,
  writePersistedInstalledPluginIndex,
} from "./installed-plugin-index-store-write.js";
import {
  readPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndexSync,
  resolveInstalledPluginIndexStorePath,
} from "./installed-plugin-index-store.js";
import {
  resolveInstalledPluginIndexPolicyHash,
  type InstalledPluginIndex,
} from "./installed-plugin-index.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-snapshot.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import {
  createInstalledPluginIndex as createIndex,
  createInstalledPluginIndexCandidate as createCandidate,
  seedInstalledPluginIndex,
} from "./test-helpers/installed-plugin-index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  clearPluginMetadataLifecycleCaches();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-installed-plugin-index-store", tempDirs);
}

function requirePersisted(index: InstalledPluginIndex | null): InstalledPluginIndex {
  if (!index) {
    throw new Error("Expected persisted installed plugin index");
  }
  return index;
}

function requirePersistedRevision(revision: number | null): number {
  if (revision === null) {
    throw new Error("Expected persisted installed plugin index revision");
  }
  return revision;
}

function expectPluginIds(index: InstalledPluginIndex, expected: string[]) {
  expect(index.plugins.map((plugin) => plugin.pluginId)).toEqual(expected);
}

function expectPluginFields(
  index: InstalledPluginIndex,
  pluginId: string,
  expected: Record<string, unknown>,
) {
  const plugin = index.plugins.find((candidate) => candidate.pluginId === pluginId);
  if (!plugin) {
    throw new Error(`Missing plugin ${pluginId}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    expect(plugin[key as keyof typeof plugin], key).toEqual(value);
  }
}

function expectInstallRecord(
  index: InstalledPluginIndex,
  pluginId: string,
  expected: Record<string, unknown>,
) {
  const record = index.installRecords[pluginId];
  if (!record) {
    throw new Error(`Missing install record ${pluginId}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key as keyof typeof record], key).toEqual(value);
  }
}

function dropStartupConfigPaths(
  plugin: InstalledPluginIndex["plugins"][number],
): InstalledPluginIndex["plugins"][number] {
  return {
    ...plugin,
    startup: {
      sidecar: plugin.startup.sidecar,
      memory: plugin.startup.memory,
      agentHarnesses: plugin.startup.agentHarnesses,
    },
  };
}

async function expectPersistedIndex(
  stateDir: string,
  expected: {
    refreshReason?: string;
    pluginIds?: string[];
    installRecords?: Record<string, Record<string, unknown>>;
  },
) {
  const persisted = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));
  if (expected.refreshReason !== undefined) {
    expect(persisted.refreshReason).toBe(expected.refreshReason);
  }
  if (expected.pluginIds) {
    expectPluginIds(persisted, expected.pluginIds);
  }
  for (const [pluginId, fields] of Object.entries(expected.installRecords ?? {})) {
    expectInstallRecord(persisted, pluginId, fields);
  }
  return persisted;
}

function insertPersistedIndexRow(
  stateDir: string,
  values: {
    version?: number;
    migrationVersion?: number;
    installRecordsJson?: string;
    pluginsJson?: string;
    diagnosticsJson?: string;
  },
): string {
  // Built by string concatenation so raw JSON fixtures (including "__proto__"
  // keys) land in value_json verbatim instead of round-tripping JS objects.
  const valueJson =
    `{"revision":123,"index":{"version":${values.version ?? 1},` +
    '"hostContractVersion":"2026.4.25","compatRegistryVersion":"compat-v1",' +
    `"migrationVersion":${values.migrationVersion ?? 1},"policyHash":"policy-hash",` +
    `"generatedAtMs":123,"installRecords":${values.installRecordsJson ?? "{}"},` +
    `"plugins":${values.pluginsJson ?? "[]"},"diagnostics":${values.diagnosticsJson ?? "[]"}}}`;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare(
        `
          INSERT OR REPLACE INTO config_machine_state (state_key, value_json, updated_at_ms)
          VALUES ('plugins.installedIndex', ?, 123)
        `,
      ).run(valueJson);
    },
    { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
  );
  return valueJson;
}

function readPersistedIndexRevision(stateDir: string): number | null {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const row = db
        .prepare(
          `
            SELECT value_json
              FROM config_machine_state
             WHERE state_key = 'plugins.installedIndex'
          `,
        )
        .get() as { value_json: string } | undefined;
      if (!row) {
        return null;
      }
      const revision = (JSON.parse(row.value_json) as { revision?: unknown }).revision;
      return typeof revision === "number" ? revision : null;
    },
    { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
  );
}

describe("installed plugin index persistence", () => {
  it.each(["write", "rollback"] as const)(
    "keeps the running Gateway inventory after an installed-index %s",
    async (operation) => {
      const stateDir = makeTempDir();
      const pluginDir = path.join(stateDir, "demo");
      fs.mkdirSync(pluginDir);
      const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
      const config = {};
      const index = await refreshPersistedInstalledPluginIndex({
        reason: "manual",
        stateDir,
        candidates: [createCandidate(pluginDir)],
        config,
        env,
      });
      const boot = loadPluginMetadataSnapshot({ index, config, env, allowCurrent: false });
      setGatewayPluginMetadataSnapshot(boot, { config, env });
      expect(getCurrentPluginMetadataSnapshot({ config, env })).toBe(boot);
      const next = { ...index, plugins: [] };

      if (operation === "rollback") {
        const revision = requirePersistedRevision(readPersistedIndexRevision(stateDir));
        await expect(
          withPluginLifecycleLease({ env }, (lease) =>
            restorePersistedInstalledPluginIndexIfCurrent(next, revision, { stateDir, lease }),
          ),
        ).resolves.toBe(true);
      } else {
        await writePersistedInstalledPluginIndex(next, { stateDir });
      }

      expectPluginIds(requirePersisted(await readPersistedInstalledPluginIndex({ stateDir })), []);
      expect(getCurrentPluginMetadataSnapshot({ config, env })).toBe(boot);
      expectPluginIds(boot.index, ["demo"]);
    },
  );

  it("conditionally restores matching prior index absence", async () => {
    const stateDir = makeTempDir();
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    await writePersistedInstalledPluginIndex(createIndex({ policyHash: "tentative" }), {
      stateDir,
    });
    const tentativeRevision = requirePersistedRevision(readPersistedIndexRevision(stateDir));

    await expect(
      withPluginLifecycleLease({ env }, (lease) =>
        restorePersistedInstalledPluginIndexIfCurrent(null, tentativeRevision, {
          stateDir,
          lease,
        }),
      ),
    ).resolves.toBe(true);

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toBeNull();
  });

  it("keeps a successor index when conditional rollback sees a newer revision", async () => {
    const stateDir = makeTempDir();
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    await withPluginLifecycleLease({ env }, async (lease) => {
      await writePersistedInstalledPluginIndex(createIndex({ policyHash: "previous" }), {
        stateDir,
      });
      const previous = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));
      // A future persisted revision exercises collision fencing across worker clocks.
      const futureRevision = Date.now() + 60_000;
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          db.prepare(
            `UPDATE config_machine_state
                SET value_json = json_set(value_json, '$.revision', ?), updated_at_ms = ?
              WHERE state_key = 'plugins.installedIndex'`,
          ).run(futureRevision, futureRevision);
        },
        { env },
      );
      await writePersistedInstalledPluginIndex(createIndex({ policyHash: "tentative" }), {
        stateDir,
      });
      const tentativeRevision = requirePersistedRevision(readPersistedIndexRevision(stateDir));
      await writePersistedInstalledPluginIndex(createIndex({ policyHash: "successor" }), {
        stateDir,
      });
      const successorRevision = requirePersistedRevision(readPersistedIndexRevision(stateDir));

      expect(tentativeRevision).toBe(futureRevision + 1);
      expect(successorRevision).toBe(tentativeRevision + 1);
      await expect(
        restorePersistedInstalledPluginIndexIfCurrent(previous, tentativeRevision, {
          stateDir,
          lease,
        }),
      ).resolves.toBe(false);
      expect(
        requirePersisted(await readPersistedInstalledPluginIndex({ stateDir })).policyHash,
      ).toBe("successor");
    });
  });

  it("rejects a stale caller's registry refresh without replacing the successor index", async () => {
    const stateDir = makeTempDir();
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const staleLease = await withPluginLifecycleLease({ env }, async (lease) => lease);
    await withPluginLifecycleLease({ env }, async (successorLease) => {
      const successorIndex = await refreshPersistedInstalledPluginIndex({
        env,
        lease: successorLease,
        reason: "manual",
        candidates: [],
        config: { plugins: { enabled: false } },
        workspaceDir: "/agents/gadget/workspace",
      });

      await expect(
        refreshPersistedInstalledPluginIndex({
          env,
          lease: staleLease,
          reason: "manual",
          candidates: [],
          config: { plugins: { enabled: true } },
        }),
      ).rejects.toThrow("original live lease context");
      const persisted = requirePersisted(await readPersistedInstalledPluginIndex({ env }));
      expect(persisted.policyHash).toBe(successorIndex.policyHash);
      expect(persisted.workspaceDir).toBe(successorIndex.workspaceDir);
      if (process.platform !== "win32") {
        expect(fs.statSync(resolveInstalledPluginIndexStorePath({ stateDir })).mode & 0o777).toBe(
          0o600,
        );
      }
    });
  });

  it("rereads install-record writes under their non-default policy", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);
    const config = {
      plugins: {
        entries: {
          demo: { enabled: false },
        },
      },
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };

    await seedInstalledPluginIndex(
      { demo: { source: "npm", spec: "demo@1.0.0", installPath: pluginDir } },
      { stateDir, candidates: [candidate], config, env },
    );
    const result = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [candidate],
      config,
      env,
    });

    expect(result.source).toBe("persisted");
    expect(result.diagnostics).toStrictEqual([]);
    expect(result.snapshot.policyHash).toBe(resolveInstalledPluginIndexPolicyHash(config));
    expectPluginFields(result.snapshot, "demo", { enabled: false });
  });

  it("hashes and persists resolved doctor contract artifacts", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);
    const contractPath = path.join(pluginDir, "doctor-contract-api.ts");
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    fs.writeFileSync(contractPath, "export const legacyConfigRules = [];\n", "utf8");

    const first = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env,
    });
    const firstPlugin = first.plugins[0];
    const firstHash = firstPlugin?.doctorContractHash;
    const firstFile = firstPlugin?.doctorContractFile;
    expect(firstHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstFile).toEqual({
      size: fs.statSync(contractPath).size,
      mtimeMs: fs.statSync(contractPath).mtimeMs,
      ctimeMs: fs.statSync(contractPath).ctimeMs,
    });
    expectPluginFields(
      requirePersisted(await readPersistedInstalledPluginIndex({ stateDir })),
      "demo",
      {
        doctorContractHash: firstHash,
        doctorContractFile: firstFile,
      },
    );

    fs.writeFileSync(
      contractPath,
      "export const legacyConfigRules = [{ path: ['demo'], message: 'changed' }];\n",
      "utf8",
    );
    const second = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env,
    });
    const secondPlugin = second.plugins[0];
    const secondHash = secondPlugin?.doctorContractHash;
    const secondFile = secondPlugin?.doctorContractFile;
    expect(secondHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(secondHash).not.toBe(firstHash);
    expect(secondFile).not.toEqual(firstFile);
    expectPluginFields(
      requirePersisted(await readPersistedInstalledPluginIndex({ stateDir })),
      "demo",
      {
        doctorContractHash: secondHash,
        doctorContractFile: secondFile,
      },
    );
  });

  it("does not repair shared state schema while reading the index", async () => {
    const stateDir = makeTempDir();
    const filePath = resolveInstalledPluginIndexStorePath({ stateDir });
    await writePersistedInstalledPluginIndex(createIndex(), { stateDir });
    await closeOpenClawStateDatabaseAsync();

    const sqlite = requireNodeSqlite();
    const mutate = new sqlite.DatabaseSync(filePath);
    mutate.exec("DROP INDEX idx_operator_approvals_resolution_ref;");
    mutate.close();

    const expectCanonicalIndexMissing = () => {
      const verify = new sqlite.DatabaseSync(filePath, { readOnly: true });
      try {
        expect(
          verify
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'idx_operator_approvals_resolution_ref'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        verify.close();
      }
    };

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject({
      version: 1,
    });
    expectCanonicalIndexMissing();

    expect(readPersistedInstalledPluginIndexInstallRecords({ stateDir })).toEqual({});
    expectCanonicalIndexMissing();
  });

  it("marks legacy config-path startup indexes stale so update rebuilds them", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const candidate = createCandidate(pluginDir, { configPaths: ["browser"] });
    const current = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env,
    });
    const legacy = {
      ...current,
      plugins: current.plugins.map(dropStartupConfigPaths),
    };
    await writePersistedInstalledPluginIndex(legacy, { stateDir });

    const inspection = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [candidate],
      env,
    });
    expect(inspection.source).toBe("derived");

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      candidates: [candidate],
      env,
    });
    expect(refreshed.plugins[0]?.startup.configPaths).toEqual(["browser"]);
    const persisted = requirePersisted(await readPersistedInstalledPluginIndex({ stateDir }));
    expect(persisted.plugins[0]?.startup.configPaths).toEqual(["browser"]);
  });

  it("does not allocate a revision or rewrite an invalid predecessor", async () => {
    const stateDir = makeTempDir();
    const installRecordsJson = '{"__proto__":{"source":"bogus"}}';
    const persistedValueJson = insertPersistedIndexRow(stateDir, { installRecordsJson });

    await expect(writePersistedInstalledPluginIndex(createIndex(), { stateDir })).rejects.toThrow(
      "Persisted plugin install records are invalid",
    );
    const row = runOpenClawStateWriteTransaction(
      ({ db }) =>
        db
          .prepare(
            `SELECT value_json, updated_at_ms
               FROM config_machine_state
              WHERE state_key = 'plugins.installedIndex'`,
          )
          .get() as { value_json: string; updated_at_ms: number | bigint },
      { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
    );
    expect(row).toEqual({ value_json: persistedValueJson, updated_at_ms: 123 });
  });

  it("preserves newer shared-state schema errors while reading the index", async () => {
    const stateDir = makeTempDir();
    await writePersistedInstalledPluginIndex(createIndex(), { stateDir });
    await closeOpenClawStateDatabaseAsync();
    const databasePath = resolveInstalledPluginIndexStorePath({ stateDir });
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    database.close();

    await expect(readPersistedInstalledPluginIndex({ stateDir })).rejects.toMatchObject({
      name: "SqliteSchemaVersionError",
      message: expect.stringContaining(
        `uses newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
      ),
    });
  });

  it("does not read retired JSON index files", async () => {
    const stateDir = makeTempDir();
    const filePath = path.join(stateDir, "installs.json");
    fs.writeFileSync(filePath, JSON.stringify(createIndex()), "utf8");

    await expect(readPersistedInstalledPluginIndex({ filePath })).resolves.toBeNull();
    expect(readPersistedInstalledPluginIndexInstallRecords({ filePath })).toBeNull();
  });

  it("preserves existing install records when refreshing the manifest cache", async () => {
    const stateDir = makeTempDir();
    await writePersistedInstalledPluginIndex(
      createIndex({
        installRecords: {
          missing: {
            source: "npm",
            spec: "missing-plugin@1.0.0",
            installPath: path.join(stateDir, "plugins", "missing"),
          },
        },
        plugins: [],
      }),
      { stateDir },
    );

    const index = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
    });

    expectInstallRecord(index, "missing", {
      source: "npm",
      spec: "missing-plugin@1.0.0",
      installPath: path.join(stateDir, "plugins", "missing"),
    });
    expectPluginIds(index, []);
    await expectPersistedIndex(stateDir, {
      pluginIds: [],
      installRecords: {
        missing: {
          source: "npm",
          spec: "missing-plugin@1.0.0",
          installPath: path.join(stateDir, "plugins", "missing"),
        },
      },
    });
  });
});

function readInstallRecordRow(stateDir: string): {
  value_json: string;
  updated_at_ms: number | bigint;
} {
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      db
        .prepare(
          `SELECT value_json, updated_at_ms
             FROM config_machine_state
            WHERE state_key = 'plugins.installedIndex'`,
        )
        .get() as { value_json: string; updated_at_ms: number | bigint },
    { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
  );
}

describe("installed plugin index install-record persistence", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["records-first", "index-first"] as const)(
    "reads one row for independent projections of an invalid index: %s",
    async (order) => {
      const stateDir = makeTempDir();
      await withPluginLifecycleLease(
        { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
        async () => {
          expect(readPersistedInstalledPluginIndexInstallRecords({ stateDir })).toBeNull();
          expect(readPersistedInstalledPluginIndexSync({ stateDir })).toBeNull();
          const records = { demo: { source: "npm" as const, spec: "demo@1.0.0" } };
          await writePersistedInstalledPluginIndex(
            createIndex({ installRecords: records, plugins: [] }),
            { stateDir },
          );
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              db.prepare(
                `UPDATE config_machine_state
                  SET value_json = json_remove(value_json, '$.index.plugins')
                WHERE state_key = 'plugins.installedIndex'`,
              ).run();
            },
            { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
          );
          const { StatementSync } = requireNodeSqlite();
          const iterate = vi.spyOn(StatementSync.prototype, "iterate");
          const get = vi.spyOn(StatementSync.prototype, "get");
          const all = vi.spyOn(StatementSync.prototype, "all");
          const readRecords = () =>
            expect(readPersistedInstalledPluginIndexInstallRecords({ stateDir })).toEqual(records);
          const readIndex = () => {
            const index = readPersistedInstalledPluginIndexSync({ stateDir });
            expect(index).toBeNull();
          };

          for (const read of order === "records-first"
            ? [readRecords, readIndex]
            : [readIndex, readRecords]) {
            read();
          }

          expect(
            [iterate, get, all].flatMap((spy) =>
              spy.mock.calls.filter((params, index) => {
                const statement = spy.mock.contexts[index];
                return (
                  statement instanceof StatementSync &&
                  params.includes("plugins.installedIndex") &&
                  /SELECT\b[\s\S]*?\bFROM\s+"?config_machine_state"?\s+WHERE\s+"?state_key"?\s*(?:=|IN\s*\()/i.test(
                    statement.sourceSQL,
                  )
                );
              }),
            ),
          ).toHaveLength(1);
        },
      );
    },
  );

  it("persists legal prototype-named plugin ids as inert own properties", async () => {
    const stateDir = makeTempDir();
    const installRecords =
      createPluginInstallRecordMap<InstalledPluginIndex["installRecords"][string]>();
    const constructorRecord = { source: "npm" as const, futureMetadata: { retained: true } };
    setPluginInstallRecordMapEntry(installRecords, "constructor", constructorRecord);
    setPluginInstallRecordMapEntry(installRecords, "toString", { source: "path" });
    setPluginInstallRecordMapEntry(installRecords, "__proto__", { source: "git" });

    await writePersistedInstalledPluginIndex(createIndex({ installRecords, plugins: [] }), {
      stateDir,
    });

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    if (!persisted) {
      throw new Error("Expected persisted installed plugin index");
    }
    expect(Object.getPrototypeOf(persisted.installRecords)).toBeNull();
    expect(getPluginInstallRecordMapEntry(persisted.installRecords, "constructor")).toEqual({
      source: "npm",
      futureMetadata: { retained: true },
    });
    expect(getPluginInstallRecordMapEntry(persisted.installRecords, "toString")).toEqual({
      source: "path",
    });
    expect(getPluginInstallRecordMapEntry(persisted.installRecords, "__proto__")).toEqual({
      source: "git",
    });
  });

  it("atomically rejects an invalid __proto__ candidate record", async () => {
    const pluginId = "__proto__";
    const stateDir = makeTempDir();
    await writePersistedInstalledPluginIndex(
      createIndex({
        installRecords: { stable: { source: "npm", spec: "stable@1.0.0" } },
        plugins: [],
      }),
      { stateDir },
    );
    const before = readInstallRecordRow(stateDir);
    const invalid = createPluginInstallRecordMap<unknown>();
    setPluginInstallRecordMapEntry(invalid, "stable", {
      source: "npm",
      spec: "stable@2.0.0",
    });
    setPluginInstallRecordMapEntry(invalid, pluginId, { source: "bogus" });
    await expect(
      writePersistedInstalledPluginIndex(
        createIndex({
          installRecords: invalid as InstalledPluginIndex["installRecords"],
          plugins: [],
        }),
        { stateDir },
      ),
    ).rejects.toThrow("Invalid plugin install record");
    expect(readInstallRecordRow(stateDir)).toEqual(before);
  });
});
