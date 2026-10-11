import { renameSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { StatementSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentSessionListReadSnapshotIdentity,
  prepareSubagentSessionListReadCache,
} from "../agents/subagents/registry/subagent-registry-state.js";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import { ACTIVITY_SUMMARY_FORMAT_REVISION } from "../config/sessions/activity-summary.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  persistSessionTranscriptTurn,
  readSessionTranscriptWatermark,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { applySessionEntryExactReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { SessionRowDatabaseFacts } from "../config/sessions/session-row-facts.types.js";
import { removeSessionMember } from "../config/sessions/session-sharing-store.native.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import type { InternalSessionEntry, SessionAcpMeta } from "../config/sessions/types.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  emitSessionsChanged,
  flushPendingSessionsChangedEvents,
} from "./server-methods/session-change-event.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { setSessionActivitySummaryState } from "./session-activity-summary-state.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { defaultPersistDigest } from "./session-observer-model.js";
import * as projectionWork from "./session-projection-work.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { isColdArchivedSessionRow } from "./session-row-projection-archive.js";
import * as databaseFactsRead from "./session-row-projection-read.js";
import { ready } from "./session-row-projection-record.js";
import { withAcceptedSuffix } from "./session-row-projection.accepted-facts.test-support.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import * as rowInputs from "./session-utils-row.js";

afterEach(() => vi.restoreAllMocks());

it("keeps Board and shared facts while transcript receipts advance summary freshness", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:acp:row-receipts",
      sessionId: "row-receipts",
    };
    const entry: InternalSessionEntry = {
      sessionId: scope.sessionId,
      lifecycleRevision: "row-receipts-life",
      updatedAt: 1,
    };
    replaceSessionEntrySync(scope, entry);
    // Cold transcript initialization may acquire row facts before warmed receipt reuse begins.
    await persistSessionTranscriptTurn(scope, {
      messages: [{ message: { role: "user", content: "Initial transcript" } }],
      touchSessionEntry: false,
    });
    const acp: SessionAcpMeta = {
      backend: "receipt-backend",
      agent: "main",
      runtimeSessionName: "receipt-session",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
    };
    seedCanonicalAcpSessionMeta({
      ...scope,
      lifecycleRevision: entry.lifecycleRevision,
      meta: acp,
    });
    const board = new SqliteBoardStore({
      resolveSession: ({ sessionKey }) => ({ agentId: "main", sessionKey }),
    });
    await board.putWidget({
      sessionKey: scope.sessionKey,
      name: "status",
      content: { kind: "html", html: "<p>Current</p>" },
    });
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({
      cfg: {
        agents: {
          entries: { main: {} },
          defaults: { utilityModel: "unit-test/small" },
        },
      },
      modelCatalog: [],
    });
    const query = { agentId: scope.agentId, key: scope.sessionKey };
    try {
      await projection.ensureMaterialized();
      const rowReads: string[] = [];
      const readDatabases = history.withSessionHistoryWorkerDatabases;
      vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
        (databases, consume, lane) =>
          readDatabases(
            databases,
            (owners) =>
              consume(
                owners.map((owner) => ({
                  ...owner,
                  readRowFacts(input) {
                    rowReads.push(...input.sessionKeys);
                    return owner.readRowFacts(input);
                  },
                })),
              ),
            lane,
          ),
      );
      const sharedReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      await persistSessionTranscriptTurn(scope, {
        messages: [{ message: { role: "user", content: "First input" } }],
        touchSessionEntry: false,
      });
      await projection.ensureMaterialized();
      const watermark = readSessionTranscriptWatermark(scope);
      replaceSessionEntrySync(scope, {
        ...entry,
        label: "Published label",
        activitySummary: {
          version: 1,
          formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION,
          text: "First input",
          updatedAt: 2,
          sessionId: scope.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          ...watermark,
          leafEntryId: null,
          coveredMessages: 2,
          totalMessages: 2,
          omittedContent: false,
        },
      });
      await projection.ensureMaterialized();
      expect(projection.snapshot(query).row).toMatchObject({
        label: "Published label",
        activitySummary: { text: "First input", state: "current" },
      });
      await persistSessionTranscriptTurn(scope, {
        messages: [{ message: { role: "assistant", content: "Second message" } }],
        touchSessionEntry: false,
      });
      await projection.ensureMaterialized();
      expect(projection.snapshot(query).row?.activitySummary?.state).toBe("stale");
      expect(projection.describe(query)?.retainedDatabaseFacts).toMatchObject({
        hasBoard: true,
        acpMeta: acp,
        activitySummaryWatermark: readSessionTranscriptWatermark(scope),
      });
      expect(rowReads).toEqual([]);
      expect(
        sharedReads.mock.calls.filter(([, command]) => command.type === "sessionRows.sharedFacts"),
      ).toEqual([]);
    } finally {
      projection.dispose();
      release();
    }
  });
});

