import { describe, expect, it, vi } from "vitest";
import {
  resolveSchemaMigrationBackupTables,
  resolveSchemaMigrationIntegrityCheck,
} from "./schema-migration-backup-scope.js";

// mock-isolation: Synthetic declarations test selection without certifying real migration scopes.
vi.mock("./schema-migration-backup-tables.js", () => ({
  SCHEMA_MIGRATION_BACKUP_TABLES: {
    agent: { 27: ["outbox"], 28: ["other", "outbox"] },
    state: { 23: ["receipts"] },
  },
}));

describe("schema migration backup scope", () => {
  it("unions every declared pending step with schema metadata", () => {
    expect(
      resolveSchemaMigrationBackupTables({
        kind: "agent",
        foundVersion: 26,
        supportedVersion: 28,
      }),
    ).toEqual(["other", "outbox", "schema_meta"]);
  });

  it.each([
    ["undeclared first step", 25, 27],
    ["mixed declared and undeclared steps", 26, 29],
    ["same-version repair", 27, 27],
    ["unversioned database", 0, 27],
    ["downgrade", 28, 27],
  ])("retains full backup for %s", (_name, foundVersion, supportedVersion) => {
    expect(
      resolveSchemaMigrationBackupTables({ kind: "agent", foundVersion, supportedVersion }),
    ).toBeUndefined();
  });

  it("includes shared-state content publication metadata", () => {
    expect(
      resolveSchemaMigrationBackupTables({ kind: "state", foundVersion: 22, supportedVersion: 23 }),
    ).toEqual(["config_machine_state", "receipts", "schema_meta"]);
  });

  it("selects quick integrity independently of historical backup eligibility", () => {
    expect(
      resolveSchemaMigrationIntegrityCheck({
        kind: "agent",
        foundVersion: 26,
        supportedVersion: 28,
      }),
    ).toMatchObject({
      check: "quick",
      tables: expect.arrayContaining(["other", "outbox", "schema_meta"]),
    });
    expect(
      resolveSchemaMigrationIntegrityCheck({
        kind: "agent",
        foundVersion: 25,
        supportedVersion: 28,
      }),
    ).toMatchObject({
      check: "quick",
      tables: expect.arrayContaining(["transcript_events", "session_nodes", "schema_meta"]),
    });
    expect(
      resolveSchemaMigrationIntegrityCheck(
        { kind: "agent", foundVersion: 26, supportedVersion: 28 },
        "full",
      ),
    ).toEqual({ check: "full" });
  });
});
