import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { persistRegistryFixture } from "../subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../subagents/registry/subagent-registry-state.js";
import { archiveSubagentRunValuesInDatabase } from "../subagents/registry/subagent-registry.store.kernel.js";
import { createSubagentsTool } from "./subagents-tool.js";

const ownerKey = "agent:main:main";
const createRun = (overrides: Parameters<typeof createSubagentRunRecord>[0]) =>
  createSubagentRunRecord({
    childSessionKey: `agent:main:subagent:${overrides.runId}`,
    requesterSessionKey: ownerKey,
    requesterAgentId: "main",
    ...overrides,
  });
const persistedRun = (overrides: Parameters<typeof createRun>[0]) =>
  createRun({
    generation: 1,
    completion: { required: false },
    delivery: { status: "not_required" },
    ...overrides,
  });
const createTool = () => createSubagentsTool({ agentSessionKey: ownerKey, config: {} });
const waitForRuns = async (runIds: string[], tool = createTool()) =>
  (await tool.execute("wait", { action: "wait", runIds, timeoutSeconds: 0 })).details;
const selectedRun = (runId: string) => ({ runs: [{ runId }] });
const unavailableRun = (runId: string) => ({
  reason: "unavailable",
  unavailable: [runId],
  runs: [],
});
const withRegistry = (run: () => Promise<void>, persisted = false) =>
  withOpenClawTestState(
    {
      scenario: "minimal",
      ...(persisted ? { env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } } : {}),
    },
    async () => {
      try {
        await run();
      } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
        subagentRuns.clear();
        clearSubagentRunsReadCacheForTest();
      }
    },
  );

it.each([false, true])(
  "keeps persisted subagent wait selection off the calling thread (archived=%s)",
  async (archived) => {
    await withRegistry(async () => {
      const run = persistedRun({
        runId: "physical-run",
        taskRunId: "logical-run",
        childSessionKey: "agent:main:subagent:persisted-wait",
        ...(archived
          ? {
              createdAt: 1,
              execution: { status: "terminal" as const, endedAt: 2 },
              cleanupCompletedAt: 3,
            }
          : {}),
      });
      const child = persistedRun({
        runId: "live-descendant",
        requesterSessionKey: run.childSessionKey,
      });
      const records = archived ? [run, child] : [run];
      persistRegistryFixture(new Map(records.map((entry) => [entry.runId, entry])));
      if (archived) {
        expect(
          runOpenClawStateWriteTransaction((database) =>
            archiveSubagentRunValuesInDatabase(database, [run.runId], Date.now()),
          ),
        ).toEqual([run.runId]);
        subagentRuns.set(child.runId, child);
      }
      clearSubagentRunsReadCacheForTest();
      const sql = observeSqliteReadSql(StatementSync.prototype);
      expect(await waitForRuns([run.runId])).toMatchObject({
        reason: archived ? "completed" : "timeout",
        ...selectedRun(run.runId),
      });
      if (archived) {
        expect(await waitForRuns([child.runId])).toMatchObject({
          reason: "timeout",
          ...selectedRun(child.runId),
        });
        expect(subagentRuns.has(run.runId)).toBe(false);
      }
      expect(sql.queries.filter((query) => /\bfrom\s+"?subagent_runs\b/i.test(query))).toEqual([]);
    }, true);
  },
);

it("bounds current control scope work to the caller tree in a 5,000-run registry", async () => {
  await withRegistry(async () => {
    const selected = createRun({ runId: "selected" });
    for (let index = 0; index < 5_000; index++) {
      const runId = `unrelated-${index}`;
      subagentRuns.set(
        runId,
        createRun({
          runId,
          requesterSessionKey: "agent:main:unrelated",
          requesterAgentId: undefined,
        }),
      );
    }
    subagentRuns.set(selected.runId, selected);
    const tool = createTool();
    const read = () => waitForRuns([selected.runId], tool);
    await read();
    // A warm owner index must not enumerate unrelated retained rows on a tool read.
    let visited = 0;
    const iterate = subagentRuns[Symbol.iterator].bind(subagentRuns);
    vi.spyOn(subagentRuns, Symbol.iterator).mockImplementation(function* () {
      for (const row of iterate()) {
        visited++;
        yield row;
      }
      return undefined;
    });
    expect(await read()).toMatchObject({ reason: "timeout", ...selectedRun(selected.runId) });
    expect(visited).toBeLessThan(10);
    const replacement = {
      ...selected,
      runId: "replacement",
      generation: 2,
      requesterSessionKey: "agent:main:other",
    };
    subagentRuns.set(replacement.runId, replacement);
    expect(await read()).toMatchObject(unavailableRun(selected.runId));
    subagentRuns.delete(replacement.runId);
    expect(await read()).toMatchObject(selectedRun(selected.runId));
    subagentRuns.set(selected.runId, {
      ...selected,
      requesterSessionKey: "agent:main:other",
    });
    expect(await read()).toMatchObject(unavailableRun(selected.runId));
    expect(visited).toBeLessThan(10);
  });
});

it("reports the persisted pause age of a yielded leaf, never of a parent with a persisted-only announced child", async () => {
  await withRegistry(async () => {
    const now = Date.UTC(2026, 9, 5, 12, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const pausedAt = now - (43 * 3_600_000 + 12 * 60_000);
    const pausedRun = (runId: string) =>
      persistedRun({
        runId,
        pauseReason: "sessions_yield",
        execution: { status: "terminal", startedAt: pausedAt - 60_000, endedAt: pausedAt },
      });
    const leaf = pausedRun("parked-leaf");
    const orchestrator = pausedRun("waiting-orchestrator");
    const announcedChild = persistedRun({
      runId: "announced-child",
      requesterSessionKey: orchestrator.childSessionKey,
      expectsCompletionMessage: true,
      execution: { status: "running", startedAt: now - 60_000 },
    });
    persistRegistryFixture(
      new Map([leaf, orchestrator, announcedChild].map((run) => [run.runId, run])),
    );
    // The announced child exists only in persisted rows, never in the in-memory registry.
    clearSubagentRunsReadCacheForTest();
    const tool = createTool();
    const runs = (
      (await waitForRuns([leaf.runId, orchestrator.runId])) as {
        runs: Array<{ runId: string; pausedForMs?: number }>;
      }
    ).runs;
    const parent = runs.find((run) => run.runId === orchestrator.runId);
    expect(runs.find((run) => run.runId === leaf.runId)).toMatchObject({
      status: "waiting",
      pausedForMs: 43 * 3_600_000 + 12 * 60_000,
    });
    expect(parent).toMatchObject({ status: "waiting" });
    expect(parent).not.toHaveProperty("pausedForMs");

    const list = await tool.execute("list", { action: "list", recentMinutes: 60 });
    const details = list.details as {
      active: Array<{ runId: string; pausedForMs?: number }>;
      text: string;
    };
    const listed = details.active.find((run) => run.runId === leaf.runId);
    expect(listed?.pausedForMs).toBe(43 * 3_600_000 + 12 * 60_000);
    expect(details.text).toContain("waiting for external continuation, paused 1d 19h");
    expect(details.active.find((run) => run.runId === orchestrator.runId)).not.toHaveProperty(
      "pausedForMs",
    );
  }, true);
});
