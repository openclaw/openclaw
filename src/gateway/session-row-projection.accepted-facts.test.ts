import { renameSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { StatementSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import * as acpReads from "../acp/runtime/session-meta-readonly.js";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentSessionListReadSnapshotIdentity,
  withSubagentRunReadSnapshot,
} from "../agents/subagents/registry/subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  deleteSessionEntryLifecycle,
  persistSessionTranscriptTurn,
  readSessionTranscriptWatermark,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import * as entryCache from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import * as canonical from "../config/sessions/session-canonical-key.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import type { SessionRowDatabaseFacts } from "../config/sessions/session-transcript-worker.types.js";
import type { InternalSessionEntry, SessionAcpMeta } from "../config/sessions/types.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import * as agentDatabases from "../state/openclaw-agent-db.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import * as projectionWork from "./session-projection-work.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { isColdArchivedSessionRow } from "./session-row-projection-archive.js";
import * as databaseFactsRead from "./session-row-projection-read.js";
import { ready, type Row } from "./session-row-projection-record.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import * as rowInputs from "./session-utils-row.js";

afterEach(() => vi.restoreAllMocks());

/** Pause after the real read boundary has released Worker, continuation, and native custody. */
async function withAcceptedSuffix(
  run: (fixture: {
    projection: SessionRowProjection;
    suffix: Row;
    scope: { agentId: string; sessionKey: string };
    query: { agentId: string; key: string };
    entry: InternalSessionEntry;
    reads: SessionRowDatabaseFacts[][];
    replacementPath: string;
    viewerId?: string;
    resume: () => Promise<void>;
    failNextRender: () => void;
  }) => Promise<void>,
  options: {
    archived?: boolean;
    membership?: boolean;
    replacement?: boolean;
    acpMeta?: SessionAcpMeta | null;
  } = {},
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const keys = [
      "agent:main:accepted-a",
      options.acpMeta === undefined ? "agent:main:accepted-b" : "agent:main:acp:accepted-b",
    ];
    const identities = options.membership
      ? {
          owner: ensureProfileForEmail("accepted-owner@example.test"),
          viewer: ensureProfileForEmail("accepted-viewer@example.test"),
        }
      : undefined;
    const entries = keys.map<InternalSessionEntry>((_, index) => ({
      sessionId: `accepted-${index}`,
      updatedAt: 1,
      label: `initial-${index}`,
      ...(options.acpMeta !== undefined && index === 1
        ? { lifecycleRevision: "accepted-lifecycle" }
        : {}),
      ...(options.archived && index === 1 ? { archivedAt: 1 } : {}),
      ...(identities && index === 1
        ? {
            visibility: "read-only",
            createdActor: { type: "human", source: "profile", id: identities.owner.id },
          }
        : {}),
    }));
    for (const [index, sessionKey] of keys.entries()) {
      replaceSessionEntrySync({ agentId: "main", sessionKey }, entries[index]!);
    }
    if (options.acpMeta) {
      writeAcpSessionMetaForMigration({
        sessionKey: keys[1]!,
        lifecycleRevision: "accepted-lifecycle",
        meta: options.acpMeta,
      });
    }
    if (identities) {
      addSessionMember(
        { agentId: "main", sessionKey: keys[1]! },
        {
          identityId: identities.viewer.id,
          addedBy: identities.owner.id,
          addedAt: 1,
        },
      );
    }
    const replacementPath = state.statePath("imports", "accepted-replacement.sqlite");
    if (options.replacement) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: keys[1]!, storePath: replacementPath },
        { ...entries[1]!, updatedAt: 2, label: "replacement store" },
      );
      await closeOpenClawAgentDatabaseByPathAsync(replacementPath, "main");
    }
    const releaseForeground = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({
      cfg: {
        agents: {
          list: [{ id: "main", default: true }],
          defaults: { utilityModel: "unit-test/small" },
        },
      },
      modelCatalog: [],
    });
    const paused = createDeferredCore();
    const release = createDeferredCore();
    let reading: Promise<void> | undefined;
    try {
      await projection.ensureMaterialized();
      const query = { agentId: "main", key: keys[1]! };
      const previous = projection.describe(query)!;
      const count = projection.materializedCount;
      const releases: string[] = [];
      const continuations: SharedArrayBuffer[] = [];
      let trackingCustody = false;
      const capture = canonical.captureCanonicalSessionReaderContinuation;
      vi.spyOn(canonical, "captureCanonicalSessionReaderContinuation").mockImplementation((db) => {
        const owner = capture(db);
        if (!owner || !trackingCustody) {
          return owner;
        }
        continuations.push(owner.receipt.live);
        return {
          ...owner,
          release() {
            owner.release();
            releases.push("continuation");
          },
        };
      });
      const retain = agentDatabases.retainOpenClawAgentDatabaseReadCandidates;
      vi.spyOn(agentDatabases, "retainOpenClawAgentDatabaseReadCandidates").mockImplementation(
        (...args) => {
          const owner = retain(...args);
          if (!trackingCustody) {
            return owner;
          }
          expect(owner.databases).toHaveLength(1);
          return {
            ...owner,
            release() {
              owner.release();
              releases.push("native");
            },
          };
        },
      );
      const reads: SessionRowDatabaseFacts[][] = [];
      const readDatabases = history.withSessionHistoryWorkerDatabases;
      vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
        async (selected, consume) => {
          const tracked = trackingCustody;
          const result = await readDatabases(selected, (owners) =>
            consume(
              owners.map((owner) => ({
                ...owner,
                async readRowFacts(input) {
                  const reply = await owner.readRowFacts(input);
                  reads.push(structuredClone(reply.rows));
                  return reply;
                },
              })),
            ),
          );
          if (tracked) {
            releases.push("worker");
          }
          return result;
        },
      );
      let elapsed = 0;
      vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      const readInputs = rowInputs.readSessionRowInputs;
      const inputs = vi.spyOn(rowInputs, "readSessionRowInputs").mockImplementation((params) => {
        const result = readInputs(params);
        elapsed += 20;
        return result;
      });
      const readFacts = databaseFactsRead.withSessionRowDatabaseFacts;
      vi.spyOn(databaseFactsRead, "withSessionRowDatabaseFacts").mockImplementationOnce(
        async (...args) => {
          trackingCustody = true;
          try {
            await readFacts(...args);
          } finally {
            trackingCustody = false;
          }
          paused.resolve();
          await release.promise;
        },
      );
      for (const [index, sessionKey] of keys.entries()) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          { ...entries[index]!, updatedAt: 2, label: `accepted-${index}` },
        );
      }
      reading = projection.ensureMaterialized();
      await Promise.race([
        paused.promise,
        reading.then(() => {
          throw new Error("Drain bypassed the released-custody boundary");
        }),
      ]);
      expect(releases).toEqual(["worker", "continuation", "native"]);
      expect(continuations).toHaveLength(1);
      expect(Atomics.load(new Int32Array(continuations[0]!), 0)).toBe(0);
      const suffix = projection.findBySessionId({
        agentId: "main",
        sessionId: entries[1]!.sessionId,
      })[0]!;
      expect(suffix.pendingDatabaseFacts?.entry.label).toBe("accepted-1");
      expect(suffix.pendingDatabaseFacts?.acpMeta).toEqual(options.acpMeta ?? null);
      expect(suffix.materialized).toBe(previous.materialized);
      expect(suffix.materializedSequence).toBe(previous.materializedSequence);
      expect(ready(suffix)).toBe(false);
      expect(projection.materializedCount).toBe(count + 1);
      expect(reads).toHaveLength(1);
      expect(reads[0]?.map((row) => row.sessionKey)).toEqual(keys);
      await run({
        projection,
        suffix,
        query,
        reads,
        replacementPath,
        viewerId: identities?.viewer.id,
        scope: { agentId: "main", sessionKey: query.key },
        entry: { ...entries[1]!, updatedAt: 2, label: "accepted-1" },
        resume: async () => {
          release.resolve();
          await reading;
        },
        failNextRender: () => {
          inputs.mockImplementationOnce(() => {
            throw new Error("presentation unavailable");
          });
        },
      });
    } finally {
      release.resolve();
      await Promise.allSettled(reading ? [reading] : []);
      vi.restoreAllMocks();
      projection.dispose();
      releaseForeground();
    }
  });
}

