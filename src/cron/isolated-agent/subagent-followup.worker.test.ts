import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { mutateSubagentRuns } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import { saveSubagentRegistryToSqlite } from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { hasUnsettledCronDescendants } from "./run-subagent-registry.runtime.js";
import { readDescendantSubagentFallbackReply } from "./subagent-followup.js";

const sessionKey = "agent:main:cron:worker-read:run:current";

function withPersistedCronRuns<Args extends unknown[]>(run: (...args: Args) => Promise<void>) {
  return (...args: Args) =>
    withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        openOpenClawStateDatabase();
        clearSubagentRunsReadCacheForTest();
        try {
          await run(...args);
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
    completion: {
      required: false,
      resultText: text,
      terminalReply: { disposition: "visible", text },
    },
    delivery: { status: "not_required" },
  });
}

async function withPendingReply(
  run: (release: () => void, pending: Promise<string | undefined>) => Promise<void>,
  work?: AsyncWorkScope,
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const execute = stateReads.executeExistingOpenClawStateRead;
  let held = false;
  const readSpy = vi
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
  const read = () => readDescendantSubagentFallbackReply({ sessionKey, runStartedAt: 10 });
  const pending = work ? work.track(read) : read();
  void pending.catch(() => {});
  try {
    expect(
      await Promise.race([entered.promise.then(() => "worker"), pending.then(() => "completed")]),
    ).toBe("worker");
    await run(release.resolve, pending);
  } finally {
    release.resolve();
    await pending.catch(() => {});
    await work?.drain();
    readSpy.mockRestore();
  }
}

function persistChild(child = completedChild()) {
  saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
  clearSubagentRunsReadCacheForTest();
  return child;
}

it(
  "keeps the host responsive while Cron descendant fallback awaits a real worker",
  withPersistedCronRuns(async () => {
    persistChild();
    const parent = observeParentSqlite();
    try {
      await withPendingReply(async (release, pending) => {
        expect(await Promise.race([pending, nextTurn().then(() => "responsive")])).toBe(
          "responsive",
        );
        expect(parent.counts).toEqual(emptySqliteCounts());
        release();
        expect(await pending).toBe("Completed child answer");
        expect(parent.counts).toEqual(emptySqliteCounts());
      });
    } finally {
      parent.restore();
    }
  }),
);

it.each(["update", "delete", "successor", "other requester"] as const)(
  "uses a committed %s published while the Cron worker reply is pending",
  withPersistedCronRuns(async (change) => {
    const child = persistChild();
    await withPendingReply(async (release, pending) => {
      const replacement = completedChild("Current child answer");
      if (change === "successor" || change === "other requester") {
        Object.assign(replacement, {
          runId: "successor",
          generation: 2,
          createdAt: 30,
          execution: { status: "terminal", endedAt: 40 },
        } satisfies Partial<SubagentRunRecord>);
      }
      if (change === "other requester") {
        replacement.requesterSessionKey = "agent:main:other";
      }
      const postimages = new Map<string, SubagentRunRecord | null>([[child.runId, null]]);
      if (change !== "delete") {
        postimages.set(replacement.runId, replacement);
      }
      await mutateSubagentRuns(
        [child.runId, replacement.runId],
        () => ({ value: undefined, postimages }),
        { runs: new Map([[child.runId, child]]) },
      );
      release();
      expect(await pending).toBe(
        change === "delete" || change === "other requester" ? undefined : "Current child answer",
      );
    });
  }),
);

it.each(["close", "caller cancellation"] as const)(
  "refuses Cron fallback after %s during the worker read",
  withPersistedCronRuns(async (change) => {
    persistChild();
    const context = captureOpenClawStateWorkerContext();
    const work = new AsyncWorkScope();
    await withPendingReply(async (release, pending) => {
      const outcome = pending.catch((error: unknown) => error);
      if (change === "caller cancellation") {
        const reason = new Error("Cron read owner canceled");
        work.beginClose(reason);
        release();
        expect(await outcome).toBe(reason);
      } else {
        const closing = closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
        release();
        await closing;
        expect(await outcome).toMatchObject({
          message: expect.stringMatching(/read admission/u),
        });
      }
    }, work);
  }),
);

it.each(["running", "yielded", "queued delivery"] as const)(
  "keeps %s descendants unsettled independently of execution activity",
  withPersistedCronRuns(async (phase) => {
    const child = completedChild();
    child.execution =
      phase === "running" ? { status: "running" } : { status: "terminal", endedAt: 20 };
    child.completion = { required: phase === "queued delivery" };
    child.pauseReason = phase === "yielded" ? "sessions_yield" : undefined;
    child.delivery =
      phase === "queued delivery"
        ? { status: "in_progress", disposition: "session_queued" }
        : { status: "not_required" };
    persistChild(child);
    expect(await hasUnsettledCronDescendants(sessionKey)).toBe(true);
  }),
);
