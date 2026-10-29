import "./backup-worker.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { withLegacyStateHeadLayout } from "../../state/openclaw-state-db-schema-v26-layout.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  restorePreTemplateStateIdentifiersForTest,
} from "../../state/openclaw-state-schema.test-support.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import * as snapshotSource from "../sqlite-snapshot-source.js";
import { inspectDatabaseStore, type DatabaseStoreInspection } from "./diagnostics.js";
import { writePortAnchor } from "./port-backup.test-support.js";
import type { PortDescriptor } from "./port-types.js";
import { loadStatePortDescriptor } from "./state-port-descriptor.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const descriptor: PortDescriptor = {
  id: "workboard",
  version: 2,
  minimumPostgresVersion: 16,
  tables: [],
  sqlite: "",
  preData: "",
  postData: "",
  expectedCatalog: [],
};
function fixture(): DatabaseStoreInspection {
  return {
    family: "workboard",
    path: path.join(directories.make("database-diagnostics-"), "store.sqlite"),
    configured: { default: "sqlite", override: null, effective: "sqlite", fixedLocal: false },
    descriptor,
  };
}
function createStore(input: DatabaseStoreInspection, version: number) {
  using db = openNodeSqliteDatabase(input.path!);
  db.exec(`PRAGMA user_version = ${version}; CREATE TABLE entries (id TEXT PRIMARY KEY)`);
}
async function inspectUnchanged(input: DatabaseStoreInspection) {
  const before = fs.readFileSync(input.path!);
  const result = await inspectDatabaseStore(input);
  expect(fs.readFileSync(input.path!)).toEqual(before);
  return result;
}
async function stateStore(version: number) {
  const input = fixture();
  input.family = "state";
  input.descriptor = await loadStatePortDescriptor();
  using db = openNodeSqliteDatabase(input.path!);
  for (const schema of [input.descriptor, ...(input.descriptor.fragments ?? [])]) {
    db.exec(version === 25 ? withLegacyStateHeadLayout(schema.sqlite) : schema.sqlite);
  }
  if (version === 25) {
    restorePreTemplateStateIdentifiersForTest(db);
    addPreCutoverClientCredentialTablesForTest(db);
  }
  db.exec(`PRAGMA user_version = ${version};
    INSERT INTO schema_meta VALUES ('primary', 'global', ${version}, NULL, NULL, 1, 1);
    INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '${version}', 1)`);
  return input;
}

