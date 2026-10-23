import { symlinkSync } from "node:fs";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import {
  observeSqliteReadSql,
  observeHostDataSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { withSessionCompactionPersistenceAsync } from "../agents/sessions/session-compaction-persistence.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
  assignSessionOwner,
  loadSessionEntry,
  persistCompactionBoundaryWithSessionEntryAsync,
} from "../config/sessions/session-accessor.js";
import { readSessionEntryCache } from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { readCommittedSessionEntryCache } from "../config/sessions/session-accessor.sqlite-entry-cache.test-support.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { runSqliteSessionReclamation } from "../config/sessions/session-accessor.sqlite-reclamation-run.js";
import { createSessionMaintenanceFinalizationOperation } from "../config/sessions/session-accessor.sqlite-reclamation.js";
import { applySessionEntryExactReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  emitSessionLifecycleEvent,
  onSessionIdentityMutation,
} from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  retainSessionListForegroundWork,
  yieldSessionListBackgroundWork,
} from "./session-projection-work.js";
import { observeSessionRowBackfill } from "./session-row-backfill.test-support.js";
import * as databaseFactsRead from "./session-row-database-facts.js";
import { withReadySessionRows, SessionRowFactsPending } from "./session-row-prepared-read.js";
import * as materialization from "./session-row-projection-materialize.js";
import { listRows, writeRow } from "./session-row-projection-read-fixtures.test-support.js";
import * as records from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { waitForRead, watchRowFacts } from "./session-row-projection.read-fixture.test-support.js";
import { withSessionRowProjectionState } from "./session-row-projection.test-support.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";
import { listProjectedSessions } from "./session-utils-list.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

afterEach(() => vi.restoreAllMocks());

const { ready } = records;
const cfg = { agents: { entries: { main: {} } } };

type Projection = SessionRowProjection;
type SnapshotQuery = Parameters<Projection["snapshot"]>[0];

function preparedSnapshot(projection: Projection, query: SnapshotQuery) {
  return withReadySessionRows(
    projection,
    () => [query],
    () => projection.snapshot(query),
  );
}

const waitForPage = (
  page: ReturnType<typeof listProjectedSessions>,
  prepared: { promise: Promise<void> },
  signal: AbortSignal,
) =>
  waitForRead(
    prepared.promise,
    page,
    signal,
    "Archive page settled before its preparation barrier",
  );

it("keeps archived rows cold at hydration and across broad refreshes", async () => {
  await withSessionRowProjectionState(async (create, _, cleanup) => {
    const live = 3;
    const archived = 8;
    const placements = createWorkerSessionPlacementStore();
    for (let index = 0; index < live + archived; index++) {
      await placements.startDispatch({
        agentId: "main",
        sessionKey: `agent:main:row-${index}`,
        sessionId: `row-${index}`,
      });
      writeRow(`agent:main:row-${index}`, {
        sessionId: `row-${index}`,
        updatedAt: index + 1,
        ...(index >= live ? { archivedAt: 1 } : {}),
      });
    }
    cleanup.defer(retainSessionListForegroundWork());
    const placementReads = vi.spyOn(placements, "readProjection");
    const projection = await create({
      cfg,
      modelCatalog: [],
      placementFactsReader: placements,
    });

    await projection.ensureMaterialized();
    await listRows(projection, { limit: live });
    expect(projection.materializedCount).toBe(live);
    expect(projection.selectEntries().filter(ready)).toHaveLength(live);
    expect(projection.selectEntries()).toHaveLength(live + archived);
    const reads = vi.spyOn(materialization, "readSessionRowEntry");
    for (const scope of ["catalog", "config", "stores", { agentId: "main" }] as const) {
      const before = projection.materializedCount;
      sessionChanges.emit({ all: true, scope });
      expect(projection.dirtyRowCount).toBe(scope === "catalog" ? live : live + archived);
      await projection.ensureMaterialized();
      expect(projection.materializedCount - before).toBe(live);
      expect(reads.mock.calls.some(([row]) => row.entry?.archivedAt !== undefined)).toBe(false);
      reads.mockClear();
    }
    expect(new Set(placementReads.mock.calls.flatMap(([ids]) => ids))).toEqual(
      new Set(["row-0", "row-1", "row-2"]),
    );
    placementReads.mockClear();
    const page = await listRows(projection, { archived: true, limit: 2 });
    expect(page.sessions).toHaveLength(2);
    for (const row of page.sessions) {
      expect(row.placement).toMatchObject({ state: "requested" });
    }
    expect(new Set(placementReads.mock.calls.flatMap(([ids]) => ids))).toEqual(
      new Set(page.sessions.map((row) => row.sessionId)),
    );
    placementReads.mockClear();
    await listRows(projection, { archived: true, limit: 2 });
    expect(placementReads).not.toHaveBeenCalled();
  });
});

