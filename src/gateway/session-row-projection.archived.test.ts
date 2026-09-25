import { StatementSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  canRunSessionListBackgroundWork,
  retainSessionListForegroundWork,
} from "./session-projection-work.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import * as materialization from "./session-row-projection-materialize.js";
import * as databaseFactsRead from "./session-row-projection-read.js";
import * as records from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";
import { listProjectedSessions } from "./session-utils-list.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

afterEach(() => vi.restoreAllMocks());

const { ready } = records;

type Projection = Awaited<ReturnType<typeof createSessionRowProjection>>;
type SnapshotQuery = Parameters<Projection["snapshot"]>[0];

function preparedSnapshot(projection: Projection, query: SnapshotQuery) {
  return withReadySessionRows(
    projection,
    () => [query],
    () => projection.snapshot(query),
  );
}

it("keeps archived rows cold at hydration and across broad refreshes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const live = 3;
    const archived = 8;
    const placements = createWorkerSessionPlacementStore();
    for (let index = 0; index < live + archived; index++) {
      placements.startDispatch({
        agentId: "main",
        sessionKey: `agent:main:row-${index}`,
        sessionId: `row-${index}`,
      });
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:row-${index}` },
        {
          sessionId: `row-${index}`,
          updatedAt: index + 1,
          ...(index >= live ? { archivedAt: 1 } : {}),
        },
      );
    }
    const release = retainSessionListForegroundWork();
    const placementReads = vi.spyOn(placements, "readProjection");
    const projection = await createSessionRowProjection({
      cfg,
      modelCatalog: [],
      placementFactsReader: placements,
    });
    try {
      await projection.ensureMaterialized();
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
      const page = await listProjectedSessions({ projection, opts: { archived: true, limit: 2 } });
      expect(page.sessions).toHaveLength(2);
      for (const row of page.sessions) {
        expect(row.placement).toMatchObject({ state: "requested" });
      }
      expect(new Set(placementReads.mock.calls.flatMap(([ids]) => ids))).toEqual(
        new Set(page.sessions.map((row) => row.sessionId)),
      );
      placementReads.mockClear();
      await listProjectedSessions({ projection, opts: { archived: true, limit: 2 } });
      expect(placementReads).not.toHaveBeenCalled();
    } finally {
      projection.dispose();
      release();
    }
  });
});

it("reindexes cold lineage when a literal parent appears and disappears", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {
      agents: { entries: { alpha: { default: true }, main: {} } },
      session: { scope: "global" as const },
    };
    await state.writeConfig(cfg);
    state.applyEnv();
    const parent = "agent:main:main";
    const child = "agent:alpha:dashboard:cold-child";
    const writeParent = (sessionKey: string, model: string) =>
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        {
          sessionId: sessionKey,
          updatedAt: 1,
          providerOverride: "ollama",
          modelOverride: model,
          modelOverrideSource: "user",
          modelOverrideRouteResolution: "resolved",
        },
      );
    writeParent("global", "qwen3:8b");
    replaceSessionEntrySync(
      { agentId: "alpha", sessionKey: child },
      {
        sessionId: "cold-child",
        updatedAt: 1,
        status: "running",
        archivedAt: 1,
        parentSessionKey: parent,
        spawnedBy: parent,
      },
    );
    const release = retainSessionListForegroundWork();
    let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
    let boardReads: ReturnType<typeof observeSqliteReadSql> | undefined;
    try {
      projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const initial = projection
        .selectEntries({ parentSessionKey: "global" })
        .find((row) => row.key === child)!;
      expect(initial).toBeDefined();
      expect(ready(initial)).toBe(false);
      boardReads = observeSqliteReadSql(StatementSync.prototype);
      const check = async (literal: boolean) => {
        if (!projection) {
          throw new Error("Expected a live projection");
        }
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
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: projection.capture({ agentId: "main", key: parent })!.storeTarget.storePath,
        archiveTranscript: false,
        target: { canonicalKey: parent, storeKeys: [parent] },
      });
      await check(false);
      const listed = await listProjectedSessions({ projection, opts: { archived: true } });
      expect(listed.sessions).toEqual([
        expect.objectContaining({ key: child, model: "qwen3:14b" }),
      ]);
    } finally {
      boardReads?.restore();
      projection?.dispose();
      release();
    }
  });
});

it("promotes unarchived rows, demotes archived rows, and refreshes only requested archives", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const key = "agent:main:archive-transition";
    const target = { agentId: "main", sessionKey: key };
    const entry = { sessionId: "archive-transition", updatedAt: 1 };
    replaceSessionEntrySync(target, { ...entry, archivedAt: 1 });
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
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
      replaceSessionEntrySync(target, { ...entry, label: "Cold update", archivedAt: 1 });
      await projection.ensureMaterialized();
      expect(projection.materializedCount).toBe(2);
      expect(projection.selectEntries()[0]?.entry.label).toBe("Cold update");

      replaceSessionEntrySync(target, entry);
      await projection.ensureMaterialized();
      expect(projection.selectEntries().filter(ready)).toHaveLength(1);
      expect(projection.materializedCount).toBe(3);
      replaceSessionEntrySync(target, { ...entry, archivedAt: 2 });
      expect(projection.selectEntries().filter(ready)).toHaveLength(0);
      await projection.ensureMaterialized();
      expect(projection.materializedCount).toBe(3);
      expect((await preparedSnapshot(projection, { agentId: "main", key })).row?.archivedAt).toBe(
        2,
      );
      expect(projection.materializedCount).toBe(4);
    } finally {
      projection.dispose();
      release();
    }
  });
});

it("bounds archived residency across pages and evicts the least recently read rows", ({
  signal,
  onTestFinished,
}) => {
  const run = withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    for (let index = 0; index < 128; index++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:archive-${index}` },
        { sessionId: `archive-${index}`, updatedAt: index + 1, archivedAt: 1 },
      );
    }
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      expect(projection.materializedCount).toBe(0);
      const first = await listProjectedSessions({
        projection,
        opts: { archived: true, limit: 80 },
      });
      expect(first).toMatchObject({ count: 80, totalCount: 128, nextOffset: 80 });
      expect(projection.materializedCount).toBe(80);
      const second = await listProjectedSessions({
        projection,
        opts: { archived: true, limit: 80, offset: 80 },
      });
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
      const pendingPage = listProjectedSessions({
        projection,
        opts: { archived: true, limit: 128, includeLastMessage: true },
      });
      const abortPage = () => pagePrepared.reject(signal.reason);
      try {
        signal.addEventListener("abort", abortPage, { once: true });
        signal.throwIfAborted();
        void pendingPage.then(
          () =>
            pagePrepared.reject(new Error("Archive page settled before its preparation barrier")),
          pagePrepared.reject,
        );
        await pagePrepared.promise;
        await listProjectedSessions({ projection, opts: { archived: true, limit: 1 } });
        expect(projection.selectEntries().filter(ready)).toHaveLength(128);
      } finally {
        signal.removeEventListener("abort", abortPage);
        releasePage.resolve();
        await pendingPage;
        prepare.mockRestore();
      }
      const wholePage = await pendingPage;
      expect(wholePage.sessions).toHaveLength(128);
      expect(projection.selectEntries().filter(ready)).toHaveLength(128);
      await listProjectedSessions({ projection, opts: { archived: true, limit: 1 } });
      expect(projection.selectEntries().filter(ready)).toHaveLength(100);

      sessionChanges.emit({ all: true, scope: "catalog" });
      await projection.ensureMaterialized();
      expect(projection.selectEntries().filter(ready)).toHaveLength(0);
      const barriers = Array.from({ length: 2 }, (_, index) => ({
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
          const page = listProjectedSessions({
            projection,
            opts: { archived: true, limit: 64, offset: index * 64 },
          });
          pages.push(page);
          const abortDisjointPage = () => barrier.prepared.reject(signal.reason);
          try {
            signal.addEventListener("abort", abortDisjointPage, { once: true });
            signal.throwIfAborted();
            void page.then(
              () =>
                barrier.prepared.reject(
                  new Error("Archive page settled before its preparation barrier"),
                ),
              barrier.prepared.reject,
            );
            await barrier.prepared.promise;
          } finally {
            signal.removeEventListener("abort", abortDisjointPage);
          }
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
      expect(new Set(disjoint.flatMap((page) => page.sessions.map((row) => row.key))).size).toBe(
        128,
      );
      expect(projection.selectEntries().filter(ready)).toHaveLength(100);
    } finally {
      projection.dispose();
      release();
      expect(canRunSessionListBackgroundWork()).toBe(true);
    }
  });
  // Vitest timeout cancels the waits; retain the fixture until its pages and state finish cleanup.
  onTestFinished(() => run);
  return run;
});

