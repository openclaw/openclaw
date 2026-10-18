import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as stateDbReadOnly from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { inspectPersistedInstalledPluginIndexInstallRecordsSync as inspectRecords } from "./installed-plugin-index-record-state.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync as readRecords } from "./installed-plugin-index-records.js";
import { refreshPersistedInstalledPluginIndexWithLeaseSync as refreshWithLease } from "./installed-plugin-index-store-write.js";
import {
  readPersistedInstalledPluginIndex as readIndex,
  readPersistedInstalledPluginIndexSync as readIndexSync,
  resolveInstalledPluginIndexStorePath as storePath,
} from "./installed-plugin-index-store.js";
import * as metadataWorker from "./plugin-metadata-state-worker.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { createInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});
const makeTempDir = () =>
  makeTrackedTempDir("openclaw-installed-plugin-index-read-state", tempDirs);
const validRecords = { demo: { source: "npm" } } as const;
const rowJson = (index: object) => JSON.stringify({ revision: 123, index });
const readError = () => Object.assign(new Error("plugin index read denied"), { code: "EACCES" });

async function expectRecordState(stateDir: string, status: string, records: object | null) {
  const state = inspectRecords({ stateDir });
  expect(state).toEqual(status === "missing" ? { status } : expect.objectContaining({ status }));
  expect(await readRecords({ stateDir })).toEqual(records);
  await expect(readIndex({ stateDir })).resolves.toBeNull();
}

function insertPersistedIndexRow(stateDir: string, valueJson: string): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare(
        "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES ('plugins.installedIndex', ?, 123)",
      ).run(valueJson);
    },
    { env: { OPENCLAW_STATE_DIR: stateDir } },
  );
}

function readRow(filePath: string) {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT value_json, updated_at_ms FROM config_machine_state WHERE state_key = 'plugins.installedIndex'",
      )
      .get() as { value_json: string; updated_at_ms: number };
  } finally {
    db.close();
  }
}

describe("installed plugin index read state", () => {
  it("preserves the original read error through both full-index readers", async () => {
    const stateDir = makeTempDir();
    const error = readError();
    const readSpy = vi.spyOn(stateDbReadOnly, "withExistingOpenClawStateDatabaseReadOnly");
    const asyncReadSpy = vi.spyOn(metadataWorker, "readPluginMetadataStateRow");
    for (const { read, fail } of [
      { read: readIndexSync, fail: readSpy },
      { read: readIndex, fail: asyncReadSpy },
    ]) {
      fail.mockImplementationOnce(() => {
        throw error;
      });
      const pending = Promise.resolve().then(() => read({ stateDir }));
      await expect.soft(pending, read.name).rejects.toBe(error);
    }
  });

  it.each(["database", "table", "row"])("reads missing %s without creation", async (missing) => {
    const stateDir = makeTempDir();
    const filePath = storePath({ stateDir });
    if (missing !== "database") {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(filePath);
      if (missing === "row") {
        db.exec(
          "CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT",
        );
      }
      db.close();
    }
    const before = missing === "database" ? undefined : fs.readFileSync(filePath);
    await expectRecordState(stateDir, "missing", null);
    expect(missing === "database" ? fs.existsSync(filePath) : fs.readFileSync(filePath)).toEqual(
      before ?? false,
    );
  });

  it.each(["manual", "policy-changed"] as const)("blocks %s on read failure", async (reason) => {
    const stateDir = makeTempDir();
    const installRecords = { demo: { source: "npm", spec: "demo@1.0.0" } } as const;
    const valueJson = rowJson(createInstalledPluginIndex({ installRecords, plugins: [] }));
    insertPersistedIndexRow(stateDir, valueJson);
    const filePath = storePath({ stateDir });
    closeOpenClawStateDatabaseForTest();
    const error = readError();
    const readSpy = vi
      .spyOn(stateDbReadOnly, "withExistingOpenClawStateDatabaseReadOnly")
      .mockImplementationOnce(() => {
        throw error;
      });
    const lease = { assertOwnedInTransaction: vi.fn() };
    const refresh = () =>
      refreshWithLease({
        reason,
        stateDir,
        candidates: [],
        env: { OPENCLAW_VERSION: "2026.4.25", VITEST: "true" },
        ...(reason === "policy-changed" ? { installRecords } : {}),
        lease,
      });
    await expect.soft(Promise.resolve().then(refresh)).rejects.toBe(error);
    expect.soft(lease.assertOwnedInTransaction).not.toHaveBeenCalled();
    expect.soft(readRow(filePath)).toEqual({ value_json: valueJson, updated_at_ms: 123 });
    readSpy.mockRestore();
    refresh();
    expect((await readIndex({ stateDir }))?.installRecords).toEqual(installRecords);
    expect(JSON.parse(readRow(filePath).value_json).revision).toBeGreaterThan(123);
  });

  it.each([
    ["malformed JSON", "{", "invalid"],
    ["missing records", rowJson({}), "invalid"],
    ["malformed records", rowJson({ installRecords: { demo: { source: "bogus" } } }), "invalid"],
    ["invalid index metadata", rowJson({ version: 999, installRecords: validRecords }), "valid"],
    ["missing revision", JSON.stringify({ index: { installRecords: validRecords } }), "valid"],
  ] as const)("independent record parsing: %s", async (_label, valueJson, status) => {
    const stateDir = makeTempDir();
    insertPersistedIndexRow(stateDir, valueJson);
    await expectRecordState(stateDir, status, status === "valid" ? validRecords : null);
  });
});
