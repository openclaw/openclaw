import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import {
  persistRegistryFixture,
  saveSubagentRegistryToSqlite,
} from "../subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  prepareSubagentSessionListReadCache,
  withSubagentRunReadSnapshot,
} from "../subagents/registry/subagent-registry-state.js";
import * as registryState from "../subagents/registry/subagent-registry-state.js";
import { createSubagentsTool } from "./subagents-tool.js";

it("keeps persisted subagent wait selection off the calling thread", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      const ownerKey = "agent:main:main";
      const childKey = "agent:main:subagent:persisted-wait";
      const run = createSubagentRunRecord({
        runId: "physical-run",
        taskRunId: "logical-run",
        generation: 1,
        childSessionKey: childKey,
        requesterSessionKey: ownerKey,
        requesterAgentId: "main",
        completion: { required: false },
        delivery: { status: "not_required" },
      });
      persistRegistryFixture(new Map([[run.runId, run]]));
      clearSubagentRunsReadCacheForTest();
      let registryReads = 0;
      const statements = (["get", "all", "iterate"] as const).map((method) => {
        const execute = StatementSync.prototype[method];
        return vi.spyOn(StatementSync.prototype, method).mockImplementation(function (
          this: StatementSync,
          ...args: unknown[]
        ) {
          if (/\bfrom\s+"?subagent_runs\b/i.test(this.sourceSQL)) {
            registryReads++;
          }
          return Reflect.apply(execute, this, args);
        });
      });
      try {
        const result = await createSubagentsTool({ agentSessionKey: ownerKey, config: {} }).execute(
          "wait",
          { action: "wait", runIds: [run.runId], timeoutSeconds: 0 },
        );
        expect(result.details).toMatchObject({
          reason: "timeout",
          runs: [{ runId: run.runId }],
        });
        expect(registryReads).toBe(0);
      } finally {
        for (const statement of statements) {
          statement.mockRestore();
        }
        clearSubagentRunsReadCacheForTest();
      }
    },
  );
});

it("reports the persisted pause age of a yielded leaf, never of a parent with a persisted-only announced child", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      const now = Date.UTC(2026, 9, 5, 12, 0, 0);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      const ownerKey = "agent:main:main";
      const pausedAt = now - (43 * 3_600_000 + 12 * 60_000);
      const base = {
        generation: 1,
        requesterSessionKey: ownerKey,
        requesterAgentId: "main",
        completion: { required: false },
        delivery: { status: "not_required" },
      } as const;
      const leaf = createSubagentRunRecord({
        ...base,
        runId: "parked-leaf",
        childSessionKey: "agent:main:subagent:parked-leaf",
        pauseReason: "sessions_yield",
        execution: { status: "terminal", startedAt: pausedAt - 60_000, endedAt: pausedAt },
      });
      const finished = createSubagentRunRecord({
        ...base,
        runId: "finished-run",
        childSessionKey: "agent:main:subagent:finished-run",
        execution: { status: "terminal", startedAt: now - 90_000, endedAt: now - 60_000 },
      });
      const orchestrator = createSubagentRunRecord({
        ...base,
        runId: "waiting-orchestrator",
        childSessionKey: "agent:main:subagent:waiting-orchestrator",
        pauseReason: "sessions_yield",
        execution: { status: "terminal", startedAt: pausedAt - 60_000, endedAt: pausedAt },
      });
      const announcedChild = createSubagentRunRecord({
        ...base,
        runId: "announced-child",
        childSessionKey: "agent:main:subagent:announced-child",
        requesterSessionKey: orchestrator.childSessionKey,
        expectsCompletionMessage: true,
        execution: { status: "running", startedAt: now - 60_000 },
      });
      persistRegistryFixture(
        new Map([
          [leaf.runId, leaf],
          [finished.runId, finished],
          [orchestrator.runId, orchestrator],
          [announcedChild.runId, announcedChild],
        ]),
      );
      // The announced child exists only in persisted rows, never in the in-memory registry.
      clearSubagentRunsReadCacheForTest();
      try {
        const tool = createSubagentsTool({ agentSessionKey: ownerKey, config: {} });
        const wait = await tool.execute("wait", {
          action: "wait",
          runIds: [leaf.runId, finished.runId, orchestrator.runId],
          timeoutSeconds: 0,
        });
        const runs = (wait.details as { runs: Array<{ runId: string; pausedForMs?: number }> })
          .runs;
        const waitedLeaf = runs.find((run) => run.runId === leaf.runId);
        expect(waitedLeaf).toMatchObject({ status: "waiting" });
        expect(waitedLeaf?.pausedForMs).toBe(43 * 3_600_000 + 12 * 60_000);
        expect(runs.find((run) => run.runId === finished.runId)).not.toHaveProperty("pausedForMs");
        expect(runs.find((run) => run.runId === orchestrator.runId)).toMatchObject({
          status: "waiting",
        });
        expect(runs.find((run) => run.runId === orchestrator.runId)).not.toHaveProperty(
          "pausedForMs",
        );

        const list = await tool.execute("list", { action: "list", recentMinutes: 60 });
        const details = list.details as {
          active: Array<{ runId: string; pausedForMs?: number }>;
          recent: Array<{ runId: string; pausedForMs?: number }>;
          text: string;
        };
        const listed = details.active.find((run) => run.runId === leaf.runId);
        expect(listed?.pausedForMs).toBe(43 * 3_600_000 + 12 * 60_000);
        expect(details.text).toContain("waiting for external continuation, paused 1d 19h");
        for (const run of [...details.active, ...details.recent]) {
          if (run.runId === finished.runId || run.runId === orchestrator.runId) {
            expect(run).not.toHaveProperty("pausedForMs");
          }
        }
      } finally {
        vi.useRealTimers();
        clearSubagentRunsReadCacheForTest();
      }
    },
  );
});

