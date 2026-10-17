import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { restoreFailedUpdateDatabases } from "../cli/update-cli/update-command-database-backup.js";
import { recordUpdateDatabaseWrites } from "../cli/update-cli/update-command-database-receipts.js";
import type { UpdateDatabaseBackup } from "../infra/update-database-backup.js";
import { readUpdatePhysicalDatabaseGenerations } from "../infra/update-database-generations.js";
import { readUpdateDatabaseGenerations } from "../infra/update-database-generations.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { finishUpdateRun } from "../infra/update-run-write.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveDoctorUpdateAdmission } from "./doctor-maintenance-admission.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

it.each([false, true])(
  "attributes native idle WAL close without accepting foreign writes (foreign write: %s)",
  async (foreignWrite) => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "doctor-captured-wal" },
      async (state) => {
        const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
        finishUpdateRun(run.runId, { status: "succeeded" }, { env: state.env });
        const pathname = openOpenClawStateDatabase({ env: state.env }).path;
        await closeOpenClawStateDatabaseAsync();
        // Retain real idle WAL bookkeeping as after a process exits without native close.
        const child = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { DatabaseSync } from 'node:sqlite';
           const db = new DatabaseSync(process.argv[1]);
           db.exec('PRAGMA journal_mode=WAL; UPDATE update_runs SET updated_at_ms = updated_at_ms + 1; PRAGMA wal_checkpoint(TRUNCATE)');
           process.kill(process.pid, 'SIGKILL');`,
            pathname,
          ],
          { encoding: "utf8", timeout: 10_000 },
        );
        expect(child.error).toBeUndefined();
        expect(child.status, child.stderr).not.toBe(0);
        expect(fs.existsSync(`${pathname}-shm`)).toBe(true);
        const databaseGenerations = readUpdateDatabaseGenerations([pathname]);
        const admission = resolveDoctorUpdateAdmission(state.env);
        const maintenance = await beginDoctorMaintenance({
          root: null,
          options: { repair: true, nonInteractive: true },
          runtime: { log() {}, error() {}, exit() {} },
          databaseGenerations,
          assertCurrent: admission.assertCurrent,
        });
        try {
          maintenance!.run(() => {
            expect(openOpenClawStateDatabase({ env: state.env }).path).toBe(pathname);
            admission.assertCurrent();
          });
          if (foreignWrite) {
            const writer = spawnSync(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                `import { DatabaseSync } from 'node:sqlite';
               const db = new DatabaseSync(process.argv[1]);
               db.prepare('INSERT INTO config_machine_state VALUES (?, ?, ?)')
                 .run('test.foreign-write', '99', 1);
               db.close();`,
                pathname,
              ],
              { encoding: "utf8", timeout: 10_000 },
            );
            expect(writer.error).toBeUndefined();
            expect(writer.status, writer.stderr).toBe(0);
          }
          await maintenance!.releaseState();
          expect(maintenance!.databaseWrites?.unchanged).toBe(!foreignWrite);
          expect(maintenance!.databaseWrites?.fromGenerations).toEqual(databaseGenerations);
          if (foreignWrite) {
            const preserved = new DatabaseSync(pathname, { readOnly: true });
            try {
              expect(
                preserved
                  .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
                  .get("test.foreign-write"),
              ).toEqual({ value_json: "99" });
            } finally {
              preserved.close();
            }
          }
        } finally {
          await maintenance?.release();
        }
      },
    );
  },
);

it("refuses rollback attribution for a foreign write during Doctor maintenance", async () => {
  await withOpenClawTestState(
    { scenario: "external-service", label: "doctor-foreign-write" },
    async (state) => {
      openOpenClawStateDatabase();
      await closeOpenClawStateDatabaseAsync();
      const pathname = state.path("agent.sqlite");
      const seed = new DatabaseSync(pathname);
      seed.exec("CREATE TABLE evidence(value INTEGER); INSERT INTO evidence VALUES (1)");
      seed.close();
      const databaseGenerations = await readUpdatePhysicalDatabaseGenerations([pathname]);
      const maintenance = await beginDoctorMaintenance({
        root: null,
        options: { repair: true, nonInteractive: true },
        runtime: { log() {}, error() {}, exit() {} },
        databaseGenerations,
      });
      try {
        expect(maintenance).toBeDefined();
        expect(maintenance!.databaseWrites).toBeUndefined();
        // A raw SQLite connection does not participate in Gateway ownership.
        // Doctor never opens this database or owns this writer's transaction.
        const foreign = new DatabaseSync(pathname);
        try {
          foreign.exec("INSERT INTO evidence VALUES (99)");
        } finally {
          foreign.close();
        }
        await maintenance!.releaseState();
        const receipt = maintenance!.databaseWrites;
        expect(receipt?.generations[pathname]).not.toBe(databaseGenerations[pathname]);
        expect(receipt?.unchanged).toBe(false);

        const backup: UpdateDatabaseBackup = {
          directory: state.path("retained-snapshots"),
          databases: [],
          missingPaths: [],
          sourcePaths: [pathname],
          sourceGenerations: databaseGenerations,
          warnings: [],
        };
        recordUpdateDatabaseWrites(backup, receipt, {
          name: "doctor",
          command: "doctor --fix",
          cwd: state.stateDir,
          durationMs: 0,
          exitCode: 1,
        });
        expect(backup.restoreRefusal).toContain("the writer is unknown");
        const result: UpdateRunResult = {
          status: "error",
          mode: "npm",
          steps: [],
          durationMs: 0,
        };
        expect(
          await restoreFailedUpdateDatabases({
            backup,
            result,
            runId: "foreign-write",
            env: state.env,
            assertCurrent() {},
          }),
        ).toBe(false);
        expect(result.reason).toBe("state-migrated-no-rollback");
        expect(result.steps[0]?.stderrTail).toContain("run openclaw doctor from the candidate");
        const preserved = new DatabaseSync(pathname, { readOnly: true });
        try {
          expect(preserved.prepare("SELECT value FROM evidence WHERE value = 99").get()).toEqual({
            value: 99,
          });
        } finally {
          preserved.close();
        }
      } finally {
        await maintenance?.release();
      }
    },
  );
});
