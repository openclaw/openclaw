import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import {
  clearSubagentRunsReadCacheForTest,
  persistSubagentRunsToDiskOrThrow,
} from "../../agents/subagents/registry/subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  hasUnsettledCronDescendants,
  readDescendantExecutionState,
} from "./run-subagent-registry.runtime.js";
import { readDescendantSubagentFallbackReply } from "./subagent-followup.js";

const sessionKey = "agent:main:cron:worker-read:run:current";

async function withPersistedCronRuns(run: () => Promise<void>) {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      openOpenClawStateDatabase();
      clearSubagentRunsReadCacheForTest();
      try {
        await run();
      } finally {
        clearSubagentRunsReadCacheForTest();
      }
    },
  );
}

function completedChild(text = "Completed child answer") {
  return createSubagentRunRecord({
    runId: "cron-worker-child",
    requesterSessionKey: sessionKey,
    requesterDisplayKey: sessionKey,
    childSessionKey: "agent:main:subagent:cron-worker-child",
    createdAt: 10,
    execution: { status: "terminal", endedAt: 20, outcome: { status: "ok" } },
    completion: { required: false, terminalReply: { disposition: "visible", text } },
    delivery: { status: "not_required" },
  });
}

function holdCompactWorkerReply() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const execute = stateReads.executeExistingOpenClawStateRead;
  let held = false;
  const read = vi
    .spyOn(stateReads, "executeExistingOpenClawStateRead")
    .mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (!held && args[1].type === "subagents.sessionList") {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    });
  return { entered: entered.promise, release: release.resolve, read };
}

it("keeps the host responsive while Cron descendant fallback awaits a real worker", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      openOpenClawStateDatabase();
      const child = completedChild();
      saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
      clearSubagentRunsReadCacheForTest();
      const gate = holdCompactWorkerReply();
      const parent = observeParentSqlite();
      let settled = false;
      const pending = readDescendantSubagentFallbackReply({ sessionKey, runStartedAt: 10 });
      const outcome = pending.finally(() => {
        settled = true;
      });
      void outcome.catch(() => {});
      try {
        expect(parent.counts).toEqual(emptySqliteCounts());
        expect(
          await Promise.race([gate.entered.then(() => "worker"), outcome.then(() => "completed")]),
        ).toBe("worker");
        await nextTurn();
        expect(settled).toBe(false);
        expect(parent.counts).toEqual(emptySqliteCounts());
        gate.release();
        expect(await outcome).toBe("Completed child answer");
        expect(parent.counts).toEqual(emptySqliteCounts());
      } finally {
        gate.release();
        await outcome.catch(() => {});
        parent.restore();
        gate.read.mockRestore();
        clearSubagentRunsReadCacheForTest();
      }
    },
  );
});

it.each(["update", "delete", "successor", "other requester"] as const)(
  "uses a committed %s published while the Cron worker reply is pending",
  async (change) => {
    await withPersistedCronRuns(async () => {
      const child = completedChild();
      saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
      clearSubagentRunsReadCacheForTest();
      const gate = holdCompactWorkerReply();
      const pending = readDescendantSubagentFallbackReply({ sessionKey, runStartedAt: 10 });
      void pending.catch(() => {});
      try {
        expect(
          await Promise.race([gate.entered.then(() => "worker"), pending.then(() => "completed")]),
        ).toBe("worker");
        const replacement = {
          ...completedChild("Current child answer"),
          ...(change === "successor" || change === "other requester"
            ? {
                runId: "successor",
                generation: 2,
                createdAt: 30,
                execution: { status: "terminal" as const, endedAt: 40 },
              }
            : {}),
          ...(change === "other requester" ? { requesterSessionKey: "agent:main:other" } : {}),
        };
        persistSubagentRunsToDiskOrThrow(
          change === "delete" ? new Map() : new Map([[replacement.runId, replacement]]),
          [replacement.runId],
        );
        gate.release();
        expect(await pending).toBe(
          change === "delete" || change === "other requester" ? undefined : "Current child answer",
        );
      } finally {
        gate.release();
        await pending.catch(() => {});
        gate.read.mockRestore();
      }
    });
  },
);