describe("physical store diagnostics", () => {
  it("reports missing and damaged stores as unknown without creating or repairing them", async () => {
    const input = fixture();
    expect(await inspectDatabaseStore(input)).toMatchObject({
      issues: [],
      observed: "unknown",
      mismatch: null,
      schema: { version: null, pending: null },
      connectivity: "unknown",
    });
    expect(fs.existsSync(input.path!)).toBe(false);
    fs.writeFileSync(input.path!, "not a sqlite database");
    const damaged = await inspectUnchanged(input);
    expect(damaged.observed).toBe("unknown");
    expect(damaged.nextSteps.join(" ")).toContain("doctor --fix");
  });

  it("keeps inaccessible stores as warnings instead of treating them as absent", async () => {
    const input = fixture();
    vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("access denied"), { code: "EACCES" });
    });
    const result = await inspectDatabaseStore(input);
    expect(result.observed).toBe("unknown");
    expect(result.issues).toEqual(["The physical store path could not be inspected."]);
    expect(result.nextSteps.join(" ")).toContain("permissions");
  });

  it.each([
    [1, "sqlite", 2, 1, "doctor --fix"],
    [2, "postgres", 2, 0, "database port"],
    [0, "sqlite", null, null, "backup"],
  ] as const)(
    "inspects SQLite %i against %s without blocking or changing bytes",
    async (version, effective, expectedVersion, pending, fix) => {
      const input = fixture();
      if (expectedVersion === null) {
        Object.assign(input, {
          family: "managed-update",
          descriptor: undefined,
          schemaVersion: null,
        });
      }
      createStore(input, version);
      input.configured = { ...input.configured, default: effective, effective };
      const actual = await vi.importActual<typeof snapshotSource>("../sqlite-snapshot-source.js");
      vi.spyOn(snapshotSource, "prepareSqliteReadOnlyLocation").mockImplementation(
        actual.prepareSqliteReadOnlyLocation,
      );
      const turn = vi.fn();
      setImmediate(turn);
      const result = await inspectUnchanged(input);
      expect(turn).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        observed: "sqlite",
        mismatch: effective !== "sqlite",
        schema: {
          versioning: expectedVersion === null ? "unversioned" : "versioned",
          version: expectedVersion === null ? null : version,
          expectedVersion,
          pending,
        },
        connectivity: "local",
        custody: "unverifiable",
        lease: "unverifiable",
        backup: null,
      });
      expect(result.nextSteps.join(" ")).toContain(fix);
      expect(result.nextSteps.join(" ")).not.toContain("expected schema version");
    },
  );

  it.each([
    {
      version: 25,
      pending: OPENCLAW_STATE_SCHEMA_VERSION - 25,
      issue: "Schema migrations pending",
    },
    { version: OPENCLAW_STATE_SCHEMA_VERSION + 1, pending: 0, issue: "newer than supported" },
  ])(
    "preserves readable state schema $version when port admission refuses it",
    async ({ version, pending, issue }) => {
      const input = await stateStore(version);
      const result = await inspectUnchanged(input);
      expect(result.schema).toEqual({
        versioning: "versioned",
        version,
        expectedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
        pending,
      });
      expect(result.issues.join(" ")).toContain(issue);
      expect(result.issues).toContain(
        "The SQLite schema could not be admitted by its store owner.",
      );
      expect(result.nextSteps.join(" ")).toContain("doctor --fix");
    },
  );

  it("admits retained legacy state without requiring first-use schema migrations", async () => {
    const input = await stateStore(OPENCLAW_STATE_SCHEMA_VERSION);
    {
      using db = openNodeSqliteDatabase(input.path!);
      // Published installs retain fleet rows after tenant-container retirement.
      db.exec(`CREATE TABLE fleet_cells (tenant_id TEXT PRIMARY KEY) STRICT;
        INSERT INTO fleet_cells VALUES ('retired');
        ALTER TABLE agent_deletion_journal DROP COLUMN phase;
        INSERT INTO agent_deletion_journal
          (agent_id, agent_dir, workspace_dir, sessions_dir, created_at)
        VALUES ('retired', '/retired/agent', '/retired/workspace', '/retired/sessions', 17)`);
    }
    const result = await inspectUnchanged(input);
    expect(result.schema).toMatchObject({
      version: OPENCLAW_STATE_SCHEMA_VERSION,
      expectedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      pending: 0,
    });
    expect(result.issues).toEqual([]);
  });

  it("keeps a PostgreSQL anchor observable when its connection is missing or unreachable", async () => {
    const input = fixture();
    input.configured.effective = "postgres";
    writePortAnchor(input.path!, "fixture-store", "fixture_namespace");
    const unresolved = await inspectDatabaseStore(input);
    expect(unresolved).toMatchObject({
      observed: "postgres",
      mismatch: false,
      namespace: "fixture_namespace",
      storeId: "fixture-store",
      connectivity: "unknown",
      schema: { version: null, pending: null },
    });
    input.postgres = {
      connection: "postgresql://test:never-print-this@127.0.0.1:1/postgres",
      schemaPrefix: "fixture",
    };
    const unreachable = await inspectDatabaseStore(input);
    expect(unreachable.connectivity).toBe("unreachable");
    expect(unreachable.schema.version).toBeNull();
    expect(unreachable.nextSteps.join(" ")).toContain("service/port");
    expect(JSON.stringify(unreachable)).not.toContain("never-print-this");
  });
});