it("reindexes cold lineage when a literal parent appears and disappears", async () => {
  await withSessionRowProjectionState(async (create, state, cleanup) => {
    const sharedConfig = {
      agents: {
        entries: { alpha: {}, main: {} },
        defaults: { sessionStore: { agentId: "alpha" } },
      },
      session: { scope: "global" as const },
    };
    await state.writeConfig(sharedConfig);
    state.applyEnv();
    const parent = "agent:main:main";
    const child = "agent:alpha:dashboard:cold-child";
    const writeParent = (sessionKey: string, model: string) =>
      writeRow(sessionKey, {
        providerOverride: "ollama",
        modelOverride: model,
        modelOverrideSource: "user",
        modelOverrideRouteResolution: "resolved",
      });
    const removeParent = (projection: Projection, key: string) =>
      deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: projection.capture({ agentId: "main", key })!.storeTarget.storePath,
        archiveTranscript: false,
        target: { canonicalKey: key, storeKeys: [key] },
      });
    writeParent("global", "qwen3:8b");
    writeRow(
      child,
      { sessionId: "cold-child", archivedAt: 1, parentSessionKey: parent, spawnedBy: parent },
      "alpha",
    );
    cleanup.defer(retainSessionListForegroundWork());
    const projection = await create({ cfg: sharedConfig, modelCatalog: [] });
    let boardReads: ReturnType<typeof observeSqliteReadSql> | undefined;
    try {
      const initial = projection
        .selectEntries({ parentSessionKey: "global" })
        .find((row) => row.key === child)!;
      expect(initial).toBeDefined();
      expect(ready(initial)).toBe(false);
      boardReads = observeSqliteReadSql(StatementSync.prototype);
      const check = async (literal: boolean) => {
        do {
          await projection.prepareMembership();
        } while (projection.needsMembershipPreparation());
        // Query the parent index first: describing the child would hide a stale cold edge.
        const selected = projection.selectEntries({
          parentSessionKey: literal ? parent : "global",
        });
        const row = selected.find((entry) => entry.key === child);
        expect(row).toMatchObject({
          entry: {
            parentSessionKey: literal ? parent : "global",
            spawnedBy: literal ? parent : "global",
          },
        });
        expect(row?.generation).toBe(initial.generation);
        expect(row?.membership).toBe(initial.membership);
        expect(row?.hasBoard).toBe(initial.hasBoard);
        expect(row?.materialized).toBeUndefined();
        expect(boardReads?.queries.filter((sql) => sql.includes("board_tabs"))).toEqual([]);
        if (literal) {
          expect(
            projection.selectEntries({ parentSessionKey: "global" }).map((entry) => entry.key),
          ).not.toContain(child);
        }
        await projection.ensureMaterialized();
        expect(
          projection.snapshot({ agentId: "main", key: literal ? parent : "global" }).row
            ?.childSessions,
        ).toContain(child);
        if (literal) {
          expect(
            projection.snapshot({ agentId: "main", key: "global" }).row?.childSessions ?? [],
          ).not.toContain(child);
        }
        expect(projection.selectEntries({ key: child })[0]?.materialized).toBeUndefined();
      };
      await check(false);
      writeParent("global", "qwen3:14b");
      await check(false);
      writeParent(parent, "qwen3:32b");
      await check(true);
      await removeParent(projection, parent);
      await check(false);
      const listed = await listRows(projection, { archived: true });
      expect(listed.sessions).toEqual([
        expect.objectContaining({ key: child, model: "qwen3:14b" }),
      ]);
      const scopedChildren = await listRows(projection, {
        agentId: "alpha",
        archived: true,
        spawnedBy: "global",
      });
      expect(scopedChildren.sessions.map((row) => row.key)).toEqual([child]);
      await removeParent(projection, "global");
      for (const sentinel of [parent, "global", "unknown"]) {
        writeRow(
          child,
          { sessionId: "cold-child", archivedAt: 1, parentSessionKey: sentinel },
          "alpha",
        );
        const children = await listRows(projection, {
          agentId: "alpha",
          archived: true,
          spawnedBy: sentinel === parent ? "global" : sentinel,
        });
        expect(children.sessions.map((row) => row.key)).toEqual([child]);
      }
    } finally {
      boardReads?.restore();
    }
  });
});

