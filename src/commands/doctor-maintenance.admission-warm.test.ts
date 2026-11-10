import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createSystemdCommandQuery } from "../daemon/systemd-command-query.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import { createUpdateRun, recordUpdateRunRepairContinuation } from "../infra/update-run-ledger.js";
import * as ledger from "../infra/update-run-ledger.js";
import { seedOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.test-support.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  isOpenClawStateDatabaseOpen,
} from "../state/openclaw-state-db-cache.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { admitOpenClawMaintenanceLiveAuthorityReads } from "../state/openclaw-state-maintenance-context.js";
import { resolveDoctorUpdateAdmission } from "./doctor-maintenance-admission.js";
import { setupDoctorAdmissionFixture } from "./doctor-maintenance.admission.test-support.js";
import { stoppedSystemdBinding } from "./doctor-maintenance.test-support.js";

const fixture = setupDoctorAdmissionFixture();
const warmSources = ["cached-writer", "admitted-read-only"] as const;
const runningSql =
  "UPDATE update_runs SET status = 'running', phase = 'requested', finished_at_ms = NULL";
async function withMaintenance(
  source: (typeof warmSources)[number] | "cold-read-only",
  action: (
    context: ReturnType<typeof fixture> & {
      maintenance: ReturnType<typeof maintenanceScope>;
      openPeer: () => DatabaseSync;
    },
  ) => void | Promise<void>,
) {
  using context = fixture(source === "cached-writer");
  const maintenance = maintenanceScope(
    context.admission,
    source === "admitted-read-only" ? context.database : undefined,
  );
  let peer: DatabaseSync | undefined;
  const openPeer = () => (peer ??= new DatabaseSync(context.database));
  try {
    await maintenance.run(() => action({ ...context, maintenance, openPeer }));
  } finally {
    await maintenance.close();
    peer?.close();
  }
}

function maintenanceScope(admission: () => void, database?: string, admit = true) {
  const scope = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: admission,
    assertDatabaseAccess: (pathname) => expect(pathname).toBe(database),
  });
  if (database && admit) {
    scope.run(() => admitOpenClawMaintenanceLiveAuthorityReads(database));
  }
  return scope;
}

it("admits fast systemd inspection after a slow continuation write", async () => {
  using context = fixture();
  const { env } = context;
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
  }
});

it.each(warmSources)("refuses replacement while the %s maintenance reader is bound", (source) =>
  withMaintenance(source, ({ database, maintenance }) => {
    const original = `${database}.original`;
    maintenance.assertAdmission();
    fs.renameSync(database, original);
    try {
      fs.copyFileSync(original, database);
      expect(() => maintenance.assertAdmission()).toThrow("identity changed");
    } finally {
      fs.rmSync(database, { force: true });
      fs.renameSync(original, database);
    }
  }),
);

it.each(warmSources)("refuses a foreign schema version change through the %s reader", (source) =>
  withMaintenance(source, ({ maintenance, openPeer }) => {
    const peer = openPeer();
    maintenance.assertAdmission();
    peer.exec("PRAGMA user_version = 999999");
    expect(() => maintenance.assertAdmission()).toThrow(/schema|version/i);
  }),
);

it.each(warmSources)("refuses new quarantine under the %s maintenance reader", (source) =>
  withMaintenance(source, ({ env, database, maintenance }) => {
    maintenance.assertAdmission();
    seedOpenClawDatabaseQuarantine({
      env,
      kind: "state",
      path: database,
      reason: "new maintenance quarantine",
    });
    expect(() => maintenance.assertAdmission()).toThrow("new maintenance quarantine");
    expect(isOpenClawStateDatabaseOpen(database)).toBe(false);
  }),
);

