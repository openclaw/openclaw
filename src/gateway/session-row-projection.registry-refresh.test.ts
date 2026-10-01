import { afterEach, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentSessionListReadSnapshotIdentity,
  prepareSubagentSessionListReadCache,
} from "../agents/subagents/registry/subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry.store.test-support.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "keeps current row facts when the subagent snapshot changes during a list (prepared=%s)",
  async (prepared) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        const cfg = { agents: { entries: { main: {} } } };
        const scope = { agentId: "main", sessionKey: "agent:main:dashboard:registry-refresh" };
        const entry = { sessionId: "registry-refresh", updatedAt: 1, label: "Previous" };
        replaceSessionEntrySync(scope, entry);
        const release = retainSessionListForegroundWork();
        const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
        try {
          await projection.ensureMaterialized();
          const reads: string[][] = [];
          const readDatabases = history.withSessionHistoryWorkerDatabases;
          vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
            (databases, consume, lane) =>
              readDatabases(
                databases,
                (owners) =>
                  consume(
                    owners.map((owner) => ({
                      ...owner,
                      async readRowFacts(input) {
                        const reply = await owner.readRowFacts(input);
                        reads.push([...input.sessionKeys]);
                        if (reads.length === 1) {
                          const previous = getSubagentSessionListReadSnapshotIdentity();
                          const run = createSubagentRunRecord({
                            runId: "unrelated-refresh-run",
                            childSessionKey: "agent:main:unrelated-child",
                            requesterSessionKey: "agent:main:unrelated-parent",
                            generation: 1,
                            completion: { required: false },
                            delivery: { status: "not_required" },
                          });
                          saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
                          clearSubagentRunsReadCacheForTest();
                          if (prepared) {
                            await prepareSubagentSessionListReadCache();
                          }
                          expect(getSubagentSessionListReadSnapshotIdentity()).not.toBe(previous);
                        }
                        return reply;
                      },
                    })),
                  ),
                lane,
              ),
          );
          replaceSessionEntrySync(scope, { ...entry, updatedAt: 2, label: "Current" });
          const result = await listProjectedSessions({ projection, opts: { limit: 1 } });
          expect(result.sessions).toEqual([
            expect.objectContaining({ key: scope.sessionKey, label: "Current" }),
          ]);
          expect(reads).toEqual([[scope.sessionKey]]);
        } finally {
          projection.dispose();
          release();
        }
      },
    );
  },
);
