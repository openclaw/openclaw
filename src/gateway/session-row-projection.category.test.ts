import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "../config/sessions/session-transcript-worker.types.js";
import { DEFAULT_WORKER_PENDING_TASKS } from "../infra/worker-task-capacity.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { SessionRowFactsPending, withReadySessionRows } from "./session-row-prepared-read.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

// Hold GatewayScheduler timeouts so WAL maintenance stays outside the request SQL budget.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const cfg = { agents: { entries: { main: {} } } };

function observeRowFacts(
  wrap: (
    owner: history.SessionHistoryWorkerDatabase,
  ) => history.SessionHistoryWorkerDatabase["readRowFacts"],
) {
  const readDatabases = history.withSessionHistoryWorkerDatabases;
  vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
    (databases, consume, lane) =>
      readDatabases(
        databases,
        (owners) => consume(owners.map((owner) => ({ ...owner, readRowFacts: wrap(owner) }))),
        lane,
      ),
  );
}

it.for(["search", "full"] as const)(
  "prepares evicted category facts through %s reads",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const queries = Array.from({ length: 101 }, (_, index) => ({
        agentId: "main",
        key: `agent:main:cold-category-${index}`,
      }));
      const oldest = queries[0]!;
      for (const query of queries) {
        replaceSessionEntrySync(
          { agentId: query.agentId, sessionKey: query.key },
          {
            sessionId: query.key,
            updatedAt: 1,
            archivedAt: 1,
            category: "Work",
            ...(query === oldest ? { label: "Cold category target" } : {}),
          },
        );
      }
      const release = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] }).catch(
        (error: unknown) => {
          release();
          throw error;
        },
      );
      let sql: ReturnType<typeof observeHostDataSql> | undefined;
      try {
        projection.setArchivePageSize(101);
        await withReadySessionRows(
          projection,
          () => queries,
          (read) => {
            // Establish access order after the concurrent worker batches have finished.
            for (const query of queries) {
              expect(read.describe(query)?.entry.category).toBe("Work");
            }
          },
        );
        const materialized = projection.materializedCount;
        expect(materialized).toBe(101);
        const reads: string[][] = [];
        observeRowFacts((owner) => async (input) => {
          reads.push([...input.sessionKeys]);
          return owner.readRowFacts(input);
        });
        sql = observeHostDataSql();
        const prepare = async () => {
          sessionChanges.emit({ sessionKey: oldest.key, factsInvalidated: "category" });
          projection.setArchivePageSize(100);
          expect(projection.capture(oldest)?.materialized).toBeUndefined();
          expect(projection.sharingTargetState(oldest)).toEqual({ status: "pending" });
          expect.soft(projection.dirtyRowCount).toBe(1);
          expect.soft(projection.needsSelectionPreparation()).toBe(true);
          if (mode === "search") {
            const result = await listProjectedSessions({
              projection,
              opts: { archived: "all", search: "Cold category target", limit: 1 },
            });
            expect(result.sessions.map(({ key }) => key)).toEqual([oldest.key]);
          } else {
            await projection.ensureMaterialized();
          }
          expect(projection.sharingTargetState(oldest)).toMatchObject({ status: "ready" });
          expect(projection.sharingTarget(oldest)?.entry.category).toBe("Work");
          expect(projection.materializedCount - materialized).toBe(mode === "search" ? 1 : 0);
        };
        if (mode === "search") {
          await projection.withSelectionPreparation(prepare);
        } else {
          await prepare();
        }
        expect(reads.flat()).toContain(oldest.key);
        expect(reads.every((keys) => keys.length <= MAX_SESSION_ROW_FACTS_KEYS)).toBe(true);
        expect(sql.queries).toEqual([]);
      } finally {
        await projection.ensureMaterialized().catch(() => undefined);
        sql?.restore();
        projection.dispose();
        release();
      }
    });
  },
);