it.each(["present", "absent", "ACP publication", "lifecycle reset"] as const)(
  "carries complete accepted ACP facts across a yield: %s",
  async (change) => {
    const initial: SessionAcpMeta = {
      backend: "accepted-acp-backend",
      agent: "main",
      runtimeSessionName: "accepted-1",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
    };
    await withAcceptedSuffix(
      async ({ projection, suffix, scope, query, entry, reads, resume }) => {
        const pending = suffix.pendingDatabaseFacts;
        const metadataReads = vi.spyOn(acpReads, "readAcpSessionMetaForEntries");
        let expected = change === "absent" ? null : initial;
        const changed = change === "ACP publication" || change === "lifecycle reset";
        if (change === "ACP publication") {
          expected = { ...initial, backend: "current-acp-backend", lastActivityAt: 2 };
          // Only the shared ACP row changes; agent entry and lifecycle stay fixed.
          writeAcpSessionMetaForMigration({
            sessionKey: query.key,
            lifecycleRevision: entry.lifecycleRevision,
            meta: expected,
          });
        } else if (change === "lifecycle reset") {
          replaceSessionEntrySync(scope, { ...entry, lifecycleRevision: "replacement" });
          expected = null;
        }
        expect(suffix.pendingDatabaseFacts).toBe(changed ? undefined : pending);
        const hostReads = observeSqliteReadSql(StatementSync.prototype);
        try {
          await resume();
          const row = projection.snapshot(query).row;
          expect(reads).toHaveLength(changed ? 2 : 1);
          expect(metadataReads).toHaveBeenCalledTimes(changed ? 1 : 0);
          expect(row?.runtimeSelectionLocked).toBe(expected !== null);
          if (expected) {
            expect(row?.agentRuntime).toMatchObject({
              id: expected.backend,
              source: "session-key",
            });
          }
          expect(
            projection.describe(query)?.materialized.source.thinkingProjection.acpMeta,
          ).toEqual(expected ?? undefined);
          expect(hostReads.queries.filter((sql) => sql.includes("acp_sessions"))).toEqual([]);
          expect(projection.dirtyRowCount).toBe(0);
        } finally {
          hostReads.restore();
        }
      },
      { acpMeta: change === "absent" ? null : initial },
    );
  },
);

