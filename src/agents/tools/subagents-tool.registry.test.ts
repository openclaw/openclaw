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
