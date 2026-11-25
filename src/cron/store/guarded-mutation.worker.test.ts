import { expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { mutateCronJobsInWorker } from "./guarded-mutation.worker.js";
import type { CronJobMutation } from "./job-mutations.types.js";
import { removeCronSchedulerSnapshot } from "./scheduler-config.worker.js";

it("reuses one inventory per mutation while publishing names and preserving definition generations", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-mutation-inventory-" },
    async (state) => {
      const database = openOpenClawStateDatabase();
      const storeKey = state.statePath("cron", "jobs.json");
      let nowMs = 1_000;
      const reads = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(database.db),
        ["jobs"],
        (sql) => (/^select\b/i.test(sql) && sql.includes('"cron_jobs"') ? "jobs" : null),
      );
      const mutate = (jobMutation: CronJobMutation) => {
        const before = reads.counts.jobs;
        const result = runWithSqliteWorkerStateContext(
          { environment: { OPENCLAW_STATE_DIR: state.stateDir } },
          () =>
            mutateCronJobsInWorker(database, {
              storeKey,
              jobMutation,
              snapshot: {
                nowMs: nowMs++,
                scheduler: { config: { cronEnabled: false, defaultAgentId: "main" } },
              },
            }),
        );
        expect(reads.counts.jobs - before, jobMutation.kind).toBe(1);
        if (!("outcome" in result)) {
          throw new Error(`Unexpected ${jobMutation.kind} refusal`);
        }
        expect(result.outcome.changed).toBe(true);
        return result.outcome;
      };
      const readRow = () =>
        database.db
          .prepare(
            "SELECT name, enabled, grant_definition_generation FROM cron_jobs WHERE store_key = ? AND job_id = ?",
          )
          .get(storeKey, "job");
      try {
        const added = mutate({
          kind: "add",
          input: {
            id: "job",
            name: "Original",
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "main",
            wakeMode: "next-heartbeat",
            payload: { kind: "systemEvent", text: "Synthetic event" },
          },
          options: { captured: false },
        });
        expect(added.names).toEqual(new Map([["job", "Original"]]));
        expect(readRow()).toEqual({ name: "Original", enabled: 1, grant_definition_generation: 1 });

        const disabled = mutate({
          kind: "update",
          id: "job",
          patch: { enabled: false },
          options: { captured: false },
        });
        expect(disabled.names).toEqual(added.names);
        expect(readRow()).toEqual({ name: "Original", enabled: 0, grant_definition_generation: 1 });

        const renamed = mutate({
          kind: "update",
          id: "job",
          patch: { name: "Renamed" },
          options: { captured: false },
        });
        expect(renamed.names).toEqual(new Map([["job", "Renamed"]]));
        expect(readRow()).toEqual({ name: "Renamed", enabled: 0, grant_definition_generation: 2 });

        const removed = mutate({ kind: "remove", ids: ["job"] });
        expect(removed.names.size).toBe(0);
        expect(removed.store.jobs).toEqual([]);
        expect(readRow()).toBeUndefined();
      } finally {
        reads.restore();
        removeCronSchedulerSnapshot(storeKey, database.path);
      }
    },
  );
});