it.each(["projection retirement", "ACP read failure"] as const)(
  "does not accept facts after an awaited %s",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = { agentId: "main", sessionKey: "agent:main:acp:late-facts" };
      replaceSessionEntrySync(scope, { sessionId: "late-facts", updatedAt: 1 });
      const releaseForeground = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({
        cfg: { agents: { list: [{ id: "main", default: true }] } },
        modelCatalog: [],
      });
      const captured = createDeferredCore();
      const release = createDeferredCore();
      let reading: Promise<void> | undefined;
      try {
        await projection.ensureMaterialized();
        const row = projection.findBySessionId({ agentId: "main", sessionId: "late-facts" })[0]!;
        const count = projection.materializedCount;
        const read = acpReads.readAcpSessionMetaForEntries;
        vi.spyOn(acpReads, "readAcpSessionMetaForEntries").mockImplementationOnce(
          async (params) => {
            const reply = await read(params);
            captured.resolve();
            await release.promise;
            if (change === "ACP read failure") {
              throw new Error("ACP metadata unavailable");
            }
            return reply;
          },
        );
        sessionChanges.emit(scope);
        reading = projection.ensureMaterialized();
        await Promise.race([
          captured.promise,
          reading.then(() => {
            throw new Error("Drain bypassed the pending ACP read");
          }),
        ]);
        expect(row.pendingDatabaseFacts).toBeUndefined();
        if (change === "projection retirement") {
          projection.dispose();
        }
        release.resolve();
        if (change === "ACP read failure") {
          await expect(reading).rejects.toThrow("ACP metadata unavailable");
          expect(projection.dirtyRowCount).toBe(1);
        } else {
          await reading;
        }
        expect(row.pendingDatabaseFacts).toBeUndefined();
        expect(projection.materializedCount).toBe(count);
      } finally {
        release.resolve();
        await Promise.allSettled(reading ? [reading] : []);
        projection.dispose();
        releaseForeground();
      }
    });
  },
);

