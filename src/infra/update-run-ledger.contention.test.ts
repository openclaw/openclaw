import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseByPathAsync,
} from "../state/openclaw-state-db-cache.js";
import { closeTrackedStateDatabase } from "../state/openclaw-state-db-handle.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createUpdateRun, recordUpdateRunPhase } from "./update-run-ledger.js";

async function withLedgerFixture(
  operation: (fixture: {
    pathname: string;
    options: { path: string; env: NodeJS.ProcessEnv; busyTimeoutMs: number };
    run: ReturnType<typeof createUpdateRun>;
    peer: DatabaseSync;
    observeIntegrity: (observe: (database: DatabaseSync) => void) => void;
  }) => void,
  invalid = false,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-contention-"));
  const env = {
    HOME: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
  };
  const source = resolveOpenClawStateSqlitePath(env);
  const pathname = path.join(root, "imported.sqlite");
  const options = { path: pathname, env, busyTimeoutMs: 1000 };
  let peer: DatabaseSync | undefined;
  const observed = new Set<DatabaseSync>();
  try {
    const run = createUpdateRun({ trigger: "cli" }, { env });
    const seed = new DatabaseSync(source);
    try {
      if (invalid) {
        seed.exec(`
          CREATE TABLE proof_parent(id INTEGER PRIMARY KEY);
          CREATE TABLE proof_child(parent INTEGER REFERENCES proof_parent(id));
          PRAGMA foreign_keys=OFF;
          INSERT INTO proof_child VALUES(2);
        `);
      }
      // A synthetic imported file has a new physical identity and no admission.
      // Keep the public writer fixture tiny; never copy an operator database.
      seed.prepare("VACUUM INTO ?").run(pathname);
    } finally {
      seed.close();
    }
    await closeOpenClawStateDatabaseByPathAsync(source);
    peer = new DatabaseSync(pathname, { timeout: 0 });
    operation({
      pathname,
      options,
      run,
      peer,
      observeIntegrity: (observe) => {
        // Observe the real scan without replacing any query or result.
        // oxlint-disable-next-line typescript/unbound-method -- Delegate with the intercepted native receiver.
        const original = DatabaseSync.prototype.prepare;
        vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
          this: DatabaseSync,
          sql: string,
        ) {
          if (/^PRAGMA\s+integrity_check\b/i.test(sql) && this.location() === pathname) {
            observed.add(this);
            observe(this);
          }
          return original.call(this, sql);
        });
      },
    });
  } finally {
    vi.restoreAllMocks();
    peer?.close();
    try {
      await closeOpenClawStateDatabaseByPathAsync(pathname);
      await closeOpenClawStateDatabaseByPathAsync(source);
    } finally {
      for (const database of observed) {
        if (database.isOpen) {
          closeTrackedStateDatabase(database);
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

it("keeps a second writer available during cold update-ledger integrity reads", async () => {
  await withLedgerFixture(({ pathname, options, run, peer, observeIntegrity }) => {
    const control = new DatabaseSync(pathname);
    try {
      control.exec("BEGIN IMMEDIATE");
      expect(() => peer.exec("BEGIN IMMEDIATE; ROLLBACK")).toThrow(/locked|busy/iu);
      control.exec("ROLLBACK");
    } finally {
      control.close();
    }
    const denied: string[] = [];
    let scans = 0;
    observeIntegrity(() => {
      scans += 1;
      try {
        peer.exec("BEGIN IMMEDIATE; ROLLBACK");
      } catch (error) {
        denied.push(String(error));
      }
    });
    for (const phase of ["staging", "validating", "activating"] as const) {
      expect(recordUpdateRunPhase(run.runId, phase, {}, options).phase).toBe(phase);
    }
    expect(scans).toBeGreaterThan(0);
    expect(denied).toEqual([]);
    expect(peer.prepare("SELECT phase FROM update_runs WHERE run_id=?").get(run.runId)?.phase).toBe(
      "activating",
    );
  });
});

it("honors an external owner's claim committed during integrity preparation", async () => {
  await withLedgerFixture(({ options, run, peer, observeIntegrity }) => {
    let claimed = false;
    observeIntegrity(() => {
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

it.each(["committed", "refused"] as const)(
  "retains the exact native handle when a %s update cannot close",
  async (outcome) => {
    await withLedgerFixture(({ pathname, options, run, peer, observeIntegrity }) => {
      let retained: DatabaseSync | undefined;
      const closeFailure = new Error("fixture native close refused");
      observeIntegrity((database) => {
        if (!retained) {
          retained = database;
          vi.spyOn(database, "close").mockImplementation(() => {
            throw closeFailure;
          });
        }
      });
      let failure: unknown;
      try {
        recordUpdateRunPhase(run.runId, "staging", {}, options);
      } catch (error) {
        failure = error;
      }
      if (outcome === "refused") {
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).cause).toBeInstanceOf(Error);
        expect(String((failure as AggregateError).cause)).toMatch(/foreign_key_check/);
        expect((failure as AggregateError).errors).toContain(closeFailure);
      } else {
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).cause).toBe(closeFailure);
      }
      expect(retained?.isOpen).toBe(true);
      expect(() => closeOpenClawStateDatabaseByPath(pathname)).toThrow(closeFailure);
      expect(retained?.isOpen).toBe(true);
      vi.restoreAllMocks();
      expect(closeOpenClawStateDatabaseByPath(pathname)).toBe(true);
      expect(retained?.isOpen).toBe(false);
      expect(
        peer.prepare("SELECT phase FROM update_runs WHERE run_id=?").get(run.runId)?.phase,
      ).toBe(outcome === "committed" ? "staging" : run.phase);
    }, outcome === "refused");
  },
);
