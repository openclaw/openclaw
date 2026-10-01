import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { restoreFailedUpdateDatabases } from "../cli/update-cli/update-command-database-backup.js";
import { recordUpdateDatabaseWrites } from "../cli/update-cli/update-command-database-receipts.js";
import type { UpdateDatabaseBackup } from "../infra/update-database-backup.js";
import { readUpdateDatabaseGenerations } from "../infra/update-database-generations.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

it.each(["during", "missing-foreign"])(
  "refuses rollback attribution for a foreign write during Doctor maintenance (%s)",
  async (scenario) => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "doctor-foreign-write" },
      async (state) => {
        openOpenClawStateDatabase();
        await closeOpenClawStateDatabaseAsync();
        const pathname = state.path("agent.sqlite");
        if (scenario === "during") {
          const seed = new DatabaseSync(pathname);
          seed.exec("CREATE TABLE evidence(value INTEGER); INSERT INTO evidence VALUES (1)");
          seed.close();
        }
        const databaseGenerations = readUpdateDatabaseGenerations([pathname]);
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
            if (scenario === "missing-foreign") {
              foreign.exec("CREATE TABLE evidence(value INTEGER)");
            }
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
            missingPaths: scenario === "missing-foreign" ? [pathname] : [],
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
          expect(backup.migration).toBeUndefined();
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
  },
);