it.each(["bulk completion with pinned pages", "transcript-only invalidation"] as const)(
  "handles an exact cold archive suffix during %s",
  async (mode) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        const cfg = {
          agents: {
            list: [{ id: "main", default: true }],
            defaults: { utilityModel: "unit-test/small" },
          },
        };
        setRuntimeConfigSnapshot(cfg);
        clearSubagentRunsReadCacheForTest();
        const transcriptOnly = mode === "transcript-only invalidation";
        const queries = Array.from({ length: transcriptOnly ? 2 : 102 }, (_, index) => ({
          agentId: "main",
          key: `agent:main:accepted-archive-${index}`,
        }));
        const entries = queries.map<InternalSessionEntry>((_, index) => ({
          sessionId: `accepted-archive-${index}`,
          updatedAt: 1,
          archivedAt: 1,
        }));
        for (const [index, query] of queries.entries()) {
          replaceSessionEntrySync(
            { agentId: query.agentId, sessionKey: query.key },
            entries[index]!,
          );
        }
        const suffixScope = {
          agentId: "main",
          sessionKey: queries[1]!.key,
          sessionId: entries[1]!.sessionId,
        };
        if (transcriptOnly) {
          await persistSessionTranscriptTurn(suffixScope, {
            config: cfg,
            messages: [{ message: { role: "user", content: "Summarized transcript" } }],
            touchSessionEntry: false,
            updateMode: "none",
          });
          const watermark = readSessionTranscriptWatermark(suffixScope);
          entries[1] = {
            ...entries[1]!,
            activitySummary: {
              version: 1,
              formatRevision: 2,
              text: "Stored archive summary",
              updatedAt: 1,
              sessionId: suffixScope.sessionId,
              generation: watermark.generation,
              maxSeq: watermark.maxSeq,
              leafEntryId: null,
              coveredMessages: 1,
              totalMessages: 1,
              omittedContent: false,
            },
          };
          replaceSessionEntrySync(suffixScope, entries[1]);
        }
        const previous = createSubagentRunRecord({
          runId: "accepted-archive-previous-run",
          childSessionKey: "agent:main:unrelated-child",
          requesterSessionKey: "agent:main:unrelated-parent",
          generation: 1,
          completion: { required: false },
          delivery: { status: "not_required" },
        });
        saveSubagentRegistryToSqlite(new Map([[previous.runId, previous]]));
        const releaseForeground = retainSessionListForegroundWork();
        const releaseBulk = createDeferredCore();
        const registryPending = createDeferredCore();
        const releaseRegistry = createDeferredCore();
        const accepted = createDeferredCore();
        const releaseExact = createDeferredCore();
        let holdBulk = false;
        const createDrain = projectionWork.createSessionProjectionDrain;
        vi.spyOn(projectionWork, "createSessionProjectionDrain").mockImplementationOnce((params) =>
          createDrain({
            ...params,
            async refresh() {
              if (holdBulk) {
                await releaseBulk.promise;
              }
              await params.refresh();
            },
          }),
        );
        const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
        let recovery: Promise<unknown> | undefined;
        let page: Promise<string[]> | undefined;
        let bulk: Promise<void> | undefined;
        try {
          await projection.ensureMaterialized();
          expect(projection.selectEntries().filter(ready)).toHaveLength(0);
          holdBulk = true;
          const executeRead = stateReads.executeExistingOpenClawStateRead;
          vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(
            async (...args) => {
              const result = await executeRead(...args);
              if (args[1].type === "subagents.sessionList") {
                registryPending.resolve();
                await releaseRegistry.promise;
              }
              return result;
            },
          );
          const replacement = { ...previous, runId: "accepted-archive-current-run", generation: 2 };
          saveSubagentRegistryToSqlite(new Map([[replacement.runId, replacement]]));
          recovery = withSubagentRunReadSnapshot(
            new Map(),
            (snapshot) => ({
              runIds: [...snapshot.values()]
                .filter((run) => run.childSessionKey === previous.childSessionKey)
                .map((run) => run.runId),
              sessionKeys: [],
            }),
            (selection) => selection.runIds,
          );
          await registryPending.promise;
          expect(getSubagentSessionListReadSnapshotIdentity()).toBeUndefined();
          // Recovery defers these real archive publications into the ordinary dirty queue.
          for (const [index, query] of queries.slice(0, 2).entries()) {
            replaceSessionEntrySync(
              { agentId: query.agentId, sessionKey: query.key },
              { ...entries[index]!, updatedAt: 2 },
            );
          }
          expect(projection.dirtyRowCount).toBe(2);
          releaseRegistry.resolve();
          expect(await recovery).toEqual([replacement.runId]);
          const reads: SessionRowDatabaseFacts[][] = [];
          const readDatabases = history.withSessionHistoryWorkerDatabases;
          vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
            (databases, consume) =>
              readDatabases(databases, (owners) =>
                consume(
                  owners.map((owner) => ({
                    ...owner,
                    async readRowFacts(input) {
                      const result = await owner.readRowFacts(input);
                      reads.push(structuredClone(result.rows));
                      return result;
                    },
                  })),
                ),
              ),
          );
          let elapsed = 0;
          const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
          const readInputs = rowInputs.readSessionRowInputs;
          const inputs = vi
            .spyOn(rowInputs, "readSessionRowInputs")
            .mockImplementation((params) => {
              const result = readInputs(params);
              elapsed += 20;
              return result;
            });
          const readFacts = databaseFactsRead.withSessionRowDatabaseFacts;
          vi.spyOn(databaseFactsRead, "withSessionRowDatabaseFacts").mockImplementationOnce(
            async (...args) => {
              await readFacts(...args);
              accepted.resolve();
              await releaseExact.promise;
            },
          );
          page = withReadySessionRows(
            projection,
            () => queries.slice(0, 2),
            (read) => queries.slice(0, 2).map((query) => read.describe(query)!.key),
          );
          await Promise.race([
            accepted.promise,
            page.then(() => {
              throw new Error("Exact page bypassed the accepted suffix");
            }),
          ]);
          const suffix = projection.findBySessionId({
            agentId: "main",
            sessionId: "accepted-archive-1",
          })[0]!;
          expect(isColdArchivedSessionRow(suffix)).toBe(true);
          expect(suffix.pendingDatabaseFacts?.entry.updatedAt).toBe(2);
          expect(projection.dirtyRowCount).toBe(1);
          if (transcriptOnly) {
            const previousWatermark = suffix.pendingDatabaseFacts!.activitySummaryWatermark;
            expect(previousWatermark).toMatchObject({
              generation: entries[1]!.activitySummary!.generation,
              maxSeq: entries[1]!.activitySummary!.maxSeq,
            });
            const publications: unknown[] = [];
            const unsubscribe = sessionChanges.subscribe((change) => publications.push(change));
            try {
              await persistSessionTranscriptTurn(suffixScope, {
                config: cfg,
                messages: [{ message: { role: "user", content: "New archived transcript" } }],
                touchSessionEntry: false,
              });
            } finally {
              unsubscribe();
            }
            expect(publications).toEqual([]);
            const watermark = readSessionTranscriptWatermark(suffixScope);
            expect(watermark).not.toEqual(previousWatermark);
            expect(suffix.pendingDatabaseFacts).toBeUndefined();
            expect(isColdArchivedSessionRow(suffix)).toBe(true);
            expect(ready(suffix)).toBe(false);
            inputs.mockRestore();
            clock.mockRestore();
            releaseExact.resolve();
            expect(await page).toEqual(queries.map((query) => query.key));
            expect(reads).toHaveLength(2);
            expect(reads[1]).toEqual([
              expect.objectContaining({
                sessionKey: suffixScope.sessionKey,
                entry: expect.objectContaining({
                  updatedAt: 2,
                  activitySummary: entries[1]!.activitySummary,
                }),
                activitySummaryWatermark: watermark,
              }),
            ]);
            expect(projection.snapshot(queries[1]!).row?.activitySummary).toMatchObject({
              text: "Stored archive summary",
              state: "stale",
            });
            expect(projection.dirtyRowCount).toBe(0);
            return;
          }
          holdBulk = false;
          releaseBulk.resolve();
          bulk = projection.ensureMaterialized();
          await bulk;
          expect(reads.map((rows) => rows.map((row) => row.sessionKey))).toEqual([
            queries.slice(0, 2).map((query) => query.key),
          ]);
          expect(ready(suffix)).toBe(true);
          expect(suffix.pendingDatabaseFacts).toBeUndefined();
          expect(projection.materializedCount).toBe(2);
          expect(projection.dirtyRowCount).toBe(0);
          inputs.mockRestore();
          clock.mockRestore();
          await withReadySessionRows(
            projection,
            () => queries.slice(2),
            () => {
              expect(projection.selectEntries().filter(ready)).toHaveLength(102);
            },
          );
          // Releasing the other page trims through the real LRU; the first page stays pinned.
          expect(projection.selectEntries().filter(ready)).toHaveLength(100);
          const residentKeys = new Set(
            projection
              .selectEntries()
              .filter(ready)
              .map((row) => row.key),
          );
          expect(queries.slice(0, 2).every((query) => residentKeys.has(query.key))).toBe(true);
          releaseExact.resolve();
          expect(await page).toEqual(queries.slice(0, 2).map((query) => query.key));
        } finally {
          holdBulk = false;
          releaseRegistry.resolve();
          releaseExact.resolve();
          releaseBulk.resolve();
          await Promise.allSettled([recovery, page, bulk, projection.ensureMaterialized()]);
          projection.dispose();
          releaseForeground();
        }
      },
    );
  },
);