it("reconciles more category rows than exact admission permits and survives archive eviction", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const count = DEFAULT_WORKER_PENDING_TASKS * MAX_SESSION_ROW_FACTS_KEYS + 1;
    const queries = Array.from({ length: count }, (_, index) => ({
      agentId: "main",
      key: `agent:main:category-archive-${index}`,
    }));
    for (const query of queries) {
      replaceSessionEntrySync(
        { agentId: query.agentId, sessionKey: query.key },
        { sessionId: query.key, updatedAt: 1, archivedAt: 1, category: "Work" },
      );
    }
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] }).catch(
      (error: unknown) => {
        release();
        throw error;
      },
    );
    let sql: ReturnType<typeof observeHostDataSql> | undefined;
    try {
      // The oldest of 101 retained archives must survive eviction as reconciliation work.
      projection.setArchivePageSize(101);
      await withReadySessionRows(
        projection,
        () => queries.slice(0, 101),
        (read) => {
          for (const query of queries.slice(0, 101)) {
            expect(read.describe(query)?.entry.category).toBe("Work");
          }
        },
      );
      const oldest = queries[0]!;
      expect(projection.capture(oldest)?.materialized).toBeDefined();
      const admitted: string[][] = [];
      const prepare = projection.withPreparedExactRows.bind(projection);
      vi.spyOn(projection, "withPreparedExactRows").mockImplementation(
        (select, consume, options) => {
          const selected = select(cfg);
          admitted.push(selected.map(({ key }) => key));
          return prepare(
            (config) => {
              // Reentry must retain this admission slice instead of draining a live set.
              expect(select(config)).toEqual(selected);
              return selected;
            },
            consume,
            options,
          );
        },
      );
      const reads: string[][] = [];
      observeRowFacts((owner) => async (input) => {
        reads.push([...input.sessionKeys]);
        return owner.readRowFacts(input);
      });
      sql = observeHostDataSql();
      sessionChanges.emitBatch(
        queries.map((query) => ({
          sessionKey: query.key,
          factsInvalidated: "category" as const,
        })),
      );
      projection.setArchivePageSize(100);
      expect(projection.capture(oldest)?.materialized).toBeUndefined();
      expect(projection.sharingTargetState(oldest)).toEqual({ status: "pending" });
      expect(() => projection.selectEntries({ key: oldest.key })).toThrow(SessionRowFactsPending);
      await projection.prepareMembership();
      expect(projection.needsMembershipPreparation()).toBe(false);
      expect(admitted.length).toBeGreaterThan(0);
      expect(admitted.every((keys) => keys.length <= MAX_SESSION_ROW_FACTS_KEYS)).toBe(true);
      expect(reads.every((keys) => keys.length <= MAX_SESSION_ROW_FACTS_KEYS)).toBe(true);
      // Cold exact materialization may reread metadata already accepted by bulk preparation.
      expect([...new Set(reads.flat())].toSorted()).toEqual(
        queries.map(({ key }) => key).toSorted(),
      );
      for (const query of queries) {
        expect(projection.sharingTargetState(query)).toMatchObject({ status: "ready" });
        expect(projection.capture(query)?.sharingEntry?.category).toBe("Work");
      }
      expect(sql.queries).toEqual([]);
    } finally {
      await projection.ensureMaterialized().catch(() => undefined);
      sql?.restore();
      projection.dispose();
      release();
    }
  });
});

it("keeps failed category facts pending and reenters selection through exact preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const query = { agentId: "main", key: "agent:main:category-selection" };
    const sibling = { agentId: "main", key: "agent:main:category-selection-sibling" };
    for (const target of [query, sibling]) {
      replaceSessionEntrySync(
        { agentId: target.agentId, sessionKey: target.key },
        { sessionId: target.key, updatedAt: 1, category: "Work" },
      );
    }
    const placements = createWorkerSessionPlacementStore();
    let publishCategory = false;
    let selectionStarted = false;
    let publishedAcrossAwait = false;
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({
      cfg,
      modelCatalog: [],
      placementFactsReader: {
        async readProjection(ids) {
          const reply = await placements.readProjection(ids);
          if (publishCategory) {
            expect(selectionStarted).toBe(true);
            publishCategory = false;
            publishedAcrossAwait = true;
            sessionChanges.emitBatch(
              [query, sibling].map(({ key }) => ({
                sessionKey: key,
                factsInvalidated: "category" as const,
              })),
            );
          }
          return reply;
        },
      },
    }).catch((error: unknown) => {
      release();
      throw error;
    });
    let sql: ReturnType<typeof observeHostDataSql> | undefined;
    try {
      await projection.ensureMaterialized();
      sql = observeHostDataSql();
      await projection.withSelectionPreparation(async () => {
        const materialized = projection.materializedCount;
        sessionChanges.emit({ sessionKey: query.key, factsInvalidated: "category" });
        expect(projection.sharingTargetState(query)).toEqual({ status: "pending" });
        await projection.prepareSelection();
        expect(projection.sharingTargetState(query)).toMatchObject({ status: "ready" });
        expect(projection.sharingTarget(query)?.entry.category).toBe("Work");
        expect(projection.materializedCount).toBe(materialized);
      });
      const failure = new Error("category row read failed");
      const reads: string[][] = [];
      observeRowFacts((owner) => async (input) => {
        const reply = await owner.readRowFacts(input);
        reads.push([...input.sessionKeys]);
        if (reads.length === 1) {
          throw failure;
        }
        return reply;
      });
      sessionChanges.emit({ sessionKey: query.key, factsInvalidated: "category" });
      await expect(projection.prepareMembership()).rejects.toBe(failure);
      expect(reads).toEqual([[query.key]]);
      expect(projection.sharingTargetState(query)).toEqual({ status: "pending" });
      expect(projection.needsMembershipPreparation()).toBe(true);
      // A new caller may retry; the failed request itself never reschedules.
      await projection.prepareMembership();
      expect(reads).toHaveLength(2);
      publishCategory = true;
      sessionChanges.emit({ all: true, scope: "worker-placements" });
      const selected = await withReadySessionRows(
        projection,
        () => {
          selectionStarted = true;
          return projection.selectEntries({ agentId: "main" }).map((row) => ({
            agentId: row.agentId,
            key: row.key,
            storePath: row.storeTarget.storePath,
          }));
        },
        (read) => [query, sibling].map((target) => read.describe(target)?.entry),
      );
      expect(selected).toMatchObject(
        [query, sibling].map(({ key }) => ({ sessionId: key, category: "Work" })),
      );
      expect(publishedAcrossAwait).toBe(true);
      expect(reads).toHaveLength(3);
      expect(reads[2]?.toSorted()).toEqual([query.key, sibling.key].toSorted());
      expect(projection.needsMembershipPreparation()).toBe(false);
      expect(sql.queries).toEqual([]);
    } finally {
      await projection.ensureMaterialized().catch(() => undefined);
      sql?.restore();
      projection.dispose();
      release();
    }
  });
});
