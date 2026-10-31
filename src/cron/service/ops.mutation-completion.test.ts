import { afterEach, beforeEach, expect, it } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createCronMutationCompletion } from "../mutation-completion.js";
import { cronTestInput } from "../service.fixture-builders.test-support.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import { stop } from "./ops-lifecycle.js";
import { add, remove, update } from "./ops-mutations.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-mutation-completion" });
const guarded = { commitGuard: () => {} };

let storePath: string;
let state: ReturnType<typeof createCronRegressionState>;
beforeEach(async () => {
  ({ storePath } = await makeStorePath());
  state = createCronRegressionState({
    storePath,
    cronEnabled: false,
    log: logger,
    runIsolatedAgentJob: async () => ({ status: "ok", delivered: true }),
  });
});
afterEach(() => stop(state));

async function complete<T>(method: string, action: () => Promise<T>, committed: boolean) {
  const completion = createCronMutationCompletion(method)!;
  const result = await completion.run(action);
  expect(completion.isCommitted()).toBe(committed);
  return result;
}

it("records actual mutations while leaving declaration replay, rejection, and absent removal unmarked", async () => {
  const input = {
    ...cronTestInput(),
    declarationKey: "plugin:test:completion",
    payload: { kind: "agentTurn" as const, message: "run", toolsAllow: ["*"] },
  };
  const job = await complete("cron.add", () => add(state, input, guarded), true);

  expect(await complete("cron.add", () => add(state, input, guarded), false)).toMatchObject({
    created: false,
    updated: false,
  });
  await complete(
    "cron.update",
    () => update(state, job.id, { description: "changed" }, guarded),
    true,
  );

  const rejected = createCronMutationCompletion("cron.update")!;
  const commitGuard = () => {
    throw new Error("caller revoked");
  };
  await expect(rejected.run(() => update(state, job.id, {}, { commitGuard }))).rejects.toThrow(
    "caller revoked",
  );
  expect(rejected.isCommitted()).toBe(false);

  for (const removed of [true, false]) {
    expect(
      await complete("cron.remove", () => remove(state, job.id, guarded), removed),
    ).toMatchObject({ removed });
  }
});

it("leaves completion unmarked when the native commit fails", async () => {
  const completion = createCronMutationCompletion("cron.add")!;
  const database = openOpenClawStateDatabase().db;
  // A deferred constraint reaches the worker's native COMMIT after the job write succeeds.
  database.exec(`
      CREATE TABLE cron_commit_failure_parent (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE cron_commit_failure_child (
        parent_id TEXT REFERENCES cron_commit_failure_parent(id) DEFERRABLE INITIALLY DEFERRED
      ) STRICT;
      CREATE TRIGGER reject_cron_job_commit AFTER INSERT ON cron_jobs
      BEGIN
        INSERT INTO cron_commit_failure_child (parent_id) VALUES (NEW.job_id);
      END;
    `);
  try {
    await expect(completion.run(() => add(state, cronTestInput(), guarded))).rejects.toThrow(
      "FOREIGN KEY constraint failed",
    );
    expect((await loadCronStore(storePath)).jobs).toHaveLength(0);
    expect(completion.isCommitted()).toBe(false);
  } finally {
    database.exec(`
        DROP TRIGGER reject_cron_job_commit;
        DROP TABLE cron_commit_failure_child;
        DROP TABLE cron_commit_failure_parent;
      `);
  }
});