it("lets same-generation keyed acquisition supersede accepted facts after custody release", async () => {
  await withAcceptedSuffix(async ({ projection, suffix, query, entry, reads, resume }) => {
    // Model a direct reader discovering a newer same-timestamp committed value.
    vi.spyOn(entryCache, "readCommittedSessionEntryCache").mockReturnValueOnce(
      new Map([[query.key, { ...entry, label: "keyed value" }]]),
    );
    const current = projection.describe(query)!;
    expect(current.generation).toBe(suffix.generation);
    expect(current.pendingDatabaseFacts).toBeUndefined();
    expect(current.materialized.source.entry).toBe(current.entry);
    await resume();
    expect(reads).toHaveLength(1);
    expect(projection.snapshot(query).row?.label).toBe("keyed value");
    expect(projection.dirtyRowCount).toBe(0);
  });
});

it("replaces the whole accepted entry, board, and watermark snapshot after a commit", async () => {
  await withAcceptedSuffix(async ({ projection, suffix, scope, query, entry, reads, resume }) => {
    expect(suffix.pendingDatabaseFacts?.hasBoard).toBe(false);
    const board = new SqliteBoardStore({
      resolveSession: ({ sessionKey }) => ({ agentId: "main", sessionKey }),
    });
    await board.putWidget({
      sessionKey: query.key,
      name: "status",
      content: { kind: "html", html: "<p>current</p>" },
    });
    await persistSessionTranscriptTurn(
      { ...scope, sessionId: entry.sessionId },
      {
        config: projection.state.cfg,
        messages: [{ message: { role: "user", content: "Current transcript" } }],
        touchSessionEntry: false,
        updateMode: "none",
      },
    );
    const watermark = readSessionTranscriptWatermark({ ...scope, sessionId: entry.sessionId });
    replaceSessionEntrySync(scope, {
      ...entry,
      label: "committed value",
      activitySummary: {
        version: 1,
        formatRevision: 2,
        text: "Current summary",
        updatedAt: 3,
        sessionId: entry.sessionId,
        generation: watermark.generation,
        maxSeq: watermark.maxSeq,
        leafEntryId: null,
        coveredMessages: 1,
        totalMessages: 1,
        omittedContent: false,
      },
    });
    expect(suffix.pendingDatabaseFacts).toBeUndefined();
    expect(ready(suffix)).toBe(false);
    await resume();
    expect(reads).toHaveLength(2);
    expect(reads[1]).toEqual([
      expect.objectContaining({
        sessionKey: query.key,
        entry: expect.objectContaining({ label: "committed value" }),
        hasBoard: true,
        activitySummaryWatermark: watermark,
      }),
    ]);
    expect(projection.describe(query)?.hasBoard).toBe(true);
    expect(projection.snapshot(query).row).toMatchObject({
      label: "committed value",
      activitySummary: { text: "Current summary", state: "current" },
    });
    expect(projection.dirtyRowCount).toBe(0);
  });
});

