import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadSqliteTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";
import { createTrajectoryRuntimeRecorder } from "./runtime.js";

// Real native writes and admission run unchanged; only delivery of their evidence changes.
const delivery = vi.hoisted(() => ({
  afterResult: undefined as (() => void) | undefined,
  settlement: undefined as Promise<SqliteWorkerOperationSettlement> | undefined,
  hideCommit: false,
}));
vi.mock("../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owned = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owned,
        runExisting: (source, operation, options) =>
          owned.runExisting(
            {
              ...source,
              createAdmission(binding) {
                const create = source.createAdmission(binding);
                return (retained) => {
                  const settlement = delivery.settlement;
                  const result = create(
                    settlement ? { settled: retained.settled.then(() => settlement) } : retained,
                  );
                  if (delivery.hideCommit) {
                    vi.spyOn(result.admission, "committed", "get").mockReturnValue(undefined);
                  }
                  return result;
                };
              },
            },
            (scope) =>
              operation({
                execute: async (command, commandOptions) => {
                  const result = await scope.execute(command, commandOptions);
                  if (command.type === "trajectory.events.append") {
                    const after = delivery.afterResult;
                    delivery.afterResult = undefined;
                    delivery.settlement = undefined;
                    delivery.hideCommit = false;
                    after?.();
                  }
                  return result;
                },
              }),
            options,
          ),
      };
    },
  };
});

afterEach(() => {
  delivery.afterResult = undefined;
  delivery.settlement = undefined;
  delivery.hideCommit = false;
  vi.restoreAllMocks();
});

it.each(["committed", "unknown"] as const)(
  "settles the captured trajectory prefix before another flush after a lost result (%s)",
  async (outcome) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "trajectory-settlement",
        sessionKey: "agent:main:trajectory-settlement",
        storePath: state.statePath("agents", "main", "agent.sqlite"),
      };
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      const recorder = createTrajectoryRuntimeRecorder({
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
      });
      assert(recorder);
      const committed = createDeferredCore();
      const settlement = createDeferredCore<SqliteWorkerOperationSettlement>();
      const failure = new Error("trajectory result was lost after native completion");
      delivery.settlement = settlement.promise;
      delivery.hideCommit = outcome === "unknown";
      delivery.afterResult = () => {
        committed.resolve();
        throw failure;
      };
      recorder.recordEvent("first");
      const observe = (result: Promise<void>) =>
        result.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      const first = observe(recorder.flush());
      let next: ReturnType<typeof observe> | undefined;
      try {
        await Promise.race([
          committed.promise,
          first.then(() => {
            throw new Error("Flush ended before the real native append completed");
          }),
        ]);
        expect(recorder.describeFlushState()).toContain("pendingRows=1");
        recorder.recordEvent("later");
        next = observe(recorder.flush());
        settlement.resolve(
          outcome === "committed" ? { kind: "completed" } : { kind: "unknown", error: failure },
        );
        expect(await first).toEqual({ ok: false, error: failure });
        if (outcome === "committed") {
          expect(await next).toEqual({ ok: true });
          expect(recorder.describeFlushState()).toBeUndefined();
          expect(
            (await loadSqliteTrajectoryRuntimeEvents(target)).map((event) => event.type),
          ).toEqual(["first", "later"]);
        } else {
          expect(await next).toMatchObject({ ok: false, error: { code: "outcome-unknown" } });
          await expect(recorder.flush()).rejects.toMatchObject({ code: "outcome-unknown" });
          expect(recorder.describeFlushState()).toContain("pendingRows=2");
          expect(
            (await loadSqliteTrajectoryRuntimeEvents(target)).map((event) => event.type),
          ).toEqual(["first"]);
        }
      } finally {
        settlement.resolve({ kind: "completed" });
        await first;
        await next;
      }
    });
  },
);
