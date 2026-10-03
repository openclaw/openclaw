import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { recordOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import * as doctorSchema from "../state/openclaw-state-db-doctor-schema.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { setupDoctorAdmissionFixture } from "./doctor-maintenance.admission.test-support.js";

const fixture = setupDoctorAdmissionFixture();

function maintenanceScope(admission: () => void) {
  return createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: admission,
  });
}

it("rechecks warm Doctor maintenance without hashing or copying the complete shared store", async () => {
  const schemaAdmission = vi.spyOn(doctorSchema, "openDoctorStateSchemaReadAdmission");
  const { admission, assertIsolation } = fixture(true);
  const maintenance = maintenanceScope(admission);
  const hashes = vi.spyOn(snapshots, "readSqliteSourceContentVersionSync");
  const copies = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
  try {
    schemaAdmission.mockClear();
    maintenance.run(() => {
      hashes.mockClear();
      copies.mockClear();
      maintenance.assertAdmission();
      maintenance.assertAdmission();
      maintenance.assertAdmission();
      expect(hashes).not.toHaveBeenCalled();
      expect(copies).not.toHaveBeenCalled();
      expect(schemaAdmission).toHaveBeenCalledOnce();
    });
  } finally {
    await maintenance.close();
    assertIsolation();
  }
});

it("refuses replacement while the current maintenance reader is bound", async () => {
  const { database, admission, assertIsolation } = fixture(true);
  const maintenance = maintenanceScope(admission);
  const original = `${database}.original`;
  try {
    maintenance.run(() => {
      maintenance.assertAdmission();
      fs.renameSync(database, original);
      try {
        fs.copyFileSync(original, database);
        expect(() => maintenance.assertAdmission()).toThrow("identity changed");
      } finally {
        fs.rmSync(database, { force: true });
        fs.renameSync(original, database);
      }
    });
  } finally {
    await maintenance.close();
    assertIsolation();
  }
});

it("refuses a foreign schema version change through the retained reader", async () => {
  const { database, admission, assertIsolation } = fixture(true);
  const maintenance = maintenanceScope(admission);
  const peer = new DatabaseSync(database);
  try {
    maintenance.run(() => {
      maintenance.assertAdmission();
      peer.exec("PRAGMA user_version = 999999");
      expect(() => maintenance.assertAdmission()).toThrow(/schema|version/i);
    });
  } finally {
    await maintenance.close();
    peer.close();
    assertIsolation();
  }
});

it("refuses new quarantine under the retained native maintenance reader", async () => {
  const { env, database, admission, assertIsolation } = fixture(true);
  const maintenance = maintenanceScope(admission);
  try {
    maintenance.run(() => {
      maintenance.assertAdmission();
      expect(
        recordOpenClawDatabaseQuarantine({
          env,
          kind: "state",
          path: database,
          reason: "new maintenance quarantine",
        }),
      ).toBe(true);
      expect(() => maintenance.assertAdmission()).toThrow("new maintenance quarantine");
    });
  } finally {
    await maintenance.close();
    assertIsolation();
  }
});

it("binds the reader to Doctor's native source and drains before cold restoration", async () => {
  const { env, admission, assertIsolation } = fixture();
  const maintenance = maintenanceScope(admission);
  const hashes = vi.spyOn(snapshots, "readSqliteSourceContentVersionSync");
  try {
    maintenance.run(() => {
      const native = openOpenClawStateDatabase({ env });
      hashes.mockClear();
      maintenance.assertAdmission();
      native.db.exec("BEGIN IMMEDIATE");
      try {
        native.db.exec(
          "UPDATE update_runs SET status = 'running', phase = 'requested', finished_at_ms = NULL",
        );
        // Policy sees committed rows through its independent reader even when
        // the original native source is holding the caller's write transaction.
        maintenance.assertAdmission();
      } finally {
        native.db.exec("ROLLBACK");
      }
      expect(hashes).not.toHaveBeenCalled();
    });
    await maintenance.close();
    hashes.mockClear();
    expect(() => admission()).not.toThrow();
    expect(hashes).toHaveBeenCalled();
  } finally {
    await maintenance.close();
    assertIsolation();
  }
});

it("observes foreign commits without uncommitted rows or inherited discovery snapshots", async () => {
  const { env, database, admission, assertIsolation } = fixture(true);
  const maintenance = maintenanceScope(admission);
  const peer = new DatabaseSync(database);
  const runId = peer.prepare("SELECT run_id FROM update_runs").get()?.run_id;
  expect(typeof runId).toBe("string");
  try {
    await maintenance.run(async () => {
      maintenance.assertAdmission();
      await withOpenClawStateDatabaseReadSnapshot(
        async () => {
          peer.exec("BEGIN IMMEDIATE");
          peer.exec(
            "UPDATE update_runs SET status = 'running', phase = 'requested', finished_at_ms = NULL",
          );
          expect(() => maintenance.assertAdmission()).not.toThrow();
          peer.exec("COMMIT");
          expect(() => maintenance.assertAdmission()).toThrow(String(runId));
        },
        { env },
      );
    });
  } finally {
    if (peer.isTransaction) {
      peer.exec("ROLLBACK");
    }
    await maintenance.close();
    peer.close();
    assertIsolation();
  }
});