it("promotes unarchived rows, demotes archived rows, and refreshes only requested archives", async () => {
  await withSessionRowProjectionState(async (create, _, cleanup) => {
    const key = "agent:main:archive-transition";
    const target = { agentId: "main", sessionKey: key };
    const entry = { sessionId: "archive-transition", updatedAt: 1 };
    replaceSessionEntrySync(target, { ...entry, archivedAt: 1 });
    cleanup.defer(retainSessionListForegroundWork());
    const projection = await create({ cfg, modelCatalog: [] });

    sessionChanges.emit(target);
    await projection.ensureMaterialized();
    expect(projection.materializedCount).toBe(0);
    expect((await preparedSnapshot(projection, { agentId: "main", key })).row).toMatchObject({
      key,
      archivedAt: 1,
    });
    expect(projection.materializedCount).toBe(1);
    replaceSessionEntrySync(target, { ...entry, archivedAt: 1, label: "Updated archive" });
    await projection.ensureMaterialized();
    expect(projection.materializedCount).toBe(2);
    expect((await preparedSnapshot(projection, { agentId: "main", key })).row?.label).toBe(
      "Updated archive",
    );

    sessionChanges.emit({ all: true, scope: "catalog" });
    await projection.ensureMaterialized();
    expect(projection.selectEntries().filter(ready)).toHaveLength(0);
    expect(projection.materializedCount).toBe(2);
    const successor = { ...entry, sessionId: "successor" };
    replaceSessionEntrySync(target, { ...successor, label: "Cold update", archivedAt: 1 });
    await projection.ensureMaterialized();
    expect(projection.materializedCount).toBe(2);
    expect(projection.selectEntries()[0]?.entry.label).toBe("Cold update");
    expect(projection.findBySessionId({ sessionId: entry.sessionId })).toEqual([]);
    expect(projection.findBySessionId({ sessionId: successor.sessionId })).toHaveLength(1);

    replaceSessionEntrySync(target, successor);
    await projection.ensureMaterialized();
    expect((await listRows(projection)).sessions[0]?.sessionId).toBe(successor.sessionId);
    expect(projection.selectEntries().filter(ready)).toHaveLength(1);
    expect(projection.materializedCount).toBe(3);
    replaceSessionEntrySync(target, { ...successor, archivedAt: 2 });
    expect(projection.selectEntries().filter(ready)).toHaveLength(0);
    await projection.ensureMaterialized();
    expect(projection.materializedCount).toBe(3);
    expect((await preparedSnapshot(projection, { agentId: "main", key })).row?.archivedAt).toBe(2);
    expect(projection.materializedCount).toBe(4);
  });
});