it.each(["runtime facts", "invalidated presentation facts"] as const)(
  "discards accepted facts for %s after custody release",
  async (change) => {
    await withAcceptedSuffix(async ({ projection, suffix, scope, query, entry, reads, resume }) => {
      const emit = sessionChanges.emit.bind(sessionChanges);
      vi.spyOn(sessionChanges, "emit").mockImplementation((publication, database) => {
        if ("sessionKey" in publication && publication.sessionKey === query.key) {
          if (change === "runtime facts") {
            publication.scope = "runtime";
          } else {
            emit({ all: true, scope: "profiles", factsInvalidated: true }, database);
            return;
          }
        }
        emit(publication, database);
      });
      replaceSessionEntrySync(scope, { ...entry, label: "current value" });
      expect(suffix.pendingDatabaseFacts).toBeUndefined();
      expect(ready(suffix)).toBe(false);
      await resume();
      expect(reads.length).toBeGreaterThan(1);
      expect(projection.snapshot(query).row?.label).toBe("current value");
      expect(projection.dirtyRowCount).toBe(0);
    });
  },
);

it("keeps accepted resident facts after their native reader is retired", async () => {
  await withAcceptedSuffix(async ({ projection, suffix, query, reads, resume }) => {
    await closeOpenClawAgentDatabaseByPathAsync(suffix.storeTarget.storePath, "main");
    await resume();
    expect(reads).toHaveLength(1);
    expect(projection.snapshot(query).row?.label).toBe("accepted-1");
    expect(projection.dirtyRowCount).toBe(0);
  });
});

