import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  resolveStateDatabaseCoordinatorPath,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "./state-database-coordinator.js";
import { createUpdateRun, recordUpdateRunPhase } from "./update-run-ledger.js";

function withLedgerFixture<T>(
  operation: (fixture: {
    root: string;
    pathname: string;
    coordinatorPath: string;
    options: { env: { OPENCLAW_STATE_DIR: string }; busyTimeoutMs: number };
    run: ReturnType<typeof createUpdateRun>;
    peer: DatabaseSync;
  }) => T,
): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-contention-"));
  const options = { env: { OPENCLAW_STATE_DIR: root }, busyTimeoutMs: 1000 };
  const pathname = resolveOpenClawStateSqlitePath(options.env);
  const runtimeDirectory = path.join(root, "locks");
  try {
    return withStateDatabaseCoordinatorRuntimeDirectory(runtimeDirectory, () => {
      const run = createUpdateRun({ trigger: "cli" }, options);
      const peer = new DatabaseSync(pathname, { timeout: 0 });
      try {
        return operation({
          root,
          pathname,
          options,
          run,
          peer,
          coordinatorPath: resolveStateDatabaseCoordinatorPath({
            databasePath: pathname,
            runtimeDirectory,
            uid: process.getuid?.(),
          }),
        });
      } finally {
        vi.restoreAllMocks();
        peer.close();
        closeOpenClawStateDatabaseForTest();
      }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Observe the real scan boundary without replacing any SQLite query or result.
function observeIntegrity(pathname: string, observe: (database: DatabaseSync) => void) {
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted native database receiver.
  const original = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (/^PRAGMA\s+integrity_check\b/i.test(sql) && this.location() === pathname) {
      observe(this);
    }
    return original.call(this, sql);
  });
}

it("keeps a second writer available during repeated update-ledger integrity preparation", () => {
  withLedgerFixture(({ root, pathname, coordinatorPath, options, run, peer }) => {
    const lifecycleAdmissions: number[] = [];
    const denied: string[] = [];
    observeIntegrity(pathname, () => {
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
        import { DatabaseSync } from "node:sqlite";
        const db = new DatabaseSync(process.argv[1], { timeout: 0 });
        try { db.exec("BEGIN EXCLUSIVE; ROLLBACK"); }
        finally { db.close(); }
      `,
          coordinatorPath,
        ],
        { env: { ...process.env, OPENCLAW_STATE_DIR: root }, encoding: "utf8", timeout: 5000 },
      );
      lifecycleAdmissions.push(child.status ?? -1);
      try {
        peer.exec("BEGIN IMMEDIATE; ROLLBACK");
      } catch (error) {
        denied.push(String(error));
      }
    });
    for (const phase of ["staging", "validating", "activating"] as const) {
      expect(recordUpdateRunPhase(run.runId, phase, {}, options).phase).toBe(phase);
    }
    expect(lifecycleAdmissions).toEqual([0, 0, 0]);
    expect(denied).toEqual([]);
    expect(peer.prepare("SELECT phase FROM update_runs WHERE run_id=?").get(run.runId)?.phase).toBe(
      "activating",
    );
  });
});

it.each(["healthy", "foreign-key violation"] as const)(
  "revalidates a peer's %s commit before publishing the update phase",
  (scenario) =>
    withLedgerFixture(({ pathname, options, run, peer }) => {
      peer.exec(
        "CREATE TABLE proof_parent(id INTEGER PRIMARY KEY); CREATE TABLE proof_child(parent INTEGER REFERENCES proof_parent(id)); INSERT INTO proof_parent VALUES(1); PRAGMA foreign_keys=OFF",
      );
      let scans = 0;
      observeIntegrity(pathname, () => {
        if (++scans === 1) {
          peer.prepare("INSERT INTO proof_child VALUES(?)").run(scenario === "healthy" ? 1 : 2);
        }
      });
      if (scenario === "healthy") {
        expect(recordUpdateRunPhase(run.runId, "staging", {}, options).phase).toBe("staging");
      } else {
        expect(() => recordUpdateRunPhase(run.runId, "staging", {}, options)).toThrow(
          /foreign_key_check/,
        );
      }
      expect(scans).toBe(2);
      expect(
        peer.prepare("SELECT phase FROM update_runs WHERE run_id=?").get(run.runId)?.phase,
      ).toBe(scenario === "healthy" ? "staging" : run.phase);
      expect(peer.prepare("SELECT COUNT(*) AS n FROM proof_child").get()?.n).toBe(1);
    }),
);

it("honors an external owner's claim committed during integrity preparation", () => {
  withLedgerFixture(({ pathname, options, run, peer }) => {
    let claimed = false;
    observeIntegrity(pathname, () => {
      if (!claimed) {
        claimed = true;
        peer
          .prepare(
            "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES(?,?,?)",
          )
          .run(
            "gateway.supervision",
            JSON.stringify({
              version: 1,
              mode: "external",
              managerId: "proof-supervisor",
              claimedAt: 1,
            }),
            1,
          );
      }
    });
    expect(() => recordUpdateRunPhase(run.runId, "staging", {}, options)).toThrow(
      /externally supervised by proof-supervisor/,
    );
    expect(claimed).toBe(true);
    expect(peer.prepare("SELECT phase FROM update_runs WHERE run_id=?").get(run.runId)?.phase).toBe(
      run.phase,
    );
  });
});

it("retains the exact native handle until failed retirement can reacquire admission", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-retirement-custody-"));
  const options = { env: { OPENCLAW_STATE_DIR: root }, busyTimeoutMs: 0 };
  const pathname = resolveOpenClawStateSqlitePath(options.env);
  const runtimeDirectory = path.join(root, "locks");
  const flags = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  let worker: Worker | undefined;
  let workerExit: Promise<number> | undefined;
  let retained: DatabaseSync | undefined;
  try {
    await withStateDatabaseCoordinatorRuntimeDirectory(runtimeDirectory, async () => {
      const run = createUpdateRun({ trigger: "cli" }, options);
      closeOpenClawStateDatabaseForTest();
      const coordinatorPath = resolveStateDatabaseCoordinatorPath({
        databasePath: pathname,
        runtimeDirectory,
        uid: process.getuid?.(),
      });
      observeIntegrity(pathname, (database) => {
        if (!worker) {
          retained = database;
          worker = new Worker(
            `
            const { workerData } = require("node:worker_threads");
            const { DatabaseSync } = require("node:sqlite");
            const flags = new Int32Array(workerData.buffer);
            const db = new DatabaseSync(workerData.pathname, {timeout: 0});
            try {
              db.exec("BEGIN EXCLUSIVE");
              Atomics.store(flags, 0, 1);
              Atomics.notify(flags, 0);
              if (Atomics.wait(flags, 1, 0, 10000) === "timed-out") throw new Error("Parent did not release fixture lock");
            } catch (error) {
              Atomics.store(flags, 0, -1);
              Atomics.notify(flags, 0);
              throw error;
            } finally {
              if (db.isTransaction) db.exec("ROLLBACK");
              db.close();
            }
          `,
            {
              eval: true,
              workerData: { buffer: flags.buffer, pathname: coordinatorPath },
              env: { ...process.env, OPENCLAW_STATE_DIR: root },
            },
          );
          workerExit = new Promise((resolve, reject) => {
            worker!.once("error", reject);
            worker!.once("exit", resolve);
          });
          Atomics.wait(flags, 0, 0, 5000);
          expect(Atomics.load(flags, 0)).toBe(1);
        }
      });
      expect(() => recordUpdateRunPhase(run.runId, "staging", {}, options)).toThrow(
        /update.run and coordinator release both failed/,
      );
      expect(retained?.isOpen).toBe(true);
      vi.restoreAllMocks();
      Atomics.store(flags, 1, 1);
      Atomics.notify(flags, 1);
      expect(await workerExit).toBe(0);
      workerExit = undefined;
      expect(closeOpenClawStateDatabaseByPath(pathname)).toBe(true);
      expect(retained?.isOpen).toBe(false);
      const peer = new DatabaseSync(pathname, { readOnly: true });
      try {
        expect(
          peer.prepare("SELECT phase FROM update_runs WHERE run_id=?").get(run.runId)?.phase,
        ).toBe(run.phase);
      } finally {
        peer.close();
      }
    });
  } finally {
    vi.restoreAllMocks();
    Atomics.store(flags, 1, 1);
    Atomics.notify(flags, 1);
    if (workerExit) {
      await workerExit;
    }
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
