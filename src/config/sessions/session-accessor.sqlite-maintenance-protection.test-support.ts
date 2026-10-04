import path from "node:path";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import "../../agents/subagents/registry/subagent-registry-maintenance.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { saveSubagentRegistryToSqlite } from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntry, replaceSessionEntrySync } from "./session-accessor.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { observeSessionMaintenanceCompletion } from "./session-accessor.sqlite-maintenance.test-support.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

export function registerSessionMaintenanceProtectionTests() {
  it("prepares cold durable subagent protection without querying the calling thread", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async (state) => {
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        const active = { storePath, sessionKey: "agent:main:prepared-maintenance-active" };
        const protectedSession = {
          storePath,
          sessionKey: "agent:main:subagent:prepared-protected",
        };
        const stale = { storePath, sessionKey: "agent:main:subagent:prepared-stale" };
        replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
        replaceSessionEntrySync(protectedSession, { sessionId: "protected", updatedAt: 1 });
        replaceSessionEntrySync(stale, { sessionId: "stale", updatedAt: 1 });
        subagentRuns.clear();
        saveSubagentRegistryToSqlite(
          new Map([
            [
              "protected-run",
              {
                runId: "protected-run",
                childSessionKey: protectedSession.sessionKey,
                requesterSessionKey: active.sessionKey,
                requesterDisplayKey: "main",
                createdAt: 1,
                task: "synthetic retained task",
                cleanup: "keep",
                expectsCompletionMessage: true,
                execution: { status: "terminal", endedAt: 2 },
                completion: { required: true },
                delivery: { status: "pending" },
              },
            ],
          ]),
        );
        clearSubagentRunsReadCacheForTest();
        const completed = observeSessionMaintenanceCompletion(
          resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
        );
        const sql = observeHostDataSql();
        try {
          await patchSessionEntryCore(active, () => ({ label: "updated" }), {
            maintenanceConfig: resolveMaintenanceConfigFromInput({
              mode: "enforce",
              maxEntries: 100,
              pruneAfter: "1s",
            }),
          });
          await completed;
          expect(sql.queries.filter((query) => query.includes("subagent_runs"))).toEqual([]);
          expect(loadSessionEntry(protectedSession)?.sessionId).toBe("protected");
          expect(loadSessionEntry(stale)).toBeUndefined();
        } finally {
          sql.restore();
          subagentRuns.clear();
          clearSubagentRunsReadCacheForTest();
        }
      },
    );
  });
}
