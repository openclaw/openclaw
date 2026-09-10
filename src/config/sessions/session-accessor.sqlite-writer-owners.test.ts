import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as logging from "../../logging/logger.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import {
  applySessionEntryLifecycleMutation,
  applySessionEntryReplacements,
  loadSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import * as maintenance from "./session-accessor.sqlite-maintenance.js";
import { applySessionStoreProjection } from "./session-accessor.sqlite-projection.js";
import { applySessionEntryCanonicalReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

afterEach(() => vi.restoreAllMocks());

function observeSlowWriters(onWarning: (operation: unknown) => void = () => {}) {
  let clock = 0;
  // Cross the existing threshold deterministically; all storage and callback work remains real.
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 1_001));
  const operations: unknown[] = [];
  const getChildLogger = logging.getChildLogger;
  vi.spyOn(logging, "getChildLogger").mockImplementation((...args) => {
    const logger = getChildLogger(...args);
    vi.spyOn(logger, "warn").mockImplementation((message, fields) => {
      if (message === "slow SQLite session write") {
        assert(fields && typeof fields === "object");
        const operation = "operation" in fields ? fields.operation : undefined;
        operations.push(operation);
        onWarning(operation);
      }
      return undefined;
    });
    return logger;
  });
  return operations;
}

it.each(
  ["session.store-projection", "session.entry-replacements", "session.lifecycle.mutate"].flatMap(
    (operation) => [false, true].map((split) => ({ operation, split })),
  ),
)(
  "attributes $operation to its real inline/split commits (split: $split)",
  async ({ operation, split }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const sourceKey = "agent:main:writer-source";
      const targetKey = split ? "agent:main:writer-target" : sourceKey;
      const source = { sessionId: "writer-source", updatedAt: 1, label: "before" };
      replaceSessionEntrySync({ sessionKey: sourceKey, storePath }, source);
      const transcript = [{ type: "session", id: source.sessionId, content: "retained archive" }];
      replaceTranscriptEventsSync(
        { sessionKey: sourceKey, sessionId: source.sessionId, storePath },
        transcript,
      );
      const scope = resolveSqliteScope({ sessionKey: sourceKey, storePath });
      const database = openOpenClawAgentDatabase(toDatabaseOptions(scope));
      const rows = () =>
        database.db
          .prepare("SELECT session_key, label FROM session_nodes ORDER BY session_key")
          .all();
      const before = rows();
      const order: string[] = [];
      const warningRows: ReturnType<typeof rows>[] = [];
      const operations = observeSlowWriters((label) => {
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
            const result = await run({
              commit: () => {
                expect(database.db.isTransaction).toBe(true);
                order.push("native:commit");
              },
              rollback: () => {
                order.push("native:rollback");
              },
            });
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
      try {
        await withPluginRuntimeRegistryScope(registry, async () => {
          if (operation === "session.store-projection") {
            const result = await applySessionStoreProjection({
              storePath,
              skipMaintenance: true,
              update: async (store) => {
                prepared();
                delete store[sourceKey];
                store[targetKey] = updated;
                return { persist: true, result: resultToken };
              },
            });
            expect(result).toBe(resultToken);
          } else if (operation === "session.entry-replacements") {
            const result = split
              ? await applySessionEntryCanonicalReplacements({
                  storePath,
                  sessionKeys: [sourceKey, targetKey],
                  update: async () => {
                    prepared();
                    return {
                      result: resultToken,
                      replacements: [
                        { sessionKey: targetKey, entry: updated, previousSessionKeys: [sourceKey] },
                      ],
                    };
                  },
                })
              : await applySessionEntryReplacements({
                  storePath,
                  sessionKeys: [sourceKey],
                  update: async () => {
                    prepared();
                    return {
                      result: resultToken,
                      replacements: [{ sessionKey: targetKey, entry: updated }],
                    };
                  },
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
              const archives = fs
                .readdirSync(state.sessionsDir())
                .filter((name) => name.includes(".deleted."));
              expect(archives).toHaveLength(1);
              expect(
                readSessionArchiveContentSync(path.join(state.sessionsDir(), archives[0]!)),
              ).toContain("retained archive");
            }
          }
        });
        expect(loadSessionEntry({ sessionKey: targetKey, storePath })).toMatchObject(updated);
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
          expect(loadSessionEntry({ sessionKey: sourceKey, storePath })).toBeUndefined();
        }
      } finally {
        markPluginRegistryRetired(registry);
        vi.restoreAllMocks();
      }
    });
  },
);

