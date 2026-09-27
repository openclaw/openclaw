import { describe, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
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

  it("retains a committed add when its post-commit reporting fails", async () => {
    const { storePath } = await makeStorePath();
    const state = createMutationState(storePath);
    const completion = createCronMutationCompletion("cron.add")!;
    const failure = new Error("post-commit reporting failed");
    const info = vi.spyOn(state.deps.log, "info").mockImplementationOnce(() => {
      throw failure;
    });
    try {
      await expect(
        completion.run(() =>
          add(
            state,
            {
              name: "committed before reporting",
              enabled: true,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "run" },
            },
            { commitGuard: () => {} },
          ),
        ),
      ).rejects.toBe(failure);
      expect(completion.isCommitted()).toBe(true);
      expect((await loadCronStore(storePath)).jobs).toHaveLength(1);
    } finally {
      info.mockRestore();
      stop(state);
    }
  });

  it.each(["commit", "coordinator release"] as const)(
    "records durable completion accurately when %s fails",
    async (boundary) => {
      const { storePath } = await makeStorePath();
      const state = createMutationState(storePath);
      const completion = createCronMutationCompletion("cron.add")!;
      const database = openOpenClawStateDatabase().db;
      const { DatabaseSync } = requireNodeSqlite();
      // oxlint-disable-next-line typescript/unbound-method -- Every delegated call restores the intercepted database as its receiver.
      const originalExec = DatabaseSync.prototype.exec;
      const failure = new Error(`simulated ${boundary} failure`);
      let committed = false;
      let injected = false;
      const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
        this: import("node:sqlite").DatabaseSync,
        sql: string,
      ) {
        if (this === database && sql === "COMMIT" && boundary === "commit") {
          injected = true;
          throw failure;
        }
        originalExec.call(this, sql);
        if (this === database && sql === "COMMIT") {
          committed = true;
        }
        if (this !== database && sql === "ROLLBACK" && committed && !injected) {
          injected = true;
          throw failure;
        }
      });
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
        ).rejects.toThrow(
          boundary === "commit"
            ? "simulated commit failure"
            : "completed, but releasing its coordinator failed",
        );
        expect(injected).toBe(true);
        exec.mockRestore();
        expect((await loadCronStore(storePath)).jobs).toHaveLength(
          boundary === "coordinator release" ? 1 : 0,
        );
        expect(completion.isCommitted()).toBe(boundary === "coordinator release");
      } finally {
        exec.mockRestore();
        stop(state);
      }
    },
  );
});
