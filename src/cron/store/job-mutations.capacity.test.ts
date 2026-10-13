import { afterAll, beforeAll, expect, it } from "vitest";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { mutateCronJobsInWorker } from "./guarded-mutation.worker.js";
import type { CronJobMutation, CronJobMutationSnapshot } from "./job-mutations.types.js";
import { prepareCronJobMutationInWorker } from "./job-mutations.worker.js";
import { loadCronStoreFromDatabase } from "./load.kernel.js";
import { ensureCronRunReceiptSchema } from "./run-receipt-store.js";

const snapshot: CronJobMutationSnapshot = {
  nowMs: Date.parse("2026-10-11T12:00:00.000Z"),
  scheduler: {
    version: 1,
    config: { cronEnabled: true, defaultAgentId: "main", cronConfig: { maxJobs: 1 } },
  },
};
let fixture: OpenClawTestState;
let database: ReturnType<typeof openOpenClawStateDatabase>;

beforeAll(async () => {
  fixture = await createOpenClawTestState({ label: "cron-job-capacity" });
  database = openOpenClawStateDatabase();
  ensureCronRunReceiptSchema(database.db);
});

afterAll(async () => {
  await fixture?.cleanup();
});

function clientCreate(id: string): CronJobMutation {
  return {
    kind: "add",
    input: {
      id,
      name: id,
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: id },
    },
    options: { enforceJobLimit: true, captured: false },
  };
}

it("refuses a create prepared below cron.maxJobs once another create commits first", () => {
  const storeKey = fixture.statePath("cron", "capacity.json");
  runWithSqliteWorkerStateContext(
    { environment: { ...fixture.env, OPENCLAW_STATE_DIR: fixture.stateDir } },
    () => {
      const prepared = clientCreate("prepared");
      expect(
        prepareCronJobMutationInWorker(database, { storeKey, mutation: prepared, snapshot }),
      ).toMatchObject({ outcome: { created: true } });
      expect(
        mutateCronJobsInWorker(database, {
          storeKey,
          jobMutation: clientCreate("winner"),
          snapshot,
        }),
      ).toHaveProperty("outcome");

      expect(() =>
        mutateCronJobsInWorker(database, { storeKey, jobMutation: prepared, snapshot }),
      ).toThrow(/^cron job limit reached: 1 of 1 /);
      const rows = loadCronStoreFromDatabase(database.db, storeKey).store.jobs;
      expect(rows.map((job) => job.id)).toEqual(["winner"]);
    },
  );
});
