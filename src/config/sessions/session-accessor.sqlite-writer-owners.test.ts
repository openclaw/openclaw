import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { createNativeSessionCommitFinalizer } from "../../agents/harness/native-session/deletion-participant.js";
import * as logging from "../../logging/logger.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import {
  applySessionEntryLifecycleMutation,
  applySessionEntryReplacements,
  loadSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import * as maintenance from "./session-accessor.sqlite-maintenance.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";
import * as reclamationDiagnostics from "./session-accessor.sqlite-reclamation-worker-diagnostics.js";
import { applySessionEntryCanonicalReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

afterEach(() => vi.restoreAllMocks());

function storeFixture(state: OpenClawTestState) {
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const scope = (sessionKey: string) => ({ sessionKey, storePath });
  return {
    state,
    storePath,
    read: (key: string) => loadSessionEntry(scope(key)),
    database: (key: string) =>
      openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope(key)))),
    archives: () =>
      fs.readdirSync(state.sessionsDir()).filter((name) => name.includes(".deleted.")),
    seed: (key: string, entry: SessionEntry, content?: string) => {
      replaceSessionEntrySync(scope(key), entry);
      if (content !== undefined) {
        replaceTranscriptEventsSync({ ...scope(key), sessionId: entry.sessionId }, [
          { type: "session", id: entry.sessionId, content },
        ]);
      }
    },
  };
}
const withStore = (run: (fixture: ReturnType<typeof storeFixture>) => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal" }, (state) => run(storeFixture(state)));
const numbers = (...keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, expect.any(Number)]));

function observeSlowWriters(onWarning: (operation: unknown, fields: object) => void = () => {}) {
  let clock = 0;
  // Cross the existing threshold deterministically; all storage and callback work remains real.
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 1_001));
  const operations: unknown[] = [];
  const writers: Record<string, object[]> = {};
  const aggregates: object[] = [];
  const pruning: unknown[] = [];
  const getChildLogger = logging.getChildLogger;
  vi.spyOn(logging, "getChildLogger").mockImplementation((...args) => {
    const logger = getChildLogger(...args);
    vi.spyOn(logger, "warn").mockImplementation((first: unknown, second: unknown) => {
      if (second === "slow SQLite session write") {
        const fields = first;
        assert(fields && typeof fields === "object");
        const operation = "operation" in fields ? fields.operation : undefined;
        operations.push(operation);
        if (typeof operation === "string") {
          (writers[operation] ??= []).push(fields);
        }
        onWarning(operation, fields);
      } else if (first === "slow SQLite session archive pruning") {
        const fields = second;
        assert(fields && typeof fields === "object");
        aggregates.push(fields);
        pruning.push("archivePruning" in fields ? fields.archivePruning : undefined);
      }
      return undefined;
    });
    return logger;
  });
  return { operations, writers, aggregates, pruning };
}

