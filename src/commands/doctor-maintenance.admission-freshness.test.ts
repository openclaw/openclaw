import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as sqliteSnapshotSource from "../infra/sqlite-snapshot-source.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { recordOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db-cache.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { setupDoctorAdmissionFixture } from "./doctor-maintenance.admission.test-support.js";

const fixture = setupDoctorAdmissionFixture();

it("refuses committed WAL updates while preserving all live source artifacts", () => {
  const { env, admission, family, assertIsolation } = fixture(true);
  const before = family();
  admission();
  expect(family()).toEqual(before);
  const competing = createUpdateRun({ trigger: "cli" }, { env });
  const committed = family();
  try {
    expect(() => admission()).toThrow(competing.runId);
    expect(family()).toEqual(committed);
  } finally {
    assertIsolation();
  }
});

it("refuses a competing run after replacement of an already admitted source", () => {
  const { env, database, admission, createStateDir, assertIsolation } = fixture();
  const replacement = createStateDir();
  const competing = createUpdateRun(
    { trigger: "cli" },
    { env: { ...env, OPENCLAW_STATE_DIR: replacement } },
  );
  closeOpenClawStateDatabaseForTest();
  fs.renameSync(path.join(replacement, "state", "openclaw.sqlite"), database);
  try {
    expect(() => admission()).toThrow(competing.runId);
  } finally {
    assertIsolation();
  }
});

it("does not borrow a retained discovery snapshot for current admission", async () => {
  const { env, admission, assertIsolation } = fixture();
  try {
    await withOpenClawStateDatabaseReadSnapshot(
      async () => {
        const competing = createUpdateRun({ trigger: "cli" }, { env });
        expect(() => admission()).toThrow(competing.runId);
      },
      { env },
    );
  } finally {
    assertIsolation();
  }
});

it("refuses new quarantine even when the admitted ledger bytes are unchanged", () => {
  const { env, database, admission, family, assertIsolation } = fixture();
  const before = family();
  expect(
    recordOpenClawDatabaseQuarantine({
      env,
      kind: "state",
      path: database,
      reason: "fresh quarantine refusal",
    }),
  ).toBe(true);
  try {
    expect(() => admission()).toThrow("fresh quarantine refusal");
    expect(family()).toEqual(before);
  } finally {
    assertIsolation();
  }
});

it("reads current warm maintenance rows without hashing the shared database", async () => {
  const { database, admission, assertIsolation } = fixture(true);
  const resources = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent() {},
    assertDatabaseAccess() {},
  });
  const version = vi.spyOn(sqliteSnapshotSource, "readSqliteSourceContentVersionSync");
  try {
    resources.run(() => {
      admission();
      admission();
      expect(version).not.toHaveBeenCalled();
      const foreign = new DatabaseSync(database);
      try {
        const row = foreign.prepare("SELECT run_id FROM update_runs LIMIT 1").get();
        foreign.exec(
          "UPDATE update_runs SET status = 'running', phase = 'requested', finished_at_ms = NULL",
        );
        expect(() => admission()).toThrow(String(row?.run_id));
        expect(version).not.toHaveBeenCalled();
      } finally {
        foreign.close();
      }
    });
  } finally {
    await resources.close();
    assertIsolation();
  }
});

it.runIf(process.platform !== "win32")(
  "invalidates a warm admission owner after source replacement",
  async () => {
    const { env, database, admission, createStateDir, assertIsolation } = fixture(true);
    const original = openOpenClawStateDatabase({ env });
    original.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    const replacement = createStateDir();
    const competing = createUpdateRun(
      { trigger: "cli" },
      { env: { ...env, OPENCLAW_STATE_DIR: replacement } },
    );
    const successor = openOpenClawStateDatabase({
      env: { ...env, OPENCLAW_STATE_DIR: replacement },
    });
    successor.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    const resources = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent() {},
      assertDatabaseAccess() {},
    });
    const previous = `${database}.previous`;
    try {
      resources.run(() => {
        admission();
        fs.renameSync(database, previous);
        fs.renameSync(path.join(replacement, "state", "openclaw.sqlite"), database);
        expect(() => admission()).toThrow(competing.runId);
      });
    } finally {
      if (fs.existsSync(previous)) {
        fs.renameSync(database, path.join(replacement, "state", "openclaw.sqlite"));
        fs.renameSync(previous, database);
      }
      await resources.close();
      assertIsolation();
    }
  },
);
