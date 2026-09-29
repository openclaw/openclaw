import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import {
  clearSubagentRunsReadCacheForTest,
  persistSubagentRunsToDiskOrThrow,
  prepareSubagentSessionListReadCache,
  withSubagentRunReadSnapshot,
} from "../subagents/registry/subagent-registry-state.js";
import * as registryState from "../subagents/registry/subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "../subagents/registry/subagent-registry.store.sqlite.js";
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
      persistSubagentRunsToDiskOrThrow(new Map([[run.runId, run]]));
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
        ).catch((error: unknown) => error);
        await recoveryStarted.promise;
        if (trigger === "run preparation") {
          releaseRunPreparation.resolve();
        } else if (trigger === "deadline") {
          await vi.advanceTimersByTimeAsync(1_000);
        } else if (!trigger.includes("without publication")) {
          const publisher = new AsyncWorkScope();
          publisher.run(() => {
            run.execution = { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } };
            persistSubagentRunsToDiskOrThrow(
              new Map([run, replacement].map((entry) => [entry.runId, entry])),
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