it("backfills only requested archives and discards enrichment after demotion", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const completion = createDeferredCore();
    const backfill = vi
      .spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields")
      .mockImplementation(async (params) => {
        if (params.sessionKey === "agent:main:archived") {
          await completion.promise;
        }
        return { lastMessagePreview: "Enriched", fallbackModel: undefined };
      });
    for (const name of ["live", "archived"]) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:${name}` },
        { sessionId: name, updatedAt: 1, ...(name === "archived" ? { archivedAt: 1 } : {}) },
      );
    }
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      await vi.waitFor(() => expect(backfill).toHaveBeenCalledTimes(1));
      expect(backfill.mock.calls[0]?.[0].sessionKey).toBe("agent:main:live");
      const query = { agentId: "main", key: "agent:main:archived" };
      expect(projection.capture(query)?.materialized).toBeUndefined();
      expect((await preparedSnapshot(projection, query)).row?.sessionId).toBe("archived");
      await vi.waitFor(() => expect(backfill).toHaveBeenCalledTimes(2));
      sessionChanges.emit({ all: true, scope: "catalog" });
      await projection.ensureMaterialized();
      const before = projection.materializedCount;
      completion.resolve();
      await nextTurn();
      await nextTurn();
      await projection.ensureMaterialized();
      expect(projection.materializedCount).toBe(before);
      expect(projection.capture(query)?.materialized).toBeUndefined();
      expect(projection.capture(query)?.lastMessagePreview).toBeUndefined();
    } finally {
      completion.resolve();
      projection.dispose();
    }
  });
});

it("refreshes cold metadata and promotes unarchived rows through committed keyed publications", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const target = { agentId: "main", sessionKey: "agent:main:broad-archive" };
    replaceSessionEntrySync(target, { sessionId: "before", updatedAt: 1, archivedAt: 1 });
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      replaceSessionEntrySync(target, { sessionId: "after", updatedAt: 2, archivedAt: 1 });
      await projection.ensureMaterialized();
      expect(projection.materializedCount).toBe(0);
      expect(projection.findBySessionId({ sessionId: "before" })).toEqual([]);
      expect(projection.findBySessionId({ sessionId: "after" })).toHaveLength(1);
      replaceSessionEntrySync(target, { sessionId: "after", updatedAt: 3 });
      await projection.ensureMaterialized();
      expect(projection.materializedCount).toBe(1);
      expect((await listProjectedSessions({ projection, opts: {} })).sessions[0]?.sessionId).toBe(
        "after",
      );
    } finally {
      projection.dispose();
      release();
    }
  });
});

it("expires archives read while a newer catalog is still loading", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
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
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        sessionId: "catalog-archive",
        updatedAt: 1,
        archivedAt: 1,
        providerOverride: "unit-test",
        modelOverride: "fixture",
      },
    );
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:catalog-cold" },
      { sessionId: "catalog-cold", updatedAt: 1, archivedAt: 1 },
    );
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({
      cfg,
      modelCatalog: catalog,
      getModelCatalog: () => (refresh ? loading.promise : Promise.resolve(catalog)),
    });
    try {
      refresh = true;
      sessionChanges.emit({ all: true, scope: "catalog" });
      expect(
        (await preparedSnapshot(projection, { agentId: "main", key })).row?.contextTokens,
      ).toBe(8192);
      expect(projection.materializedCount).toBe(1);
      loading.resolve([{ ...catalog[0]!, contextWindow: 16384, contextTokens: 16384 }]);
      await loading.promise;
      expect(projection.dirtyRowCount).toBe(0);
      expect(projection.selectEntries()).toHaveLength(2);
      expect(projection.selectEntries().filter(ready)).toHaveLength(0);
      await projection.ensureMaterialized();
      expect(projection.materializedCount).toBe(1);
      expect(
        (await preparedSnapshot(projection, { agentId: "main", key })).row?.contextTokens,
      ).toBe(16384);
      expect(projection.materializedCount).toBe(2);
    } finally {
      loading.resolve(catalog);
      projection.dispose();
      release();
    }
  });
});

it("withdraws in-flight live backfill authority when its row is archived", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const completion = createDeferredCore();
    const backfill = vi
      .spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields")
      .mockImplementation(async () => {
        await completion.promise;
        return { lastMessagePreview: "Enriched", fallbackModel: undefined };
      });
    const target = { agentId: "main", sessionKey: "agent:main:backfill-archive" };
    const entry = { sessionId: "backfill-archive", updatedAt: 1 };
    replaceSessionEntrySync(target, entry);
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      await vi.waitFor(() => expect(backfill).toHaveBeenCalledTimes(1));
      replaceSessionEntrySync(target, { ...entry, archivedAt: 1 });
      expect(backfill.mock.calls[0]?.[0].shouldCommit?.()).toBe(false);
    } finally {
      completion.resolve();
      projection.dispose();
    }
  });
});

it("discards backfill superseded by a same-lifecycle publication after rematerialization", ({
  signal,
  onTestFinished,
}) => {
  const run = withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const target = { agentId: "main", sessionKey: "agent:main:backfill-successor" };
    const query = { agentId: "main", key: target.sessionKey };
    const entry = {
      sessionId: "backfill-successor",
      lifecycleRevision: "original",
      updatedAt: 1,
    };
    const reads = ["Superseded preview", "Current preview"].map((preview) => ({
      preview,
      started: createDeferredCore(),
      release: createDeferredCore(),
    }));
    const published = createDeferredCore();
    const aborted = createDeferredCore();
    const abort = () => aborted.reject(signal.reason);
    const wait = (promise: Promise<void>) => Promise.race([promise, aborted.promise]);
    let readIndex = 0;
    vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields").mockImplementation(
      async () => {
        const read = reads[readIndex++];
        if (!read) {
          throw new Error("Unexpected backfill read");
        }
        read.started.resolve();
        await read.release.promise;
        return { lastMessagePreview: read.preview, fallbackModel: undefined };
      },
    );
    const publishTranscriptFields = records.publishTranscriptFields;
    const publish = vi.spyOn(records, "publishTranscriptFields").mockImplementation((...args) => {
      const changed = publishTranscriptFields(...args);
      published.resolve();
      return changed;
    });
    replaceSessionEntrySync(target, entry);
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await wait(reads[0]!.started.promise);
      const previous = projection.capture(query)!;
      const materialized = previous.materialized;
      replaceSessionEntrySync(target, { ...entry, updatedAt: 2, label: "Updated metadata" });
      await projection.ensureMaterialized();
      const current = projection.capture(query)!;
      expect(current.generation).toBe(previous.generation);
      expect(current.materialized).not.toBe(materialized);
      expect(current.entry).toMatchObject({ ...entry, updatedAt: 2, label: "Updated metadata" });
      expect(ready(current)).toBe(true);

      reads[0]!.release.resolve();
      // The successor can start only after the previous read's publication decision.
      await wait(reads[1]!.started.promise);
      expect(publish).not.toHaveBeenCalled();
      expect(
        projection.snapshot(query, { includeLastMessage: true }).row?.lastMessagePreview,
      ).toBeUndefined();

      reads[1]!.release.resolve();
      await wait(published.promise);
      expect(projection.snapshot(query, { includeLastMessage: true }).row?.lastMessagePreview).toBe(
        "Current preview",
      );
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      signal.removeEventListener("abort", abort);
      projection.dispose();
      for (const read of reads) {
        read.release.resolve();
      }
    }
  });
  onTestFinished(() => run);
  return run;
});