it("rematerializes activity state from accepted facts without reading the databases again", async () => {
  await withAcceptedSuffix(async ({ projection, suffix, query, entry, reads, resume }) => {
    const revision = suffix.databaseFactsRevision;
    const owner = Symbol("activity-state");
    const target = { key: query.key, agentId: query.agentId };
    const value = {
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      storePath: resolveSessionStorePathCore(projection.state.cfg.session?.store, {
        agentId: query.agentId,
      }),
      state: "updating" as const,
    };
    const sharedReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    try {
      setSessionActivitySummaryState(target, owner, value);
      await resume();
      expect(projection.snapshot(query).row?.activitySummary?.state).toBe("updating");
      setSessionActivitySummaryState(target, owner, { ...value, state: "unavailable" });
      await projection.ensureMaterialized();
      expect(projection.snapshot(query).row?.activitySummary?.state).toBe("unavailable");
      setSessionActivitySummaryState(target, owner);
      await projection.ensureMaterialized();
      expect(projection.snapshot(query).row?.activitySummary?.state).toBe("stale");
      expect(reads).toHaveLength(1);
      expect(sharedReads).not.toHaveBeenCalled();
      expect(projection.capture(query)?.databaseFactsRevision).toBe(revision);

      // An explicit storage uncertainty still wins over the presentation scope.
      sessionChanges.emit({
        sessionKey: query.key,
        agentId: query.agentId,
        storePath: suffix.storeTarget.storePath,
        scope: "runtime",
        factsInvalidated: true,
      });
      await projection.ensureMaterialized();
      expect(reads.length).toBeGreaterThan(1);
      expect(projection.snapshot(query).row?.label).toBe("accepted-1");
    } finally {
      setSessionActivitySummaryState(target, owner);
    }
  });
});

it.each([
  "ACP publication",
  "lifecycle reset",
  "worker legacy reset",
  "lifecycle adapter",
  "observer adapter",
  "transcript publication",
] as const)("carries complete accepted ACP facts across a yield: %s", async (change) => {
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
      const sharing =
        change === "lifecycle adapter" || change === "observer adapter"
          ? await prepareSessionMutationFacts({ cfg: getRuntimeConfig(), ...scope })
          : undefined;
      if (sharing) {
        onTestFinished(sharing.release);
      }
      const metadataReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      let expected: SessionAcpMeta | null = initial;
      const workerReceipt =
        change === "worker legacy reset" ||
        change === "lifecycle adapter" ||
        change === "observer adapter";
      const retainsFacts = workerReceipt || change === "transcript publication";
      if (change === "ACP publication") {
        expected = { ...initial, backend: "current-acp-backend", lastActivityAt: 2 };
        // Only the shared ACP row changes; agent entry and lifecycle stay fixed.
        seedCanonicalAcpSessionMeta({
          sessionKey: query.key,
          lifecycleRevision: entry.lifecycleRevision,
          meta: expected,
        });
      } else if (change === "lifecycle reset") {
        replaceSessionEntrySync(scope, { ...entry, lifecycleRevision: "replacement" });
        expected = null;
      } else if (change === "transcript publication") {
        await persistSessionTranscriptTurn(
          { ...scope, sessionId: entry.sessionId, storePath: suffix.storeTarget.storePath },
          {
            messages: [{ message: { role: "assistant", content: "New transcript content" } }],
            touchSessionEntry: false,
          },
        );
      } else if (change === "lifecycle adapter") {
        await persistGatewaySessionLifecycleEvent({
          ...scope,
          event: {
            sessionId: entry.sessionId,
            runId: "receipt-run",
            ts: 3,
            data: { phase: "start" },
          },
        });
      } else if (change === "observer adapter") {
        expect(
          await defaultPersistDigest({
            ...scope,
            storePath: suffix.storeTarget.storePath,
            sessionId: entry.sessionId,
            digest: {
              sessionKey: scope.sessionKey,
              sessionId: entry.sessionId,
              lifecycleRevision: entry.lifecycleRevision,
              runId: "receipt-run",
              revision: 1,
              updatedAt: 3,
              headline: "Checking receipt",
              health: "on-track",
            },
          }),
        ).toBe(true);
      } else {
        await applySessionEntryExactReplacements({
          agentId: scope.agentId,
          storePath: suffix.storeTarget.storePath,
          sessionKeys: [scope.sessionKey],
          update: ([row]) => ({
            result: undefined,
            replacements: [
              {
                sessionKey: scope.sessionKey,
                entry: {
                  ...row!.entry,
                  label: "receipt",
                  sessionStartedAt: 2,
                },
              },
            ],
          }),
        });
        expected = null;
      }
      if (sharing) {
        expect(sharing.readCurrent(getRuntimeConfig()).target?.entry).toMatchObject({
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
        });
        sharing.release();
      }
      expect(suffix.pendingDatabaseFacts).toBeUndefined();
      const hostReads = observeSqliteReadSql(StatementSync.prototype);
      try {
        await resume();
        const row = projection.snapshot(query).row;
        expect(reads).toHaveLength(retainsFacts ? 1 : 2);
        expect(
          metadataReads.mock.calls.filter(
            ([, command]) => command.type === "sessionRows.sharedFacts",
          ),
        ).toHaveLength(!retainsFacts || change === "worker legacy reset" ? 1 : 0);
        expect(row?.runtimeSelectionLocked).toBe(expected !== null);
        if (expected) {
          expect(row?.agentRuntime).toMatchObject({
            id: expected.backend,
            source: "session-key",
          });
        }
        expect(projection.describe(query)?.materialized.source.thinkingProjection.acpMeta).toEqual(
          expected ?? undefined,
        );
        expect(hostReads.queries.filter((sql) => sql.includes("acp_sessions"))).toEqual([]);
        expect(projection.dirtyRowCount).toBe(0);
      } finally {
        hostReads.restore();
      }
    },
    {
      acpMeta: initial,
      ...(change === "worker legacy reset" ? { legacyAcp: true } : {}),
    },
  );
});

