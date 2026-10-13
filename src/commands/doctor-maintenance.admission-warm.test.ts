import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createSystemdCommandQuery } from "../daemon/systemd-command-query.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import { createUpdateRun, recordUpdateRunRepairContinuation } from "../infra/update-run-ledger.js";
import * as ledger from "../infra/update-run-ledger.js";
import { recordOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  isOpenClawStateDatabaseOpen,
} from "../state/openclaw-state-db-cache.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveDoctorUpdateAdmission } from "./doctor-maintenance-admission.js";
import { setupDoctorAdmissionFixture } from "./doctor-maintenance.admission.test-support.js";
import { stoppedSystemdBinding } from "./doctor-maintenance.test-support.js";

const fixture = setupDoctorAdmissionFixture();

function maintenanceScope(admission: () => void) {
  return createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: admission,
  });
}

it("admits fast systemd inspection after a slow continuation write", async () => {
  const { env, assertIsolation } = fixture();
  const run = createUpdateRun(
    { trigger: "cli", origin: { driver: readUpdateRunDriver() } },
    { env },
  );
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const recordContinuation = ledger.recordUpdateRunRepairContinuation;
  vi.spyOn(ledger, "recordUpdateRunRepairContinuation").mockImplementation((...args) => {
    const result = recordContinuation(...args);
    elapsed += 6_000;
    return result;
  });
  recordUpdateRunRepairContinuation(run.runId, run.runId, { env });
  expect(elapsed).toBeGreaterThanOrEqual(6_000);
  await closeOpenClawStateDatabaseAsync();
  const admitted = resolveDoctorUpdateAdmission(env, run.runId);
  const binding = stoppedSystemdBinding(() => {});
  const reader = await createSystemdCommandQuery(
    env,
    binding.unit,
    {
      timeoutMs: 5_000,
      requireLoaded: true,
      systemdReadBinding: binding,
      loadForInspection: {
        managerUid: binding.managerUid,
        assertCurrent: admitted.recordContinuation,
      },
    },
    () => new Error("systemd inspection unavailable"),
  );
  try {
    await expect(
      reader.query(
        ["get-property", binding.destination, "/unit", "org.freedesktop.systemd1.Unit", "Id"],
        ["s"],
      ),
    ).resolves.toEqual([binding.unit]);
    const competing = createUpdateRun({ trigger: "cli" }, { env });
    expect(() => admitted.recordContinuation()).toThrow(competing.runId);
  } finally {
    await reader.close();
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
      expect(isOpenClawStateDatabaseOpen(database)).toBe(false);
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
  const copies = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
  try {
    maintenance.run(() => {
      const native = openOpenClawStateDatabase({ env });
      hashes.mockClear();
      copies.mockClear();
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
      expect(copies).not.toHaveBeenCalled();
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

it("refuses a competing run after replacement of an already admitted source", async () => {
  const { env, database, admission, createStateDir, assertIsolation } = fixture(true);
  const replacement = createStateDir();
  const competing = createUpdateRun(
    { trigger: "cli" },
    { env: { ...env, OPENCLAW_STATE_DIR: replacement } },
  );
  await closeOpenClawStateDatabaseAsync();
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

it("refuses new quarantine with a cold reader and unchanged ledger bytes", () => {
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
