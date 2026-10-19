import { describe, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createCronMutationCompletion } from "../mutation-completion.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import { stop } from "./ops-lifecycle.js";
import { add, remove, update } from "./ops-mutations.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-mutation-completion" });

function createMutationState(storePath: string) {
  return createCronRegressionState({
    storePath,
    cronEnabled: false,
    log: logger,
    nowMs: Date.now,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, delivered: true })),
  });
}

describe("Cron mutation completion", () => {
  it("records actual mutations while leaving declaration replay, rejection, and absent removal unmarked", async () => {
    const { storePath } = await makeStorePath();
    const state = createMutationState(storePath);
    const input = {
      declarationKey: "plugin:test:completion",
      name: "mutation completion",
      enabled: true,
      schedule: { kind: "every" as const, everyMs: 60_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "run", toolsAllow: ["*"] },
    };
    const guarded = { commitGuard: () => {} };
    try {
      const created = createCronMutationCompletion("cron.add")!;
      const job = await created.run(() => add(state, input, guarded));
      expect(created.isCommitted()).toBe(true);

      const replay = createCronMutationCompletion("cron.add")!;
      await expect(replay.run(() => add(state, input, guarded))).resolves.toMatchObject({
        created: false,
        updated: false,
      });
      expect(replay.isCommitted()).toBe(false);

      const updated = createCronMutationCompletion("cron.update")!;
      await updated.run(() => update(state, job.id, { description: "changed" }, guarded));
      expect(updated.isCommitted()).toBe(true);

      const rejected = createCronMutationCompletion("cron.update")!;
      await expect(
        rejected.run(() =>
          update(
            state,
            job.id,
            {},
            {
              commitGuard: () => {
                throw new Error("caller revoked");
              },
            },
          ),
        ),
      ).rejects.toThrow("caller revoked");
      expect(rejected.isCommitted()).toBe(false);

      const removed = createCronMutationCompletion("cron.remove")!;
      await expect(removed.run(() => remove(state, job.id, guarded))).resolves.toMatchObject({
        removed: true,
      });
      expect(removed.isCommitted()).toBe(true);

      const absent = createCronMutationCompletion("cron.remove")!;
      await expect(absent.run(() => remove(state, job.id, guarded))).resolves.toMatchObject({
        removed: false,
      });
      expect(absent.isCommitted()).toBe(false);
    } finally {
      stop(state);
    }
  });

  it("leaves completion unmarked when the native commit fails", async () => {
    const { storePath } = await makeStorePath();
    const state = createMutationState(storePath);
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
      await expect(
        completion.run(() =>
          add(
            state,
            {
              name: "durable completion boundary",
              enabled: true,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "run" },
            },
            { commitGuard: () => {} },
          ),
        ),
      ).rejects.toThrow("FOREIGN KEY constraint failed");
      expect((await loadCronStore(storePath)).jobs).toHaveLength(0);
      expect(completion.isCommitted()).toBe(false);
    } finally {
      database.exec(`
        DROP TRIGGER reject_cron_job_commit;
        DROP TABLE cron_commit_failure_child;
        DROP TABLE cron_commit_failure_parent;
      `);
      stop(state);
    }
  });
});