it("retains accepted facts through catalog publication between presentation slices", async () => {
  await withAcceptedSuffix(async ({ projection, suffix, query, reads, resume }) => {
    const pending = suffix.pendingDatabaseFacts;
    sessionChanges.emit({ all: true, scope: "catalog" });
    expect(suffix.pendingDatabaseFacts).toBe(pending);
    await resume();
    expect(reads).toHaveLength(1);
    expect(projection.snapshot(query).row?.label).toBe("accepted-1");
    expect(projection.dirtyRowCount).toBe(0);
  });
});

it("presents current runtime activity without reacquiring accepted database facts", async () => {
  await withAcceptedSuffix(
    async ({ projection, suffix, query, entry, reads, viewerId, resume }) => {
      const pending = suffix.pendingDatabaseFacts;
      const runId = "accepted-suffix-current-run";
      registerAgentRunContext(runId, {
        agentId: query.agentId,
        sessionKey: query.key,
        sessionId: entry.sessionId,
        projectSessionActive: true,
      });
      try {
        expect(suffix.pendingDatabaseFacts).toBe(pending);
        await resume();
        const context = bindSessionRowProjection(
          requestContext(projection.state.cfg),
          () => projection,
        );
        const result = await listSessions({
          client: identifiedClient(viewerId!),
          context,
          request: { agentId: "main", limit: 10 },
        });
        expect(reads).toHaveLength(1);
        expect(result.sessions.find((row) => row.key === query.key)).toMatchObject({
          label: "accepted-1",
          hasActiveRun: true,
          status: "running",
        });
      } finally {
        clearAgentRunContext(runId);
      }
    },
    { membership: true },
  );
});

it("retains accepted facts and dirty work when presentation fails", async () => {
  await withAcceptedSuffix(async ({ projection, suffix, query, reads, resume, failNextRender }) => {
    const pending = suffix.pendingDatabaseFacts;
    const sequence = suffix.materializedSequence;
    failNextRender();
    await expect(resume()).rejects.toThrow("presentation unavailable");
    expect(suffix.pendingDatabaseFacts).toBe(pending);
    expect(suffix.materializedSequence).toBe(sequence);
    expect(ready(suffix)).toBe(false);
    expect(projection.dirtyRowCount).toBe(1);
    await projection.ensureMaterialized();
    expect(reads).toHaveLength(1);
    expect(projection.snapshot(query).row?.label).toBe("accepted-1");
    expect(projection.dirtyRowCount).toBe(0);
  });
});

it.each(["reset", "delete", "dispose"] as const)(
  "does not render the accepted suffix after %s",
  async (change) => {
    await withAcceptedSuffix(async ({ projection, suffix, scope, query, entry, resume }) => {
      if (change === "reset") {
        replaceSessionEntrySync(scope, {
          ...entry,
          lifecycleRevision: "reset",
          label: "reset value",
        });
      } else if (change === "delete") {
        await deleteSessionEntryLifecycle({
          ...scope,
          storePath: suffix.storeTarget.storePath,
          archiveTranscript: false,
          target: { canonicalKey: query.key, storeKeys: [query.key] },
        });
      } else {
        projection.dispose();
      }
      await resume();
      expect(projection.isCurrent(suffix)).toBe(false);
      expect(projection.snapshot(query).row?.label ?? null).toBe(
        change === "reset" ? "reset value" : null,
      );
      expect(projection.dirtyRowCount).toBe(0);
    });
  },
);