it("distinguishes initial, repeated, and final archive pruning from post-deletion free-page draining", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const historyKey = "agent:main:writer-history";
    replaceSessionEntrySync(
      { sessionKey: historyKey, storePath },
      { sessionId: "old", updatedAt: 1 },
    );
    replaceTranscriptEventsSync({ sessionKey: historyKey, sessionId: "old", storePath }, [
      { type: "session", id: "old", content: "historical payload" },
    ]);
    await resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: historyKey, storeKeys: [historyKey] },
      buildNextEntry: () => ({ sessionId: "current", updatedAt: Date.now() }),
    });
    const archivedKey = "agent:main:writer-capped";
    replaceSessionEntrySync(
      { sessionKey: archivedKey, storePath },
      {
        sessionId: "capped",
        updatedAt: 1,
        archivedAt: 1,
        archiveReason: "active-session-cap",
      },
    );
    replaceTranscriptEventsSync({ sessionKey: archivedKey, sessionId: "capped", storePath }, [
      { type: "session", id: "capped", content: "capped payload".repeat(8_192) },
    ]);
    const operations = observeSlowWriters();
    try {
      expect(
        await enforceSqliteSessionHistoryDiskBudget({
          storePath,
          mode: "enforce",
          maintenance: { maxDiskBytes: 1, highWaterBytes: 0 },
        }),
      ).toMatchObject({ removedEntries: 2 });
      expect(
        operations.filter(
          (label) =>
            label === "session.history.archive-prune" || label === "session.history.free-pages",
        ),
      ).toEqual([
        "session.history.archive-prune",
        "session.history.archive-prune",
        "session.history.archive-prune",
        "session.history.free-pages",
      ]);
      expect(loadSessionEntry({ sessionKey: historyKey, storePath })?.sessionId).toBe("current");
      expect(loadSessionEntry({ sessionKey: archivedKey, storePath })).toBeUndefined();
      expect(
        loadTranscriptEventsSync({ sessionKey: historyKey, sessionId: "old", storePath }),
      ).toEqual([]);
      expect(
        fs.readdirSync(state.sessionsDir()).filter((name) => name.includes(".deleted.")),
      ).toEqual([]);
      const database = openOpenClawAgentDatabase(
        toDatabaseOptions(resolveSqliteScope({ sessionKey: historyKey, storePath })),
      );
      expect(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

it("coalesces automatic maintenance under its own planning and finalization labels", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const staleKey = "agent:main:subagent:writer-stale";
    const activeKey = "agent:main:writer-active";
    replaceSessionEntrySync(
      { sessionKey: staleKey, storePath },
      { sessionId: "stale", updatedAt: 1 },
    );
    replaceSessionEntrySync(
      { sessionKey: activeKey, storePath },
      { sessionId: "active", updatedAt: Date.now() },
    );
    const finalize = maintenance.finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort;
    const finalized = createDeferredCore<Awaited<ReturnType<typeof finalize>>>();
    // Row deletion precedes archive publication; join the unchanged finalizer, including both.
    vi.spyOn(
      maintenance,
      "finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort",
    ).mockImplementation((...args) => {
      const result = finalize(...args);
      finalized.resolve(result);
      return result;
    });
    const operations = observeSlowWriters();
    const request = {
      activeSessionKey: activeKey,
      archiveDirectory: state.sessionsDir(),
      scope: resolveSqliteScope({ sessionKey: activeKey, storePath }),
      storePath,
      maintenanceConfig: resolveMaintenanceConfigFromInput({
        mode: "enforce",
        pruneAfter: "1s",
        maxEntries: 100,
      }),
    };
    try {
      kickSessionEntryMaintenanceAfterWrite(request);
      kickSessionEntryMaintenanceAfterWrite(request);
      await finalized.promise;
      await yieldToEventLoop();
      expect(operations).toEqual([
        "session.maintenance.plan",
        "session.maintenance.finalize",
        "session.archive.publish-prepare",
      ]);
      expect(loadSessionEntry({ sessionKey: staleKey, storePath })).toBeUndefined();
      expect(loadSessionEntry({ sessionKey: activeKey, storePath })?.sessionId).toBe("active");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