it.each(["projection retirement", "ACP read failure"] as const)(
  "does not accept facts after an awaited %s",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = { agentId: "main", sessionKey: "agent:main:acp:late-facts" };
      replaceSessionEntrySync(scope, { sessionId: "late-facts", updatedAt: 1 });
      const releaseForeground = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({
        cfg: { agents: { entries: { main: {} } } },
        modelCatalog: [],
      });
      const captured = createDeferredCore();
      const release = createDeferredCore();
      let reading: Promise<void> | undefined;
      try {
        await projection.ensureMaterialized();
        const row = projection.findBySessionId({ agentId: "main", sessionId: "late-facts" })[0]!;
        const count = projection.materializedCount;
        const read = stateReads.executeExistingOpenClawStateRead;
        let held = false;
        vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(
          async (...args) => {
            const reply = await read(...args);
            if (args[1].type !== "sessionRows.sharedFacts" || held) {
              return reply;
            }
            held = true;
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
            entries: { main: {} },
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
              formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION,
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
          clearSubagentRunsReadCacheForTest();
          recovery = prepareSubagentSessionListReadCache();
          await registryPending.promise;
          expect(getSubagentSessionListReadSnapshotIdentity()).toBeUndefined();
          // Cold preparation defers these archive publications into the ordinary dirty queue.
          for (const [index, query] of queries.slice(0, 2).entries()) {
            replaceSessionEntrySync(
              { agentId: query.agentId, sessionKey: query.key },
              { ...entries[index]!, updatedAt: 2 },
            );
          }
          expect(projection.dirtyRowCount).toBe(2);
          releaseRegistry.resolve();
          await recovery;
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
            expect(reads).toHaveLength(1);
            expect(projection.describe(queries[1]!)?.retainedDatabaseFacts).toMatchObject({
              sessionKey: suffixScope.sessionKey,
              entry: {
                updatedAt: 2,
                activitySummary: entries[1]!.activitySummary,
              },
              activitySummaryWatermark: watermark,
            });
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

it("lets keyed reads supersede accepted archive facts after a same-generation publication", async () => {
  await withAcceptedSuffix(
    async ({ projection, suffix, scope, query, entry, resume }) => {
      const label = "current archive";
      expect(isColdArchivedSessionRow(suffix)).toBe(false);
      // Equal timestamps still require the keyed reader to consume the owner's newer publication.
      replaceSessionEntrySync(scope, { ...entry, label });
      expect(suffix.pendingDatabaseFacts).toBeUndefined();
      expect(ready(suffix)).toBe(false);
      const pending = withReadySessionRows(
        projection,
        () => [query],
        (read) => read.describe(query)!,
      );
      await resume();
      const current = await pending;
      expect(current.generation).toBe(suffix.generation);
      expect(current.pendingDatabaseFacts).toBeUndefined();
      expect(current.entry).toMatchObject({ updatedAt: entry.updatedAt, label });
      expect(current.materialized.source.entry).toBe(current.entry);
      expect(isColdArchivedSessionRow(current)).toBe(false);
      expect(current.materialized.row.label).toBe(label);
      expect(projection.dirtyRowCount).toBe(0);
    },
    { archived: true },
  );
});

it("replaces accepted entry, board, and watermark facts through a worker receipt", async () => {
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
    const committedEntry: InternalSessionEntry = {
      ...entry,
      label: "committed value",
      activitySummary: {
        version: 1,
        formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION,
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
    };
    await applySessionEntryExactReplacements({
      agentId: scope.agentId,
      storePath: suffix.storeTarget.storePath,
      sessionKeys: [scope.sessionKey],
      update: () => ({
        result: undefined,
        replacements: [{ sessionKey: scope.sessionKey, entry: committedEntry }],
      }),
    });
    expect(suffix.pendingDatabaseFacts).toBeUndefined();
    expect(ready(suffix)).toBe(false);
    await resume();
    expect(reads).toHaveLength(1);
    expect(projection.describe(query)?.retainedDatabaseFacts).toMatchObject({
      sessionKey: query.key,
      entry: expect.objectContaining({ label: "committed value" }),
      hasBoard: true,
      activitySummaryWatermark: watermark,
    });
    expect(projection.describe(query)?.hasBoard).toBe(true);
    expect(projection.snapshot(query).row).toMatchObject({
      label: "committed value",
      activitySummary: { text: "Current summary", state: "current" },
    });
    expect(projection.dirtyRowCount).toBe(0);
  });
});

it("discards invalidated presentation facts after custody release", async () => {
  await withAcceptedSuffix(async ({ projection, suffix, scope, query, entry, reads, resume }) => {
    const emit = sessionChanges.emit.bind(sessionChanges);
    vi.spyOn(sessionChanges, "emit").mockImplementation((publication, database) => {
      if ("sessionKey" in publication && publication.sessionKey === query.key) {
        emit({ all: true, scope: "profiles", factsInvalidated: true }, database);
        return;
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
});

it.each(["native reader retirement", "catalog publication", "presentation failure"] as const)(
  "retains accepted database facts through %s",
  async (change) => {
    await withAcceptedSuffix(
      async ({ projection, suffix, query, reads, resume, failNextRender }) => {
        const pending = suffix.pendingDatabaseFacts;
        if (change === "native reader retirement") {
          await closeOpenClawAgentDatabaseByPathAsync(suffix.storeTarget.storePath, "main");
        } else if (change === "catalog publication") {
          sessionChanges.emit({ all: true, scope: "catalog" });
          expect(suffix.pendingDatabaseFacts).toBe(pending);
        }
        if (change === "presentation failure") {
          const sequence = suffix.materializedSequence;
          failNextRender();
          await expect(resume()).rejects.toThrow("presentation unavailable");
          expect(suffix.pendingDatabaseFacts).toBe(pending);
          expect(suffix.materializedSequence).toBe(sequence);
          expect(ready(suffix)).toBe(false);
          expect(projection.dirtyRowCount).toBe(1);
          await projection.ensureMaterialized();
        } else {
          await resume();
        }
        expect(reads).toHaveLength(1);
        expect(projection.snapshot(query).row?.label).toBe("accepted-1");
        expect(projection.dirtyRowCount).toBe(0);
      },
    );
  },
);

it.each(["runtime activity", "membership revocation"] as const)(
  "presents current %s after accepting a shared suffix",
  async (change) => {
    await withAcceptedSuffix(
      async ({ projection, suffix, scope, query, entry, reads, viewerId, resume }) => {
        const runId = "accepted-suffix-current-run";
        const pending = suffix.pendingDatabaseFacts;
        const context = bindSessionRowProjection(
          requestContext(projection.state.cfg),
          () => projection,
        );
        const sharedReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
        const broadcast = vi.fn();
        const publishSettled = () =>
          emitSessionsChanged(
            context,
            { ...scope, reason: "agent.input.settled" },
            { accessChanged: false, rowScope: "runtime" },
          );
        if (change === "runtime activity") {
          context.getSessionEventSubscriberConnIds = () => new Set(["activity-reader"]);
          context.broadcastToConnIds = broadcast;
          registerAgentRunContext(runId, {
            agentId: query.agentId,
            sessionKey: query.key,
            sessionId: entry.sessionId,
            projectSessionActive: true,
          });
          publishSettled();
        }
        try {
          if (change === "membership revocation") {
            expect(viewerId).toBeDefined();
            expect(
              projection.hasMembership(suffix.storeTarget.storePath, query.key, viewerId!),
            ).toBe(true);
            expect(removeSessionMember(scope, viewerId!)).not.toBeNull();
            expect(
              projection.hasMembership(suffix.storeTarget.storePath, query.key, viewerId!),
            ).toBe(false);
            expect(suffix.pendingDatabaseFacts).toBeUndefined();
          } else {
            expect(suffix.pendingDatabaseFacts).toBe(pending);
          }
          await resume();
          await flushPendingSessionsChangedEvents(context);
          const result = await listSessions({
            client: identifiedClient(viewerId!),
            context,
            request: { agentId: "main", limit: 10 },
          });
          const row = result.sessions.find((candidate) => candidate.key === query.key);
          if (change === "runtime activity") {
            expect(reads).toHaveLength(1);
            expect(row).toMatchObject({
              label: "accepted-1",
              hasActiveRun: true,
              status: "running",
            });
            expect(broadcast.mock.lastCall?.[1]).toMatchObject({
              reason: "agent.input.settled",
              session: { label: "accepted-1" },
              hasActiveRun: true,
            });
            clearAgentRunContext(runId);
            publishSettled();
            await flushPendingSessionsChangedEvents(context);
            expect(broadcast.mock.lastCall?.[1]).toMatchObject({
              reason: "agent.input.settled",
              session: { label: "accepted-1" },
              hasActiveRun: false,
            });
            expect(reads).toHaveLength(1);
            expect(
              sharedReads.mock.calls.filter(
                ([, command]) => command.type === "sessionRows.sharedFacts",
              ),
            ).toEqual([]);
          } else {
            expect(row?.sharingRole).toBe("viewer");
            expect(projection.describe(query)?.membership.has(viewerId!)).toBe(false);
          }
        } finally {
          if (change === "runtime activity") {
            clearAgentRunContext(runId);
            await resume();
            await flushPendingSessionsChangedEvents(context);
          }
        }
      },
      { membership: true },
    );
  },
);

it.each(["delete", "dispose", "store replacement"] as const)(
  "does not render the accepted suffix after %s",
  async (change) => {
    let pending: WeakRef<object> | undefined;
    let control: WeakRef<object> | undefined;
    await withAcceptedSuffix(
      async ({ projection, suffix, scope, query, replacementPath, resume }) => {
        if (change === "delete") {
          await deleteSessionEntryLifecycle({
            ...scope,
            storePath: suffix.storeTarget.storePath,
            archiveTranscript: false,
            target: { canonicalKey: query.key, storeKeys: [query.key] },
          });
        } else if (change === "store replacement") {
          const accepted = suffix.pendingDatabaseFacts;
          const storePath = suffix.storeTarget.storePath;
          await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
          expect(suffix.pendingDatabaseFacts).toBe(accepted);
          renameSync(replacementPath, storePath);
          registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
        } else {
          pending = new WeakRef(suffix.pendingDatabaseFacts!);
          control = new WeakRef({});
          projection.dispose();
        }
        await resume();
        expect(projection.isCurrent(suffix)).toBe(false);
        expect(projection.snapshot(query).row?.label ?? null).toBe(
          change === "store replacement" ? "replacement store" : null,
        );
        expect(projection.dirtyRowCount).toBe(0);
      },
      { replacement: change === "store replacement" },
    );
    if (change === "dispose") {
      await nextTurn();
      queryObjects(WeakRef);
      expect(control?.deref()).toBeUndefined();
      expect(pending?.deref()).toBeUndefined();
    }
  },
);

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
    await withReadySessionRows(
      projection,
      () => [query],
      () => {
        expect(projection.snapshot(query).row?.label).toBe("archived suffix");
      },
    );
  });
});