it("prepares a warm archived suffix without treating stale presentation as cold", async () => {
  await withAcceptedSuffix(
    async ({ projection, suffix, scope, query, entry, resume }) => {
      expect(isColdArchivedSessionRow(suffix)).toBe(false);
      replaceSessionEntrySync(scope, { ...entry, label: "current archive" });
      expect(suffix.pendingDatabaseFacts).toBeUndefined();
      expect(ready(suffix)).toBe(false);
      const current = projection.describe(query)!;
      expect(isColdArchivedSessionRow(current)).toBe(false);
      expect(current.materialized.source.entry).toBe(current.entry);
      expect(current.materialized.row.label).toBe("current archive");
      await resume();
      expect(projection.dirtyRowCount).toBe(0);
    },
    { archived: true },
  );
});

it("applies committed membership revocation after the suffix has been accepted", async () => {
  await withAcceptedSuffix(
    async ({ projection, suffix, scope, query, viewerId, resume }) => {
      expect(viewerId).toBeDefined();
      expect(projection.hasMembership(suffix.storeTarget.storePath, query.key, viewerId!)).toBe(
        true,
      );
      expect(removeSessionMember(scope, viewerId!)).not.toBeNull();
      expect(projection.hasMembership(suffix.storeTarget.storePath, query.key, viewerId!)).toBe(
        false,
      );
      expect(suffix.pendingDatabaseFacts).toBeUndefined();
      await resume();
      const context = bindSessionRowProjection(
        requestContext(projection.state.cfg),
        () => projection,
      );
      const result = await listSessions({
        client: identifiedClient(viewerId!),
        context,
        request: { agentId: "main", limit: 10 },
      });
      expect(result.sessions.find((row) => row.key === query.key)?.sharingRole).toBe("viewer");
      expect(projection.describe(query)?.membership.has(viewerId!)).toBe(false);
    },
    { membership: true },
  );
});

it("demotes an accepted suffix without rendering it during the bulk drain", async () => {
  await withAcceptedSuffix(async ({ projection, scope, query, entry, resume }) => {
    const count = projection.materializedCount;
    replaceSessionEntrySync(scope, { ...entry, archivedAt: 3, label: "archived suffix" });
    await resume();
    expect(projection.materializedCount).toBe(count);
    const cold = projection.findBySessionId({ agentId: "main", sessionId: entry.sessionId })[0]!;
    expect(isColdArchivedSessionRow(cold)).toBe(true);
    expect(cold.pendingDatabaseFacts).toBeUndefined();
    expect(projection.dirtyRowCount).toBe(0);
    expect(projection.snapshot(query).row?.label).toBe("archived suffix");
  });
});

it("replaces accepted facts when the physical store changes between slices", async () => {
  await withAcceptedSuffix(
    async ({ projection, suffix, query, replacementPath, resume }) => {
      const pending = suffix.pendingDatabaseFacts;
      const storePath = suffix.storeTarget.storePath;
      await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
      expect(suffix.pendingDatabaseFacts).toBe(pending);
      renameSync(replacementPath, storePath);
      registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
      await resume();
      expect(projection.isCurrent(suffix)).toBe(false);
      expect(projection.snapshot(query).row?.label).toBe("replacement store");
      expect(projection.dirtyRowCount).toBe(0);
    },
    { replacement: true },
  );
});

it("releases the accepted snapshot graph when its projection is disposed", async () => {
  let pending: WeakRef<object> | undefined;
  let control: WeakRef<object> | undefined;
  await withAcceptedSuffix(async ({ projection, suffix, resume }) => {
    pending = new WeakRef(suffix.pendingDatabaseFacts!);
    control = new WeakRef({});
    projection.dispose();
    await resume();
  });
  await nextTurn();
  queryObjects(WeakRef);
  expect(control?.deref()).toBeUndefined();
  expect(pending?.deref()).toBeUndefined();
});
