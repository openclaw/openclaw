import path from "node:path";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import "../../agents/subagents/registry/subagent-registry-maintenance.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { saveSubagentRegistryToSqlite } from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import { bindSubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.store.codec.js";
import { subagentRunRowVersion } from "../../agents/subagents/registry/subagent-registry.store.row.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { observeSessionMaintenanceCompletion } from "./session-accessor.sqlite-maintenance-completion.test-support.js";
import * as preservation from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

export function registerSessionMaintenanceProtectionTests() {
  it.each(["worker", "native lifecycle"] as const)(
    "prepares cold durable subagent protection without bulk caller-thread reads (%s)",
    async (owner) => {
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
          const maintenance = resolveMaintenanceConfigFromInput({
            mode: "enforce",
            maxEntries: 100,
            pruneAfter: "1s",
          });
          const sql = observeHostDataSql();
          try {
            if (owner === "worker") {
              const completed = observeSessionMaintenanceCompletion(
                resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
              );
              await patchSessionEntryCore(active, () => ({ label: "updated" }), {
                maintenanceConfig: maintenance,
              });
              await completed;
            } else {
              let nativeCommit = false;
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
                beforeCommitInTransaction: () => {
                  nativeCommit = true;
                },
              });
              expect(nativeCommit).toBe(true);
            }
            const registryQueries = sql.queries.filter((query) => query.includes("subagent_runs"));
            if (owner === "worker") {
              expect(registryQueries).toEqual([]);
            } else {
              // Any foreign state commit requires native pruning to recheck its candidates.
              for (const query of registryQueries) {
                expect(query).toContain('"child_session_key" in');
              }
            }
            expect(loadSessionEntry(protectedSession)?.sessionId).toBe("protected");
            expect(loadSessionEntry(stale)).toBeUndefined();
          } finally {
            sql.restore();
            subagentRuns.clear();
            clearSubagentRunsReadCacheForTest();
          }
        },
      );
    },
  );

  it.each(["insert", "update", "unrelated"] as const)(
    "rechecks only native maintenance candidates after a foreign worker commit (%s)",
    async (mutation) => {
      await withOpenClawTestState(
        { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
        async (state) => {
          const storePath = path.join(state.sessionsDir(), "sessions.json");
          const active = { storePath, sessionKey: "agent:main:foreign-maintenance-active" };
          const child = { storePath, sessionKey: "agent:main:subagent:foreign-maintenance-child" };
          replaceSessionEntrySync(active, {
            sessionId: "active",
            updatedAt: Date.now(),
            label: "before",
          });
          replaceSessionEntrySync(child, { sessionId: "protected", updatedAt: 1 });
          subagentRuns.clear();
          const run: SubagentRunRecord = {
            runId: "foreign-maintenance-run",
            childSessionKey:
              mutation === "unrelated"
                ? "agent:main:subagent:foreign-maintenance-unrelated"
                : child.sessionKey,
            requesterSessionKey: active.sessionKey,
            requesterDisplayKey: "main",
            createdAt: 1,
            task: "synthetic foreign protected run",
            cleanup: "keep",
            expectsCompletionMessage: true,
            execution: { status: "running" },
            completion: { required: true },
            delivery: { status: "pending" },
          };
          const completed: SubagentRunRecord = {
            ...run,
            execution: { status: "terminal", endedAt: 2 },
            cleanupCompletedAt: 3,
            delivery: { status: "delivered" },
          };
          saveSubagentRegistryToSqlite(
            new Map(mutation === "update" ? [[completed.runId, completed]] : []),
          );
          const version =
            mutation === "update" ? subagentRunRowVersion(bindSubagentRunRecord(completed)) : null;
          clearSubagentRunsReadCacheForTest();
          const prepare = preservation.prepareSessionMaintenancePreservation;
          const prepareSpy = vi
            .spyOn(preservation, "prepareSessionMaintenancePreservation")
            .mockImplementationOnce(async (requestedStorePath, options) => {
              const prepared = await prepare(requestedStorePath, options);
              try {
                const runId = run.runId;
                const writeId = "foreign-maintenance-registration";
                const context = captureOpenClawStateWorkerContext();
                const admitted: string[] = [];
                const receipt = await runOpenClawStateWorkerOperation(
                  context,
                  (worker) =>
                    worker.execute({
                      type: "subagents.persistChanges",
                      input: {
                        writeId,
                        values: [bindSubagentRunRecord(run)],
                        deleteRunIds: [],
                        versions: [{ runId, version }],
                      },
                    }),
                  {
                    createAdmission: () => ({
                      nativeLocations: [
                        context.admission.databasePath,
                        context.admission.identity.canonicalPath,
                      ],
                      admission: createSqliteWorkerOperationAdmission((request, grant) => {
                        context.admission.assertCurrent();
                        expect(request.facts).toBe(writeId);
                        expect(request.stage).toBe(
                          admitted.length === 0 ? "transaction" : "commit",
                        );
                        expect(grant()).toBe(true);
                        admitted.push(request.stage);
                      }),
                    }),
                  },
                );
                expect(admitted).toEqual(["transaction", "commit"]);
                expect(receipt).toHaveProperty("versions");
                expect(subagentRuns.size).toBe(0);
                return prepared;
              } catch (error) {
                prepared.dispose();
                throw error;
              }
            });
          const sql = observeHostDataSql();
          try {
            const mutationResult = applySessionEntryLifecycleMutation({
              storePath,
              activeSessionKey: active.sessionKey,
              maintenanceOverride: resolveMaintenanceConfigFromInput({
                mode: "enforce",
                maxEntries: 100,
                pruneAfter: "1s",
              }),
              upserts: [
                {
                  sessionKey: active.sessionKey,
                  buildEntry: ({ currentEntry }) => ({ ...currentEntry!, label: "updated" }),
                },
              ],
              beforeCommitInTransaction: () => {},
            });
            if (mutation === "unrelated") {
              await expect(mutationResult).resolves.toMatchObject({ pruned: 1 });
              expect(loadSessionEntry(child)).toBeUndefined();
            } else {
              await expect(mutationResult).rejects.toThrow(
                "SQLite maintenance candidates became protected before commit",
              );
              expect(loadSessionEntry(child)?.sessionId).toBe("protected");
            }
            expect(prepareSpy).toHaveBeenCalled();
            expect(loadSessionEntry(active)).toMatchObject({
              sessionId: "active",
              label: mutation === "unrelated" ? "updated" : "before",
            });
            const registryQueries = sql.queries.filter((query) => query.includes("subagent_runs"));
            expect(registryQueries.length).toBeGreaterThan(0);
            for (const query of registryQueries) {
              expect(query).toContain('"child_session_key" in');
            }
          } finally {
            prepareSpy.mockRestore();
            sql.restore();
            subagentRuns.clear();
            clearSubagentRunsReadCacheForTest();
          }
        },
      );
    },
  );
}