it.each(warmSources)(
  "binds the reader to Doctor's %s source and drains before cold restoration",
  async (source) => {
    using context = fixture();
    const { env, database, admission } = context;
    const maintenance = maintenanceScope(admission, database, false);
    const hashes = vi.spyOn(snapshots, "readSqliteSourceContentVersionSync");
    const copies = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
    try {
      maintenance.run(() => {
        if (source === "admitted-read-only") {
          admitOpenClawMaintenanceLiveAuthorityReads(database);
        }
        const db =
          source === "cached-writer"
            ? openOpenClawStateDatabase({ env }).db
            : new DatabaseSync(database);
        hashes.mockClear();
        copies.mockClear();
        maintenance.assertAdmission();
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec(runningSql);
          // Policy sees committed rows through its independent reader even when
          // the original native source is holding the caller's write transaction.
          maintenance.assertAdmission();
        } finally {
          db.exec("ROLLBACK");
          if (source === "admitted-read-only") {
            db.close();
          }
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
    }
  },
);

it.each(["cached-writer", "admitted-read-only", "cold-read-only"] as const)(
  "observes %s foreign commits without uncommitted rows or inherited discovery snapshots",
  (source) =>
    withMaintenance(source, async ({ env, database, maintenance, openPeer }) => {
      const peer = openPeer();
      const runId = peer.prepare("SELECT run_id FROM update_runs").get()?.run_id;
      expect(typeof runId).toBe("string");
      try {
        maintenance.assertAdmission();
        await withOpenClawStateDatabaseReadSnapshot(
          async () => {
            peer.exec("BEGIN IMMEDIATE");
            peer.exec(runningSql);
            expect(() => maintenance.assertAdmission()).not.toThrow();
            if (source === "cold-read-only") {
              const observe = fs.lstatSync;
              let pendingCommit = true;
              using _ = vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
                const observed = observe(...args);
                // Commit after the last file observation used to select a cached revision.
                if (pendingCommit && args[0] === `${database}-journal`) {
                  pendingCommit = false;
                  peer.exec("COMMIT");
                }
                return observed;
              });

              expect(() => maintenance.assertAdmission()).toThrow(String(runId));
              expect(pendingCommit).toBe(false);
            } else {
              peer.exec("COMMIT");
              expect(() => maintenance.assertAdmission()).toThrow(String(runId));
            }
          },
          { env },
        );
      } finally {
        if (peer.isTransaction) {
          peer.exec("ROLLBACK");
        }
      }
    }),
);

it("refuses committed WAL updates while preserving all live source artifacts", () => {
  using context = fixture(true);
  const { env, admission, family } = context;
  const before = family();
  admission();
  expect(family()).toEqual(before);
  const competing = createUpdateRun({ trigger: "cli" }, { env });
  const committed = family();
  expect(() => admission()).toThrow(competing.runId);
  expect(family()).toEqual(committed);
});

it("refuses a competing run after replacement of an already admitted source", async () => {
  using context = fixture(true);
  const { env, database, admission, createStateDir } = context;
  const replacement = createStateDir();
  const competing = createUpdateRun(
    { trigger: "cli" },
    { env: { ...env, OPENCLAW_STATE_DIR: replacement } },
  );
  await closeOpenClawStateDatabaseAsync();
  fs.renameSync(path.join(replacement, "state", "openclaw.sqlite"), database);
  expect(() => admission()).toThrow(competing.runId);
});

it("does not borrow a retained discovery snapshot for current admission", async () => {
  using context = fixture();
  const { env, admission } = context;
  await withOpenClawStateDatabaseReadSnapshot(
    async () => {
      const competing = createUpdateRun({ trigger: "cli" }, { env });
      expect(() => admission()).toThrow(competing.runId);
    },
    { env },
  );
});

it("refuses new quarantine with a cold reader and unchanged ledger bytes", () => {
  using context = fixture();
  const { env, database, admission, family } = context;
  const before = family();
  seedOpenClawDatabaseQuarantine({
    env,
    kind: "state",
    path: database,
    reason: "fresh quarantine refusal",
  });
  expect(() => admission()).toThrow("fresh quarantine refusal");
  expect(family()).toEqual(before);
});