it.each(["close", "source replacement", "caller cancellation"] as const)(
  "refuses Cron fallback after %s during the worker read",
  async (change) => {
    await withPersistedCronRuns(async () => {
      const child = completedChild();
      saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
      clearSubagentRunsReadCacheForTest();
      const context = captureOpenClawStateWorkerContext();
      const gate = holdCompactWorkerReply();
      const work = new AsyncWorkScope();
      const pending = work.track(() =>
        readDescendantSubagentFallbackReply({ sessionKey, runStartedAt: 10 }),
      );
      const outcome = pending.catch((error: unknown) => error);
      try {
        expect(
          await Promise.race([gate.entered.then(() => "worker"), outcome.then(() => "completed")]),
        ).toBe("worker");
        if (change === "caller cancellation") {
          const reason = new Error("Cron read owner canceled");
          work.beginClose(reason);
          gate.release();
          expect(await outcome).toBe(reason);
        } else if (change === "close") {
          const closing = closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
          gate.release();
          await closing;
          expect(await outcome).toMatchObject({
            message: expect.stringMatching(/read admission/u),
          });
        } else {
          const other = await createOpenClawTestState({ scenario: "minimal", applyEnv: false });
          try {
            await withEnvAsync({ OPENCLAW_STATE_DIR: other.stateDir }, async () => {
              saveSubagentRegistryToSqlite(
                new Map([[child.runId, completedChild("Other source")]]),
              );
              gate.release();
              expect(await outcome).toMatchObject({
                message: expect.stringMatching(/database changed|read admission/u),
              });
            });
          } finally {
            await other.cleanup();
          }
        }
      } finally {
        gate.release();
        await outcome;
        await work.drain();
        gate.read.mockRestore();
      }
    });
  },
);

it.each([
  { createdAt: 10, startedAt: 30, fresh: true },
  { createdAt: 30, startedAt: undefined, fresh: true },
  { createdAt: 30, startedAt: 10, fresh: false },
])("projects settled descendant freshness in the same read frame: %j", async (row) => {
  await withPersistedCronRuns(async () => {
    const child = {
      ...completedChild(),
      createdAt: row.createdAt,
      execution: { status: "terminal" as const, startedAt: row.startedAt, endedAt: 40 },
    };
    saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
    clearSubagentRunsReadCacheForTest();
    expect(await readDescendantExecutionState(sessionKey, 25)).toEqual({
      hasFreshDescendants: row.fresh,
      hasActiveDescendants: false,
    });
  });
});

it.each(["running", "yielded", "queued delivery"] as const)(
  "keeps %s descendants unsettled independently of execution activity",
  async (phase) => {
    await withPersistedCronRuns(async () => {
      const child = createSubagentRunRecord({
        runId: "pending-child",
        requesterSessionKey: sessionKey,
        childSessionKey: "agent:main:subagent:pending-child",
        createdAt: 10,
        execution:
          phase === "running" ? { status: "running" } : { status: "terminal", endedAt: 20 },
        completion: { required: phase === "queued delivery" },
        ...(phase === "yielded" ? { pauseReason: "sessions_yield" as const } : {}),
        delivery:
          phase === "queued delivery"
            ? { status: "in_progress", disposition: "session_queued" }
            : { status: "not_required" },
      });
      saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
      clearSubagentRunsReadCacheForTest();
      expect(await hasUnsettledCronDescendants(sessionKey)).toBe(true);
      expect(await readDescendantExecutionState(sessionKey, 25)).toEqual({
        hasFreshDescendants: false,
        hasActiveDescendants: phase === "running",
      });
    });
  },
);
