import { expect, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import "../../agents/subagents/registry/subagent-registry-maintenance.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import {
  createSubagentStoreRunFixture,
  saveSubagentRegistryToSqlite,
} from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { observeSessionMaintenanceCompletion } from "./session-accessor.sqlite-maintenance-completion.test-support.js";
import { sessionTests } from "./session-entry-fixture.test-support.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

const test = sessionTests({
  scenario: "minimal",
  env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" },
});

export function registerSessionMaintenanceProtectionTests() {
  test.for(["worker", "native lifecycle"] as const)(
    "prepares cold durable subagent protection without bulk caller-thread reads (%s)",
    async (owner, { store }) => {
      const { storePath } = store.scope;
      const seed = (sessionId: string, sessionKey: string, updatedAt = 1) => {
        const scope = { storePath, sessionKey };
        replaceSessionEntrySync(scope, { sessionId, updatedAt });
        return scope;
      };
      const active = seed("active", store.sessionKey, Date.now());
      const protectedSession = seed("protected", "agent:main:subagent:protected");
      const stale = seed("stale", "agent:main:subagent:stale");
      subagentRuns.clear();
      const run = createSubagentStoreRunFixture({
        childSessionKey: protectedSession.sessionKey,
        requesterSessionKey: active.sessionKey,
        createdAt: 1,
        execution: { status: "terminal", endedAt: 2 },
        completion: { required: true },
        delivery: { status: "pending" },
      });
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      clearSubagentRunsReadCacheForTest();
      const maintenance = resolveMaintenanceConfigFromInput({ mode: "enforce", pruneAfter: "1s" });
      const sql = observeHostDataSql();
      try {
        if (owner === "worker") {
          const completed = observeSessionMaintenanceCompletion(store.database.path);
          await patchSessionEntryCore(active, () => ({ label: "updated" }), {
            maintenanceConfig: maintenance,
          });
          await completed;
        } else {
          const nativeCommit = vi.fn();
          await applySessionEntryLifecycleMutation({
            storePath,
            activeSessionKey: active.sessionKey,
            maintenanceOverride: maintenance,
            upserts: [
              {
                sessionKey: active.sessionKey,
                buildEntry: ({ currentEntry }) => ({ ...currentEntry!, label: "updated" }),
              },
            ],
            beforeCommitInTransaction: nativeCommit,
          });
          expect(nativeCommit).toHaveBeenCalled();
        }
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
}