it("bounds archived residency across pages and evicts the least recently read rows", ({
  signal,
  onTestFinished,
}) => {
  const run = withSessionRowProjectionState(async (create, _, cleanup) => {
    for (let index = 0; index < 128; index++) {
      writeRow(`agent:main:archive-${index}`, {
        sessionId: `archive-${index}`,
        updatedAt: index + 1,
        archivedAt: 1,
      });
    }
    cleanup.defer(yieldSessionListBackgroundWork);
    cleanup.defer(retainSessionListForegroundWork());
    const projection = await create({ cfg, modelCatalog: [] });
    expect(projection.materializedCount).toBe(0);
    const first = await listRows(projection, { archived: true, limit: 80 });
    expect(first).toMatchObject({ count: 80, totalCount: 128, nextOffset: 80 });
    expect(projection.materializedCount).toBe(80);
    const second = await listRows(projection, { archived: true, limit: 80, offset: 80 });
    expect(second).toMatchObject({ count: 48, totalCount: 128, nextOffset: null });
    expect(new Set([...first.sessions, ...second.sessions].map((row) => row.key)).size).toBe(128);
    expect(projection.materializedCount).toBe(128);
    expect(projection.selectEntries().filter(ready)).toHaveLength(100);
    const query = { agentId: "main", key: "agent:main:archive-127" };
    expect(projection.capture(query)?.materialized).toBeUndefined();
    expect((await preparedSnapshot(projection, query)).row?.sessionId).toBe("archive-127");
    expect(projection.materializedCount).toBe(129);
    expect(projection.selectEntries().filter(ready)).toHaveLength(100);
    const pagePrepared = createDeferredCore();
    const releasePage = createDeferredCore();
    const readFacts = databaseFactsRead.withSessionRowDatabaseFacts;
    let wholePagePaused = false;
    const prepare = vi
      .spyOn(databaseFactsRead, "withSessionRowDatabaseFacts")
      .mockImplementation(async (...args) => {
        // Prepared suffixes may finish without another Worker read; pause after either path.
        await readFacts(...args);
        if (!wholePagePaused && projection.selectEntries().filter(ready).length === 128) {
          wholePagePaused = true;
          pagePrepared.resolve();
          await releasePage.promise;
        }
      });
    const pendingPage = listRows(projection, {
      archived: true,
      limit: 128,
      includeLastMessage: true,
    });
    try {
      await waitForPage(pendingPage, pagePrepared, signal);
      await listRows(projection, { archived: true, limit: 1 });
      expect(projection.selectEntries().filter(ready)).toHaveLength(128);
    } finally {
      releasePage.resolve();
      await pendingPage;
      prepare.mockRestore();
    }
    const wholePage = await pendingPage;
    expect(wholePage.sessions).toHaveLength(128);
    expect(projection.selectEntries().filter(ready)).toHaveLength(128);
    await listRows(projection, { archived: true, limit: 1 });
    expect(projection.selectEntries().filter(ready)).toHaveLength(100);

    sessionChanges.emit({ all: true, scope: "catalog" });
    await projection.ensureMaterialized();
    expect(projection.selectEntries().filter(ready)).toHaveLength(0);
    const barriers = [0, 1].map((index) => ({
      keys: wholePage.sessions.slice(index * 64, (index + 1) * 64).map((row) => row.key),
      paused: false,
      prepared: createDeferredCore(),
      resume: createDeferredCore(),
    }));
    const reads = vi
      .spyOn(databaseFactsRead, "withSessionRowDatabaseFacts")
      .mockImplementation(async (...args) => {
        // Prepared suffixes may finish without another Worker read; pause after either path.
        await readFacts(...args);
        const readyKeys = new Set(
          projection
            .selectEntries()
            .filter(ready)
            .map((row) => row.key),
        );
        for (const barrier of barriers) {
          if (!barrier.paused && barrier.keys.every((key) => readyKeys.has(key))) {
            barrier.paused = true;
            barrier.prepared.resolve();
            await barrier.resume.promise;
          }
        }
      });
    const pages: Array<ReturnType<typeof listProjectedSessions>> = [];
    try {
      for (const [index, barrier] of barriers.entries()) {
        const page = listRows(projection, { archived: true, limit: 64, offset: index * 64 });
        pages.push(page);
        await waitForPage(page, barrier.prepared, signal);
      }
      expect(projection.selectEntries().filter(ready)).toHaveLength(128);
    } catch (error) {
      projection.dispose();
      throw error;
    } finally {
      for (const barrier of barriers) {
        barrier.resume.resolve();
      }
      await Promise.allSettled(pages);
      reads.mockRestore();
    }
    const disjoint = await Promise.all(pages);
    expect(disjoint.map((page) => page.sessions.length)).toEqual([64, 64]);
    expect(new Set(disjoint.flatMap((page) => page.sessions.map((row) => row.key))).size).toBe(128);
    expect(projection.selectEntries().filter(ready)).toHaveLength(100);
  });
  // Vitest timeout cancels the waits; retain the fixture until its pages and state finish cleanup.
  onTestFinished(() => run);
  return run;
});

it.each(["catalog", "archive"] as const)(
  "keeps archived display rows cold after %s demotion during backfill",
  async (change) => {
    await withSessionRowProjectionState(async (create, _, cleanup) => {
      const target = { agentId: "main", sessionKey: "agent:main:archived" };
      const query = { agentId: "main", key: target.sessionKey };
      const entry = { sessionId: "archived", updatedAt: 1 };
      const completion = createDeferredCore();
      const backfill = vi
        .spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields")
        .mockImplementation(async (params) => {
          if (params.sessionKey === target.sessionKey) {
            await completion.promise;
          }
          return { lastMessagePreview: "Enriched", fallbackModel: undefined };
        });
      if (change === "catalog") {
        writeRow("agent:main:live", { sessionId: "live" });
      }
      replaceSessionEntrySync(target, {
        ...entry,
        ...(change === "catalog" ? { archivedAt: 1 } : {}),
      });
      const projection = await create({ cfg, modelCatalog: [] });
      cleanup.defer(() => {
        completion.resolve();
        projection.dispose();
      });
      await listRows(projection);
      await vi.waitFor(() => expect(backfill).toHaveBeenCalledTimes(1));
      if (change === "catalog") {
        expect(backfill.mock.calls[0]?.[0].sessionKey).toBe("agent:main:live");
        expect(projection.capture(query)?.materialized).toBeUndefined();
        expect((await preparedSnapshot(projection, query)).row?.sessionId).toBe("archived");
        await vi.waitFor(() => expect(backfill).toHaveBeenCalledTimes(2));
        sessionChanges.emit({ all: true, scope: "catalog" });
      } else {
        replaceSessionEntrySync(target, { ...entry, archivedAt: 1 });
      }
      await projection.ensureMaterialized();
      const before = projection.materializedCount;
      completion.resolve();
      await nextTurn();
      await nextTurn();
      await projection.ensureMaterialized();
      expect(projection.materializedCount).toBe(before);
      expect(projection.capture(query)?.materialized).toBeUndefined();
      expect(projection.capture(query)?.lastMessagePreview).toBeUndefined();
    });
  },
);

