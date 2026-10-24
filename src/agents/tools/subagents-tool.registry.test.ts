import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { persistRegistryFixture } from "../subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../subagents/registry/subagent-registry-state.js";
import { createSubagentsTool } from "./subagents-tool.js";

const ownerKey = "agent:main:main";
const createRun = (overrides: Parameters<typeof createSubagentRunRecord>[0]) =>
  createSubagentRunRecord({
    childSessionKey: `agent:main:subagent:${overrides.runId}`,
    requesterSessionKey: ownerKey,
    requesterAgentId: "main",
    ...overrides,
  });
const createTool = () => createSubagentsTool({ agentSessionKey: ownerKey, config: {} });
const waitForRuns = async (runIds: string[], tool = createTool()) =>
  (await tool.execute("wait", { action: "wait", runIds, timeoutSeconds: 0 })).details;
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

it("keeps persisted subagent wait selection off the calling thread", async () => {
  await withRegistry(async () => {
    const run = createRun({
      runId: "physical-run",
      taskRunId: "logical-run",
      generation: 1,
      childSessionKey: "agent:main:subagent:persisted-wait",
      completion: { required: false },
      delivery: { status: "not_required" },
    });
    persistRegistryFixture(new Map([[run.runId, run]]));
    clearSubagentRunsReadCacheForTest();
    let registryReads = 0;
    for (const method of ["get", "all", "iterate"] as const) {
      const execute = StatementSync.prototype[method];
      vi.spyOn(StatementSync.prototype, method).mockImplementation(function (
        this: StatementSync,
        ...args: unknown[]
      ) {
        if (/\bfrom\s+"?subagent_runs\b/i.test(this.sourceSQL)) {
          registryReads++;
        }
        return Reflect.apply(execute, this, args);
      });
    }
    expect(await waitForRuns([run.runId])).toMatchObject({
      reason: "timeout",
      runs: [{ runId: run.runId }],
    });
    expect(registryReads).toBe(0);
  }, true);
});

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
    expect(await read()).toMatchObject({
      reason: "timeout",
      runs: [{ runId: selected.runId }],
    });
    expect(visited).toBeLessThan(10);
    const replacement = {
      ...selected,
      runId: "replacement",
      generation: 2,
      requesterSessionKey: "agent:main:other",
    };
    subagentRuns.set(replacement.runId, replacement);
    expect(await read()).toMatchObject({
      reason: "unavailable",
      unavailable: [selected.runId],
      runs: [],
    });
    subagentRuns.delete(replacement.runId);
    expect(await read()).toMatchObject({ runs: [{ runId: selected.runId }] });
    subagentRuns.set(selected.runId, {
      ...selected,
      requesterSessionKey: "agent:main:other",
    });
    expect(await read()).toMatchObject({
      reason: "unavailable",
      unavailable: [selected.runId],
      runs: [],
    });
    expect(visited).toBeLessThan(10);
  });
});

it("reports the persisted pause age of a yielded leaf, never of a parent with a persisted-only announced child", async () => {
  await withRegistry(async () => {
    const now = Date.UTC(2026, 9, 5, 12, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const pausedAt = now - (43 * 3_600_000 + 12 * 60_000);
    const base = {
      generation: 1,
      completion: { required: false },
      delivery: { status: "not_required" },
    } as const;
    const leaf = createRun({
      ...base,
      runId: "parked-leaf",
      pauseReason: "sessions_yield",
      execution: { status: "terminal", startedAt: pausedAt - 60_000, endedAt: pausedAt },
    });
    const orchestrator = createRun({
      ...base,
      runId: "waiting-orchestrator",
      pauseReason: "sessions_yield",
      execution: { status: "terminal", startedAt: pausedAt - 60_000, endedAt: pausedAt },
    });
    const announcedChild = createRun({
      ...base,
      runId: "announced-child",
      requesterSessionKey: orchestrator.childSessionKey,
      expectsCompletionMessage: true,
      execution: { status: "running", startedAt: now - 60_000 },
    });
    persistRegistryFixture(
      new Map([
        [leaf.runId, leaf],
        [orchestrator.runId, orchestrator],
        [announcedChild.runId, announcedChild],
      ]),
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