it.each(
  ["session.entry-replacements", "session.lifecycle.mutate"].flatMap((operation) =>
    [false, true].map((split) => ({ operation, split })),
  ),
)(
  "attributes $operation to its real inline/split commits (split: $split)",
  async ({ operation, split }) => {
    await withStore(async ({ state, storePath, seed, read, database: openDatabase, archives }) => {
      const sourceKey = "agent:main:writer-source";
      const targetKey = split ? "agent:main:writer-target" : sourceKey;
      const source = { sessionId: "writer-source", updatedAt: 1, label: "before" };
      seed(sourceKey, source, "retained archive");
      const database = openDatabase(sourceKey);
      const rows = () =>
        database.db
          .prepare("SELECT session_key, label FROM session_nodes ORDER BY session_key")
          .all();
      const before = rows();
      const order: string[] = [];
      const warningRows: ReturnType<typeof rows>[] = [];
      const { operations } = observeSlowWriters((label) => {
        if (label === operation) {
          order.push("warning");
          warningRows.push(rows());
        }
      });
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({
        pluginId: "core",
        source: "runtime",
        harness: {
          id: "writer-owner",
          label: "Synthetic writer owner",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("unused");
          },
          withSessionDeletion: async (params, run) => {
            params.assertCurrent();
            expect(database.db.isTransaction).toBe(false);
            expect(rows()).toEqual(before);
            order.push("native:prepare");
            const result = await run(
              createNativeSessionCommitFinalizer({
                commit: () => {
                  expect(database.db.isTransaction).toBe(false);
                  expect(rows()).toEqual([{ session_key: targetKey, label: "after" }]);
                  order.push("native:commit");
                },
                rollback: () => {
                  order.push("native:rollback");
                },
              }),
            );
            order.push("native:release");
            return result;
          },
        },
      });
      markPluginRegistryActive(registry);
      const updated = {
        ...source,
        ...(split && operation !== "session.entry-replacements"
          ? { sessionId: "writer-target" }
          : {}),
        label: "after",
      };
      const resultToken = {};
      const prepared = () => {
        expect(rows()).toEqual(before);
        order.push("callback");
      };
      const replacements = <T>(entries: T[]) => {
        prepared();
        return { result: resultToken, replacements: entries };
      };
      try {
        await withPluginRuntimeRegistryScope(registry, async () => {
          if (operation === "session.entry-replacements") {
            const result = split
              ? await applySessionEntryCanonicalReplacements({
                  storePath,
                  sessionKeys: [sourceKey, targetKey],
                  update: async () =>
                    replacements([
                      { sessionKey: targetKey, entry: updated, previousSessionKeys: [sourceKey] },
                    ]),
                })
              : await applySessionEntryReplacements({
                  storePath,
                  sessionKeys: [sourceKey],
                  update: async () => replacements([{ sessionKey: targetKey, entry: updated }]),
                });
            expect(result).toBe(resultToken);
          } else {
            const result = await applySessionEntryLifecycleMutation({
              storePath,
              skipMaintenance: true,
              removals: split ? [{ sessionKey: sourceKey, archiveRemovedTranscript: true }] : [],
              upserts: [
                {
                  sessionKey: targetKey,
                  buildEntry: async () => {
                    prepared();
                    return updated;
                  },
                },
              ],
            });
            expect(result).toMatchObject({ afterCount: 1, removedEntries: split ? 1 : 0 });
            if (split) {
              expect(result.archivedTranscriptDirectories).toEqual([state.sessionsDir()]);
              const files = archives();
              expect(files).toHaveLength(1);
              expect(
                readSessionArchiveContentSync(path.join(state.sessionsDir(), files[0]!)),
              ).toContain("retained archive");
            }
          }
        });
        expect(read(targetKey)).toMatchObject(updated);
        expect(operations.filter((label) => label === operation)).toEqual(
          split ? [operation, operation] : [operation],
        );
        expect(warningRows).toEqual(split ? [before, rows()] : [rows()]);
        expect(order).toEqual(
          split
            ? [
                "callback",
                "warning",
                "native:prepare",
                "native:commit",
                "warning",
                "native:release",
              ]
            : ["callback", "warning"],
        );
        if (split) {
          expect(read(sourceKey)).toBeUndefined();
        }
      } finally {
        markPluginRegistryRetired(registry);
        vi.restoreAllMocks();
      }
    });
  },
);