it.each([
  "run preparation",
  "run publication",
  "named run publication",
  "deadline",
  "abort",
  "abort with cleanup failure",
  "abort without publication",
  "abort without publication with cleanup failure",
] as const)("joins compact recovery before wait selection after %s", async (trigger) => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      clearSubagentRunsReadCacheForTest();
      const ownerKey = "agent:main:main";
      const run = createSubagentRunRecord({
        runId: "selected-run",
        taskRunId: "selected-logical-run",
        childSessionKey: "agent:main:subagent:selected",
        requesterSessionKey: ownerKey,
        requesterAgentId: "main",
        generation: 1,
        completion: { required: false },
        delivery: { status: "not_required" },
      });
      const previous = {
        ...run,
        runId: "previous-run",
        childSessionKey: "agent:main:subagent:recovering",
      };
      saveSubagentRegistryToSqlite(new Map([run, previous].map((entry) => [entry.runId, entry])));
      await prepareSubagentSessionListReadCache();
      const runPrepared = createDeferred();
      const firstSelection = createDeferred();
      const releaseRunPreparation = createDeferred();
      const prepareRuns = registryState.prepareSubagentRunsSnapshotForRunIds;
      const runRead = vi
        .spyOn(registryState, "prepareSubagentRunsSnapshotForRunIds")
        .mockImplementation(async (...args) => {
          const prepared = await prepareRuns(...args);
          if (prepared) {
            const consume = prepared.consume.bind(prepared);
            prepared.consume = (read) => {
              const result = consume(read);
              if (result.ready) {
                firstSelection.resolve();
              }
              return result;
            };
          }
          runPrepared.resolve();
          if (trigger === "run preparation") {
            await releaseRunPreparation.promise;
          }
          return prepared;
        });
      const recoveryStarted = createDeferred();
      const releaseRecovery = createDeferred();
      const failure = trigger.endsWith("with cleanup failure")
        ? new AggregateError(
            [new Error("query failed"), new Error("cleanup failed")],
            "read cleanup failed",
          )
        : undefined;
      const executeRead = stateReads.executeExistingOpenClawStateRead;
      const read = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockImplementation(async (...args) => {
          const result = await executeRead(...args);
          if (args[1].type === "subagents.sessionList") {
            recoveryStarted.resolve();
            await releaseRecovery.promise;
            if (failure) {
              throw failure;
            }
          }
          return result;
        });
      if (trigger === "deadline") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const abort = new AbortController();
      const waiting = createSubagentsTool({ agentSessionKey: ownerKey, config: {} }).execute(
        "wait",
        {
          action: "wait",
          runIds: [run.runId],
          timeoutSeconds: trigger === "run preparation" ? 0 : trigger === "deadline" ? 1 : 60,
        },
        abort.signal,
      );
      let settled: { result: Awaited<typeof waiting> } | { error: unknown } | undefined;
      const outcome = waiting.then(
        (result) => (settled = { result }),
        (error: unknown) => (settled = { error }),
      );
      let recovery: Promise<unknown> | undefined;
      try {
        await (trigger === "run preparation" ? runPrepared.promise : firstSelection.promise);
        const replacement = { ...previous, runId: "replacement-run", generation: 2 };
        saveSubagentRegistryToSqlite(
          new Map([run, replacement].map((entry) => [entry.runId, entry])),
        );
        recovery = withSubagentRunReadSnapshot(
          new Map(),
          (snapshot) => ({
            runIds: [...snapshot.values()]
              .filter((entry) => entry.childSessionKey === previous.childSessionKey)
              .map((entry) => entry.runId),
            sessionKeys: [],
          }),
          (selection) => selection.runIds,
          { sessionKeys: [previous.childSessionKey], descendants: true },
        ).catch((error: unknown) => error);
        await recoveryStarted.promise;
        if (trigger === "run preparation") {
          releaseRunPreparation.resolve();
        } else if (trigger === "deadline") {
          await vi.advanceTimersByTimeAsync(1_000);
        } else if (!trigger.includes("without publication")) {
          const publisher = new AsyncWorkScope();
          publisher.run(() => {
            const completed = {
              ...run,
              execution: {
                status: "terminal" as const,
                endedAt: Date.now(),
                outcome: { status: "ok" as const },
              },
            };
            persistRegistryFixture(
              new Map([completed, replacement].map((entry) => [entry.runId, entry])),
              trigger === "named run publication" ? [run.runId] : undefined,
            );
          });
          await publisher.drain();
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        if (trigger.startsWith("abort")) {
          abort.abort();
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
        expect(settled).toBeUndefined();
        releaseRecovery.resolve();
        const observed = await outcome;
        if (failure) {
          expect(observed).toEqual({ error: failure });
          expect(await recovery).toBe(failure);
        } else {
          expect(await recovery).toEqual([replacement.runId]);
          if (trigger.startsWith("abort")) {
            expect(observed).toMatchObject({ error: { name: "AbortError" } });
          } else {
            const completed = trigger.endsWith("run publication");
            expect(observed).toMatchObject({
              result: {
                details: {
                  reason: completed ? "completed" : "timeout",
                  runs: [{ runId: run.runId }],
                  completed: completed ? [run.runId] : [],
                },
              },
            });
          }
        }
        expect(
          read.mock.calls.filter(([, command]) => command.type === "subagents.sessionList"),
        ).toHaveLength(1);
      } finally {
        releaseRunPreparation.resolve();
        releaseRecovery.resolve();
        abort.abort();
        await Promise.allSettled([waiting, recovery]);
        runRead.mockRestore();
        read.mockRestore();
        vi.useRealTimers();
        clearSubagentRunsReadCacheForTest();
      }
    },
  );
});
