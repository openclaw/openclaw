import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { persistRegistryFixture } from "../subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../subagents/registry/subagent-registry-state.js";
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

it("bounds current control scope work to the caller tree in a 5,000-run registry", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const ownerKey = "agent:main:main";
    const selected = createSubagentRunRecord({
      runId: "selected",
      childSessionKey: "agent:main:subagent:selected",
      requesterSessionKey: ownerKey,
      requesterAgentId: "main",
    });
    for (let index = 0; index < 5_000; index++) {
      const runId = `unrelated-${index}`;
      subagentRuns.set(
        runId,
        createSubagentRunRecord({
          runId,
          childSessionKey: `agent:main:subagent:${runId}`,
          requesterSessionKey: "agent:main:unrelated",
        }),
      );
    }
    subagentRuns.set(selected.runId, selected);
    const tool = createSubagentsTool({ agentSessionKey: ownerKey, config: {} });
    const read = () =>
      tool.execute("scope", {
        action: "wait",
        runIds: [selected.runId],
        timeoutSeconds: 0,
      });
    try {
      await read();
      // A warm owner index must not enumerate unrelated retained rows on a tool read.
      let visited = 0;
      const iterate = subagentRuns[Symbol.iterator].bind(subagentRuns);
      const scan = vi.spyOn(subagentRuns, Symbol.iterator).mockImplementation(function* () {
        for (const row of iterate()) {
          visited++;
          yield row;
        }
        return undefined;
      });
      try {
        expect((await read()).details).toMatchObject({
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
        expect((await read()).details).toMatchObject({
          reason: "unavailable",
          unavailable: [selected.runId],
          runs: [],
        });
        subagentRuns.delete(replacement.runId);
        expect((await read()).details).toMatchObject({ runs: [{ runId: selected.runId }] });
        subagentRuns.set(selected.runId, {
          ...selected,
          requesterSessionKey: "agent:main:other",
        });
        expect((await read()).details).toMatchObject({
          reason: "unavailable",
          unavailable: [selected.runId],
          runs: [],
        });
        expect(visited).toBeLessThan(10);
      } finally {
        scan.mockRestore();
      }
    } finally {
      subagentRuns.clear();
      clearSubagentRunsReadCacheForTest();
    }
  });
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
          runIds: [leaf.runId, orchestrator.runId],
          timeoutSeconds: 0,
        });
        const runs = (wait.details as { runs: Array<{ runId: string; pausedForMs?: number }> })
          .runs;
        const waitedLeaf = runs.find((run) => run.runId === leaf.runId);
        expect(waitedLeaf).toMatchObject({ status: "waiting" });
        expect(waitedLeaf?.pausedForMs).toBe(43 * 3_600_000 + 12 * 60_000);
        expect(runs.find((run) => run.runId === orchestrator.runId)).toMatchObject({
          status: "waiting",
        });
        expect(runs.find((run) => run.runId === orchestrator.runId)).not.toHaveProperty(
          "pausedForMs",
        );

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
      } finally {
        vi.useRealTimers();
        clearSubagentRunsReadCacheForTest();
      }
    },
  );
});