it("refreshes archived model facts after catalog renewal", async () => {
  await withSessionRowProjectionState(async (create, _, cleanup) => {
    const key = "agent:main:catalog-archive";
    const catalog = [
      {
        id: "fixture",
        name: "Fixture",
        provider: "unit-test",
        contextWindow: 8192,
        contextTokens: 8192,
      },
    ];
    const loading = createDeferredCore<typeof catalog>();
    let refresh = false;
    writeRow(key, {
      sessionId: "catalog-archive",
      archivedAt: 1,
      providerOverride: "unit-test",
      modelOverride: "fixture",
    });
    writeRow("agent:main:catalog-cold", { sessionId: "catalog-cold", archivedAt: 1 });
    cleanup.defer(retainSessionListForegroundWork());
    const projection = await create({
      cfg,
      modelCatalog: catalog,
      getModelCatalog: () => (refresh ? loading.promise : Promise.resolve(catalog)),
    });
    cleanup.defer(() => {
      loading.resolve(catalog);
      projection.dispose();
    });
    refresh = true;
    sessionChanges.emit({ all: true, scope: "catalog" });
    expect((await preparedSnapshot(projection, { agentId: "main", key })).row?.contextTokens).toBe(
      8192,
    );
    expect(projection.materializedCount).toBe(1);
    loading.resolve([{ ...catalog[0]!, contextWindow: 16384, contextTokens: 16384 }]);
    await loading.promise;
    expect(projection.dirtyRowCount).toBe(0);
    expect(projection.selectEntries()).toHaveLength(2);
    await projection.ensureMaterialized();
    expect(projection.materializedCount).toBe(1);
    expect((await preparedSnapshot(projection, { agentId: "main", key })).row?.contextTokens).toBe(
      16384,
    );
    expect(projection.materializedCount).toBe(2);
  });
});

function seedPublication(sessionId: string, entry: Partial<SessionEntry> = {}) {
  const scope = { agentId: "main", sessionKey: `agent:main:${sessionId}` };
  replaceSessionEntrySync(scope, { sessionId, updatedAt: 1, ...entry });
  return { scope, query: { agentId: scope.agentId, key: scope.sessionKey } };
}

function cachedEntry(database: ReturnType<typeof openOpenClawAgentDatabase>, key: string) {
  return readCommittedSessionEntryCache(requireNativeSqliteDatabase(database.db))?.get(key);
}

