import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
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