it("records successful archive pruning stages", async () => {
  await withStore(async ({ storePath, seed, read, database: openDatabase, archives }) => {
    const historyKey = "agent:main:writer-history";
    seed(historyKey, { sessionId: "old", updatedAt: 1 }, "historical payload");
    await resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: historyKey, storeKeys: [historyKey] },
      buildNextEntry: () => ({ sessionId: "current", updatedAt: Date.now() }),
    });
    const archivedKey = "agent:main:writer-capped";
    seed(
      archivedKey,
      { sessionId: "capped", updatedAt: 1, archivedAt: 1, archiveReason: "active-session-cap" },
      "capped payload".repeat(8_192),
    );
    const database = openDatabase(historyKey);
    const { writers, aggregates, pruning } = observeSlowWriters();
    try {
      expect(
        await enforceSqliteSessionHistoryDiskBudget({
          storePath,
          mode: "enforce",
          maintenance: { maxDiskBytes: 1, highWaterBytes: 0 },
        }),
      ).toMatchObject({ removedEntries: 2 });
      const writerSegments = writers["session.history.archive-prune"] ?? [];
      const pageWrites = writers["session.history.free-pages"] ?? [];
      expect(writerSegments.length).toBeGreaterThan(0);
      expect(pageWrites.length).toBeGreaterThan(0);
      for (const fields of [...writerSegments, ...pageWrites]) {
        expect(fields).toMatchObject(numbers("queueWaitMs", "writerExecutionMs"));
      }
      for (const fields of aggregates) {
        expect(fields).toMatchObject({ elapsedMs: expect.any(Number) });
        expect(fields).not.toHaveProperty("queueWaitMs");
        expect(fields).not.toHaveProperty("writerExecutionMs");
        expect(fields).not.toHaveProperty("completionDelayMs");
      }
      expect(pruning).toEqual([
        expect.objectContaining({ trigger: "initial", completed: true }),
        expect.objectContaining({ trigger: "after-eviction", completed: true }),
        expect.objectContaining({ trigger: "final", completed: true }),
      ]);
      expect(pruning[0]).toMatchObject({ checkpointIncomplete: 0 });
      for (const diagnostic of pruning) {
        expect(diagnostic).toMatchObject(
          numbers(
            "checkpointCalls",
            "checkpointMs",
            "checkpointMaxMs",
            "queryMs",
            "measurementMs",
            "measurements",
            "legacyInventoryMs",
          ),
        );
      }
      expect(pruning[1]).toMatchObject({
        fileRemovalMs: expect.any(Number),
        removedFiles: 1,
        rowDeletionMs: expect.any(Number),
      });
      expect(read(historyKey)?.sessionId).toBe("current");
      expect(read(archivedKey)).toBeUndefined();
      expect(
        loadTranscriptEventsSync({ sessionKey: historyKey, sessionId: "old", storePath }),
      ).toEqual([]);
      expect(archives()).toEqual([]);
      expect(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

it("coalesces automatic maintenance through native planning and finalization", async () => {
  await withStore(async ({ state, storePath, seed, read }) => {
    const staleKey = "agent:main:subagent:writer-stale";
    const activeKey = "agent:main:writer-active";
    seed(staleKey, { sessionId: "stale", updatedAt: 1 });
    seed(activeKey, { sessionId: "active", updatedAt: Date.now() });
    const finalize = maintenance.finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort;
    const finalized = createDeferredCore<Awaited<ReturnType<typeof finalize>>>();
    // Row deletion precedes archive publication; join the unchanged finalizer, including both.
    const finalizer = vi
      .spyOn(maintenance, "finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort")
      .mockImplementation((...args) => {
        const result = finalize(...args);
        finalized.resolve(result);
        return result;
      });
    const maintenanceSettled = createDeferredCore();
    const reclaim = reclamationRun.runSqliteSessionReclamation;
    vi.spyOn(reclamationRun, "runSqliteSessionReclamation").mockImplementation(async (params) => {
      const result = await reclaim(params);
      if (
        result.kind === "maintenance-age" ||
        (result.kind === "maintenance-plan" &&
          result.value.archived === 0 &&
          result.value.entryRemovals.length === 0 &&
          result.value.stateDeletePlans.length === 0)
      ) {
        // Empty plans carry their verified deadline without another age request.
        maintenanceSettled.resolve();
      }
      return result;
    });
    const workerOutcomes: Parameters<
      typeof reclamationDiagnostics.logSqliteReclamationWorkerOutcome
    >[0][] = [];
    const logWorkerOutcome = reclamationDiagnostics.logSqliteReclamationWorkerOutcome;
    vi.spyOn(reclamationDiagnostics, "logSqliteReclamationWorkerOutcome").mockImplementation(
      (outcome) => {
        workerOutcomes.push(outcome);
        logWorkerOutcome(outcome);
      },
    );
    const { operations } = observeSlowWriters();
    const request = {
      activeSessionKey: activeKey,
      archiveDirectory: state.sessionsDir(),
      scope: resolveSqliteScope({ sessionKey: activeKey, storePath }),
      storePath,
      maintenanceConfig: resolveMaintenanceConfigFromInput({
        mode: "enforce",
        // Native worker preparation must not age the active fixture into a second archive pass.
        pruneAfter: "30d",
        maxEntries: 100,
      }),
    };
    try {
      kickSessionEntryMaintenanceAfterWrite(request);
      kickSessionEntryMaintenanceAfterWrite(request);
      await finalized.promise;
      await maintenanceSettled.promise;
      expect(
        operations.filter((operation) => operation === "session.reclamation.worker-commit"),
      ).toEqual(["session.reclamation.worker-commit"]);
      expect(finalizer).toHaveBeenCalledOnce();
      expect(workerOutcomes.map(({ kind }) => kind)).toEqual(["maintenance-finalize"]);
      for (const outcome of workerOutcomes) {
        expect(outcome.outcome).toBe("resolved");
        expect(outcome.workerThreadId).toBeGreaterThan(0);
      }
      expect(read(staleKey)).toBeUndefined();
      expect(read(activeKey)?.sessionId).toBe("active");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