it.each(["native", "worker"] as const)(
  "retains assigned owner and participants before observers after a %s metadata write",
  async (writer) => {
    await withSessionRowProjectionState(async (create, _, cleanup) => {
      const creator = ensureProfileForEmail("creator@example.com");
      const owner = ensureProfileForEmail("owner@example.com");
      const participant = ensureProfileForEmail("participant@example.com");
      const scope = { agentId: "main", sessionKey: "agent:main:publication-side-metadata" };
      const original: SessionEntry = {
        sessionId: "publication-side-metadata",
        updatedAt: 1,
        label: "Original label",
        createdActor: { type: "human", source: "profile", id: creator.id },
      };
      replaceSessionEntrySync(scope, original);
      const assignment = {
        actor: { type: "human" as const, id: owner.id },
        assignedBy: { type: "human" as const, id: creator.id },
        assignedAt: 1,
      };
      expect(
        assignSessionOwner(scope, {
          owner: assignment.actor,
          assignedBy: assignment.assignedBy,
          assignedAt: assignment.assignedAt,
        }),
      ).toEqual(assignment);
      recordSessionParticipant(scope, {
        identity: { type: "profile", id: participant.id },
        promptedAt: 1,
      });
      cleanup.defer(retainSessionListForegroundWork());
      const projection = await create({ cfg, modelCatalog: [] });
      const query = { agentId: scope.agentId, key: scope.sessionKey };
      let stop = () => {};
      cleanup.defer(async () => {
        stop();
        await projection.ensureMaterialized();
        projection.dispose();
      });
      await listProjectedSessions({ projection, opts: { includePeople: true } });
      const sideMetadata = {
        owner: assignment,
        participants: [{ identity: { type: "profile", id: participant.id } }],
        participantCount: 1,
      };
      const warm = projection.capture(query);
      expect(warm?.entry).toMatchObject(sideMetadata);
      expect(warm?.storedEntry).toMatchObject(sideMetadata);
      const reads = vi.spyOn(materialization, "readSessionRowEntry");
      const rowReads = vi.spyOn(history, "withSessionHistoryWorkerDatabases");
      const sharedReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      const observed: Array<{
        entry: SessionEntry | undefined;
        storedEntry: SessionEntry | undefined;
      }> = [];
      stop = sessionChanges.subscribe((change) => {
        if (!("sessionKey" in change) || change.sessionKey !== scope.sessionKey) {
          return;
        }
        const row = projection.capture(query);
        // Snapshot before any asynchronous refill can repair a partial publication.
        observed.push(structuredClone({ entry: row?.entry, storedEntry: row?.storedEntry }));
      });
      const updated = { ...original, label: "Updated label", updatedAt: 2 };
      if (writer === "native") {
        replaceSessionEntrySync(scope, updated);
      } else {
        await applySessionEntryExactReplacements({
          agentId: scope.agentId,
          storePath: warm!.storeTarget.storePath,
          sessionKeys: [scope.sessionKey],
          update: ([row]) => ({
            result: undefined,
            replacements: [{ sessionKey: scope.sessionKey, entry: { ...row!.entry, ...updated } }],
          }),
        });
      }
      const expected = { ...updated, ...sideMetadata };
      expect(observed).toEqual([
        {
          entry: expect.objectContaining(expected),
          storedEntry: expect.objectContaining(expected),
        },
      ]);
      expect(reads).not.toHaveBeenCalled();
      await projection.ensureMaterialized();
      expect(projection.snapshot(query).row?.label).toBe("Updated label");
      expect(rowReads).not.toHaveBeenCalled();
      expect(
        sharedReads.mock.calls.filter(([, command]) => command.type === "sessionRows.sharedFacts"),
      ).toEqual([]);
      const publishedSource = projection.capture(query)?.publishedSource;
      expect(publishedSource).toBeDefined();
      const expectPublished = () => {
        expect(projection.sharingTarget(query)?.entry).toMatchObject(expected);
        expect(projection.capture(query)?.publishedSource).toBe(publishedSource);
      };
      const sql = observeHostDataSql();
      try {
        sessionChanges.emit({ agentId: scope.agentId, sessionKey: scope.sessionKey });
        expect(projection.dirtyRowCount).toBeGreaterThan(0);
        expectPublished();
        sessionChanges.emit({
          ...scope,
          storePath: warm!.storeTarget.storePath,
          facts: { kind: "unchanged" },
        });
        expectPublished();
        // Participant persistence already published its compact facts before this notice.
        emitSessionLifecycleEvent({
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          reason: "participants",
          scope: "session-entry",
        });
        expectPublished();
        // Unknown storage changes still revoke compact facts until an exact refresh.
        sessionChanges.emit({ ...scope, storePath: warm!.storeTarget.storePath });
        expect(projection.sharingTarget(query)).toBeNull();
        expect(projection.capture(query)?.publishedSource).toBeUndefined();
        expect(() => projection.selectEntries(query)).toThrow(SessionRowFactsPending);
        const refreshed = await listRows(projection, { includePeople: true });
        expect(refreshed.sessions.find((row) => row.key === scope.sessionKey)?.label).toBe(
          "Updated label",
        );
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    });
  },
);

it("accepts alias publications while another physical store keeps its own row", async () => {
  await withSessionRowProjectionState(async (create, state) => {
    const globalConfig = {
      agents: { entries: { main: {} } },
      session: { scope: "global" as const },
    };
    const query = {
      agentId: "main",
      key: "global",
      storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
    };
    const otherPath = state.statePath("secondary.sqlite");
    const entry = { sessionId: "shared-id", lifecycleRevision: "original", updatedAt: 1 };
    for (const storePath of [query.storePath, otherPath]) {
      replaceSessionEntrySync({ agentId: query.agentId, sessionKey: query.key, storePath }, entry);
      registerOpenClawAgentDatabase({ agentId: query.agentId, path: storePath });
    }
    const aliasDirectory = state.path("publication-alias");
    symlinkSync(
      path.dirname(query.storePath),
      aliasDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const alias = path.join(aliasDirectory, path.basename(query.storePath));
    openOpenClawAgentDatabase({ agentId: query.agentId, path: alias });
    registerOpenClawAgentDatabase({ agentId: query.agentId, path: alias });
    const projection = await create({ cfg: globalConfig, modelCatalog: [] });

    await projection.ensureMaterialized();
    const captured = projection.capture(query);
    expect(captured).toBeDefined();
    const physicalPaths = projection.physicalPaths(query.storePath, query.agentId);
    expect(physicalPaths).toEqual([captured!.storeTarget.storePath]);
    expect(projection.physicalPaths(otherPath, query.agentId)).not.toEqual(physicalPaths);
    expect(projection.physicalPaths(query.storePath, query.agentId)).toBe(physicalPaths);
    replaceSessionEntrySync(
      { agentId: query.agentId, sessionKey: query.key, storePath: otherPath },
      {
        ...entry,
        lifecycleRevision: "other-store-reset",
        updatedAt: 2,
      },
    );
    expect(projection.isCurrent(captured!)).toBe(true);
    await projection.ensureMaterialized();
    expect(projection.describe(query, captured)?.entry.lifecycleRevision).toBe("original");
    expect(projection.describe({ ...query, storePath: otherPath })?.entry.lifecycleRevision).toBe(
      "other-store-reset",
    );

    replaceSessionEntrySync(
      { agentId: query.agentId, sessionKey: query.key, storePath: alias },
      { ...entry, updatedAt: 3, label: "Alias publication" },
    );
    // Observe the committed postimage before any asynchronous row refill.
    expect(projection.capture(query)?.entry?.label).toBe("Alias publication");
    expect(projection.capture(query)?.publishedSource?.canonicalPath).toBe(query.storePath);
    expect(projection.describe({ ...query, storePath: otherPath })?.entry.lifecycleRevision).toBe(
      "other-store-reset",
    );
    await projection.ensureMaterialized();
    sessionChanges.emit({ all: true, scope: "stores" });
    await projection.prepareMembership();
    expect(projection.physicalPaths(query.storePath, query.agentId)).toEqual(physicalPaths);
    expect(projection.physicalPaths(query.storePath, query.agentId)).not.toBe(physicalPaths);
  });
});

it("retains newer cached native metadata through reentrant identity publication", async () => {
  await withSessionRowProjectionState(async (create, _, cleanup) => {
    const updatedAt = Date.now();
    const { scope, query } = seedPublication("identity-publication-reentry", {
      sessionId: "original",
      updatedAt,
    });
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    readSessionEntryCache(database, { cache: true });
    const projection = await create({ cfg, modelCatalog: [] });
    const list = () => listRows(projection);
    let stopRows = () => {};
    cleanup.defer(async () => {
      stopRows();
      await projection.ensureMaterialized();
      projection.dispose();
    });
    await list();
    expect(Boolean(readCommittedSessionEntryCache(requireNativeSqliteDatabase(database.db)))).toBe(
      true,
    );
    const originalGeneration = projection.capture(query)?.generation;
    expect(originalGeneration).toBeDefined();
    const newer = { sessionId: "replacement", updatedAt: updatedAt + 1, label: "Newer label" };
    let reentered = false;
    const callbackErrors: unknown[] = [];
    stopRows = sessionChanges.subscribe((change) => {
      if (reentered || !("sessionKey" in change) || change.sessionKey !== scope.sessionKey) {
        return;
      }
      reentered = true;
      try {
        replaceSessionEntrySync(scope, newer);
      } catch (error) {
        callbackErrors.push(error);
      }
    });
    replaceSessionEntrySync(scope, { ...newer, label: "Older label" });
    expect(reentered).toBe(true);
    expect(callbackErrors).toEqual([]);
    expect(loadSessionEntry(scope)?.label).toBe(newer.label);
    const current = projection.capture(query);
    expect(current).toBeDefined();
    expect(current?.generation).not.toBe(originalGeneration);
    expect(current?.entry).toMatchObject({ sessionId: newer.sessionId, label: newer.label });
    expect((await list()).sessions).toEqual([
      expect.objectContaining({
        key: scope.sessionKey,
        sessionId: newer.sessionId,
        label: newer.label,
      }),
    ]);
  });
});

it("publishes maintenance removals before row listeners recreate the key", async () => {
  await withSessionRowProjectionState(async (create, state, cleanup) => {
    const { scope } = seedPublication("publication-reentry", {
      sessionId: "removed",
      updatedAt: Date.now(),
    });
    const databaseOptions = { agentId: "main", env: state.env };
    const database = openOpenClawAgentDatabase(databaseOptions);
    readSessionEntryCache(database, { cache: true });
    const projection = await create({ cfg, modelCatalog: [] });
    await listRows(projection);
    const entries = [{ sessionKey: scope.sessionKey, expectedEntry: loadSessionEntry(scope) }];
    const params = { agentId: "main", databaseOptions, entries, materializedPlans: [] };
    const plan = createSessionMaintenanceFinalizationOperation(params);
    const identities: string[] = [];
    const removalState: Array<{ cachedId?: string; storedId?: string }> = [];
    const callbackErrors: unknown[] = [];
    const stopIdentity = onSessionIdentityMutation((event) => {
      try {
        if (event.kind === "delete" && event.previous.sessionKeys.includes(scope.sessionKey)) {
          identities.push(`delete:${event.previous.sessionId}`);
          removalState.push({
            cachedId: cachedEntry(database, scope.sessionKey)?.sessionId,
            storedId: loadSessionEntry(scope)?.sessionId,
          });
        } else if (
          event.kind === "create" &&
          event.current.sessionKeys.includes(scope.sessionKey)
        ) {
          identities.push(`create:${event.current.sessionId}`);
        }
      } catch (error) {
        callbackErrors.push(error);
      }
    });
    let recreated = false;
    const stopRows = sessionChanges.subscribe((change) => {
      if (
        recreated ||
        !("sessionKey" in change) ||
        change.sessionKey !== scope.sessionKey ||
        change.storePath !== database.path
      ) {
        return;
      }
      recreated = true;
      try {
        replaceSessionEntrySync(scope, {
          sessionId: "replacement",
          updatedAt: Date.now(),
          label: "Replacement survives publication",
        });
      } catch (error) {
        callbackErrors.push(error);
      }
    });
    const diagnostics = {};
    cleanup.defer(async () => {
      stopRows();
      stopIdentity();
      await projection.ensureMaterialized();
      projection.dispose();
    });
    expect(cachedEntry(database, scope.sessionKey)?.sessionId).toBe("removed");
    await runSqliteSessionReclamation({ plan, diagnostics });
    expect(diagnostics).toMatchObject({ workerThreadId: expect.any(Number) });
    expect(callbackErrors).toEqual([]);
    expect(identities).toEqual(["delete:removed", "create:replacement"]);
    expect(removalState).toEqual([{ cachedId: undefined, storedId: undefined }]);
    expect(loadSessionEntry(scope)?.sessionId).toBe("replacement");
    const result = await listRows(projection);
    expect(result.sessions).toEqual([
      expect.objectContaining({
        key: scope.sessionKey,
        sessionId: "replacement",
        label: "Replacement survives publication",
      }),
    ]);
  });
});

it("retains compaction display facts until a branch change requires a new tail", async ({
  signal,
}) => {
  await withSessionRowProjectionState(async (create) => {
    setRuntimeConfigSnapshot(cfg);
    const scope = {
      agentId: "main",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      sessionKey: "agent:main:compaction-display",
      sessionId: "compaction-display",
    };
    const query = { agentId: scope.agentId, key: scope.sessionKey };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const message = (text: string, timestamp: number) =>
      makeAgentAssistantMessage({
        content: [{ type: "text", text }],
        timestamp,
      });
    const manager = await SessionManager.openAsync(scope);
    const keptId = await manager.appendMessageAsync({
      role: "user",
      content: "Keep this request",
      timestamp: 1,
    });
    expect(keptId).toBeTypeOf("string");
    await manager.appendMessageAsync(message("Keep this reply", 2));
    const projection = await create({ cfg, modelCatalog: [] });
    const displayRow = () => projection.snapshot(query, { includeLastMessage: true }).row;
    const expectReply = (text: string, fields = {}) =>
      expect(displayRow()).toMatchObject({
        lastMessagePreview: text,
        lastAssistantMessage: { text },
        ...fields,
      });
    await projection.ensureMaterialized();
    expectReply("Keep this reply");
    const reads: string[] = [];
    watchRowFacts((owner) => (input) => {
      reads.push(...input.sessionKeys);
      return owner.readRowFacts(input);
    });
    const backfill = vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields");

    const compact = () =>
      withSessionCompactionPersistenceAsync(
        manager,
        (prepared) =>
          persistCompactionBoundaryWithSessionEntryAsync(scope, {
            prepared,
            tokensAfter: 45,
            transcriptByteCompactionLatch: null,
          }),
        () => manager.appendCompactionAsync("Earlier context summary", keptId!, 100),
      );
    await compact();
    await projection.ensureMaterialized();
    await nextTurn();
    expectReply("Keep this reply", { totalTokens: 45 });
    expect(projection.capture(query)?.entry?.compactionCount).toBe(1);
    expect(reads).toEqual([]);
    expect(backfill).not.toHaveBeenCalled();

    await manager.appendMessageAsync(message("New reply", 3));
    await compact();
    await projection.ensureMaterialized();
    await nextTurn();
    expectReply("New reply");
    expect(reads).toEqual([]);
    expect(backfill).not.toHaveBeenCalled();

    await manager.branchAsync(keptId!);
    const changedBranch = observeSessionRowBackfill([scope.sessionKey], projection, (row) =>
      row.lastMessagePreview === "Keep this request" && !row.lastAssistantMessage ? row.key : "",
    );
    await compact();
    await projection.ensureMaterialized();
    await withinTest(changedBranch, signal);
    expect(displayRow()).toMatchObject({ lastMessagePreview: "Keep this request" });
    expect(displayRow()?.lastAssistantMessage).toBeUndefined();
    expect(backfill).toHaveBeenCalled();
  });
});
