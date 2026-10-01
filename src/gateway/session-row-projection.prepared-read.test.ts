import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { WorkerTaskError } from "../infra/worker-task-pool-core.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import * as databaseFactsRead from "./session-row-projection-read.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { projectWorkerSessionPlacement } from "./worker-environments/placement-projector.js";
import type { WorkerSessionPlacementProjection } from "./worker-environments/placement-read-projection.types.js";
import {
  reportPlacementTransition,
  type WorkerSessionPlacementRecord,
} from "./worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

afterEach(() => vi.restoreAllMocks());

const cfg = { agents: { entries: { main: {} } } };
const query = { agentId: "main", key: "agent:main:dashboard:incognito-prepared" };

type PlacementRow = {
  key: string;
  sessionId: string;
  placement: WorkerSessionPlacementRecord;
};

async function heldPlacementReads(
  sessionCount: number,
  options: { sessionId?: (index: number) => string; maxPendingBytes?: number } = {},
) {
  const placements = createWorkerSessionPlacementStore();
  const rows: PlacementRow[] = [];
  for (let index = 0; index < sessionCount; index++) {
    const sessionId = options.sessionId?.(index) ?? `held-placement-${index}`;
    const key = `agent:main:held-placement-${index}`;
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      { sessionId, updatedAt: 1, archivedAt: 1 },
    );
    rows.push({
      key,
      sessionId,
      placement: await placements.startDispatch({ agentId: "main", sessionKey: key, sessionId }),
    });
  }
  const entered = createDeferredCore();
  const atCapacity = createDeferredCore();
  const release = createDeferredCore();
  let pending = 0;
  let pendingBytes = 0;
  let peakPending = 0;
  const readProjection = vi.fn(
    async (ids: readonly string[]): Promise<WorkerSessionPlacementProjection> => {
      // A small admission budget reproduces the shared worker's bounded queue.
      const inputBytes = Buffer.byteLength(JSON.stringify(ids));
      if (
        pending >= 2 ||
        (options.maxPendingBytes !== undefined &&
          pendingBytes + inputBytes > options.maxPendingBytes)
      ) {
        throw new WorkerTaskError("worker task capacity reached", "overloaded");
      }
      pending++;
      pendingBytes += inputBytes;
      peakPending = Math.max(peakPending, pending);
      if (pending === 2) {
        atCapacity.resolve();
      }
      try {
        const snapshot: WorkerSessionPlacementProjection = {
          placements: new Map(
            rows
              .filter((row) => ids.includes(row.sessionId))
              .map((row) => [row.sessionId, row.placement]),
          ),
          moves: new Map(),
          pendingResults: new Map(),
          workspaceJournalOwnerSessionIds: new Set(),
          environments: new Map(),
          workspaceResultReconcilingSessionIds: new Set(),
          workspaceRecoveryPendingSessionIds: new Set(),
        };
        entered.resolve();
        await release.promise;
        return snapshot;
      } finally {
        pending--;
        pendingBytes -= inputBytes;
      }
    },
  );
  const releaseForeground = retainSessionListForegroundWork();
  const projection = await createSessionRowProjection({
    cfg,
    modelCatalog: [],
    placementFactsReader: { readProjection },
  }).catch((error: unknown) => {
    releaseForeground();
    throw error;
  });
  const context = bindSessionRowProjection(requestContext(cfg), () => projection);
  return {
    rows,
    projection,
    entered,
    atCapacity,
    release,
    readProjection,
    get peakPending() {
      return peakPending;
    },
    describe(row: (typeof rows)[number]) {
      const respond = vi.fn();
      const completion = Promise.resolve(
        sessionByKeyReadHandlers["sessions.describe"]!({
          req: { type: "req", id: row.key, method: "sessions.describe" },
          params: { key: row.key },
          client: null,
          context,
          isWebchatConnect: () => false,
          respond,
        }),
      );
      return { row, respond, completion };
    },
    dispose() {
      projection.dispose();
      releaseForeground();
    },
  };
}

it("serves overlapping cold descriptions within bounded placement-read admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = await heldPlacementReads(8);
    const requests = Array.from({ length: 24 }, (_, index) =>
      fixture.describe(fixture.rows[index % fixture.rows.length]!),
    );
    const completed = Promise.allSettled(requests.map((request) => request.completion));
    try {
      await fixture.entered.promise;
      fixture.release.resolve();
      expect(await completed).toEqual(
        requests.map(() => ({ status: "fulfilled", value: undefined })),
      );
      for (const { row, respond } of requests) {
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
          session: expect.objectContaining({
            key: row.key,
            sessionId: row.sessionId,
            placement: projectWorkerSessionPlacement(row.placement),
          }),
        });
      }
    } finally {
      fixture.release.resolve();
      await completed;
      fixture.dispose();
    }
  });
});

it.for([
  {
    name: "serves more than 128 descriptions without joining inputs beyond reader capacity",
    count: 160,
    idLength: 4 * 1024,
    accepted: 160,
    maxPendingBytes: 128 * 1024,
  },
  {
    name: "refuses only new descriptions at retained-batch capacity and admits them after drain",
    count: 130,
    idLength: 12 * 1024,
    accepted: 128,
    maxPendingBytes: undefined,
  },
])("$name", async ({ count, idLength, accepted, maxPendingBytes }, { signal }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = await heldPlacementReads(count, {
      sessionId: (index) => `placement-${index}-${"x".repeat(idLength)}`,
      maxPendingBytes,
    });
    const selected = new Set<string>();
    const allSelected = createDeferredCore();
    const prepare = fixture.projection.withPreparedExactRows.bind(fixture.projection);
    vi.spyOn(fixture.projection, "withPreparedExactRows").mockImplementation(
      (queries, consume, options) =>
        prepare(
          (config) => {
            const rows = queries(config);
            for (const { key } of rows) {
              selected.add(key);
            }
            if (selected.size === fixture.rows.length) {
              allSelected.resolve();
            }
            return rows;
          },
          consume,
          options,
        ),
    );
    const requests: ReturnType<typeof fixture.describe>[] = [];
    const pending: Promise<unknown>[] = [];
    const describe = (row: (typeof fixture.rows)[number]) => {
      const request = fixture.describe(row);
      requests.push(request);
      pending.push(Promise.allSettled([request.completion]));
    };
    try {
      describe(fixture.rows[0]!);
      // Bind waits to the test signal so a stall still releases the held placement reads.
      await withinTest(
        awaitGateBeforeSettlement(
          fixture.entered.promise,
          requests[0]!.completion,
          "First placement read did not enter",
        ),
        signal,
      );
      describe(fixture.rows[1]!);
      await withinTest(
        awaitGateBeforeSettlement(
          fixture.atCapacity.promise,
          requests[1]!.completion,
          "Second placement read did not enter",
        ),
        signal,
      );
      for (const row of fixture.rows.slice(2)) {
        describe(row);
      }
      await withinTest(allSelected.promise, signal);
      fixture.release.resolve();
      expect(await Promise.all(pending)).toEqual(
        requests.map((_, index) => [
          index < accepted
            ? { status: "fulfilled", value: undefined }
            : { status: "rejected", reason: expect.objectContaining({ code: "overloaded" }) },
        ]),
      );
      for (const { row, respond } of requests.slice(0, accepted)) {
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
          session: expect.objectContaining({
            key: row.key,
            sessionId: row.sessionId,
            placement: projectWorkerSessionPlacement(row.placement),
          }),
        });
      }
      for (const { respond } of requests.slice(accepted)) {
        expect(respond).not.toHaveBeenCalled();
      }
      expect(fixture.peakPending).toBe(2);
      expect(fixture.readProjection.mock.calls.flatMap(([ids]) => ids)).toEqual(
        fixture.rows.slice(0, accepted).map(({ sessionId }) => sessionId),
      );
      const afterDrain = fixture.describe(fixture.rows.at(-1)!);
      pending.push(Promise.allSettled([afterDrain.completion]));
      await afterDrain.completion;
      expect(afterDrain.respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({ sessionId: afterDrain.row.sessionId }),
      });
    } finally {
      fixture.dispose();
      fixture.release.resolve();
      await Promise.all(pending);
    }
  });
});

it("reuses settled exact placement facts while archived row preparation is completing", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = await heldPlacementReads(1);
    const row = fixture.rows[0]!;
    const prepared = createDeferredCore();
    const releasePreparation = createDeferredCore();
    const readFacts = databaseFactsRead.withSessionRowDatabaseFacts;
    const reads = vi
      .spyOn(databaseFactsRead, "withSessionRowDatabaseFacts")
      .mockImplementation(async (...args) => {
        await readFacts(...args);
        if (args[0].selected?.size) {
          prepared.resolve();
          await releasePreparation.promise;
        }
      });
    const request = fixture.describe(row);
    const completed = Promise.allSettled([request.completion]);
    try {
      await fixture.entered.promise;
      fixture.release.resolve();
      await withinTest(
        awaitGateBeforeSettlement(
          prepared.promise,
          request.completion,
          "Exact row preparation did not enter",
        ),
        signal,
      );
      expect(request.respond).not.toHaveBeenCalled();
      await fixture.projection.ensureMaterialized();
      expect(fixture.readProjection.mock.calls).toEqual([[[row.sessionId]]]);
      releasePreparation.resolve();
      expect(await completed).toEqual([{ status: "fulfilled", value: undefined }]);
      expect(request.respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({
          key: row.key,
          sessionId: row.sessionId,
          placement: projectWorkerSessionPlacement(row.placement),
        }),
      });
    } finally {
      fixture.release.resolve();
      releasePreparation.resolve();
      await completed;
      reads.mockRestore();
      fixture.dispose();
    }
  });
});

it.each([
  { scope: "session", expectedReads: 1 },
  { scope: "stores", expectedReads: 2 },
  { scope: "config", expectedReads: 1 },
] as const)(
  "keeps an exact placement read usable across an unrelated $scope publication",
  async ({ scope, expectedReads }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = await heldPlacementReads(2);
      const row = fixture.rows[0]!;
      const unrelated = fixture.rows[1]!;
      const request = fixture.describe(row);
      const completed = Promise.allSettled([request.completion]);
      try {
        await fixture.entered.promise;
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: unrelated.key },
          {
            sessionId: unrelated.sessionId,
            updatedAt: 2,
            archivedAt: 1,
            label: "Unrelated update",
          },
        );
        if (scope !== "session") {
          sessionChanges.emit({ all: true, scope });
        }
        fixture.release.resolve();
        expect(await completed).toEqual([{ status: "fulfilled", value: undefined }]);
        expect(request.respond).toHaveBeenCalledExactlyOnceWith(true, {
          session: expect.objectContaining({
            key: row.key,
            sessionId: row.sessionId,
            placement: projectWorkerSessionPlacement(row.placement),
          }),
        });
        expect(
          fixture.projection.capture({ agentId: "main", key: unrelated.key })?.entry?.label,
        ).toBe("Unrelated update");
        expect(
          fixture.readProjection.mock.calls.filter(([ids]) => ids.includes(row.sessionId)),
        ).toHaveLength(expectedReads);
      } finally {
        fixture.release.resolve();
        await completed;
        fixture.dispose();
      }
    });
  },
);

it.for([false, true])("keeps exact reads independent of bulk %s", async (category, { signal }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const placements = createWorkerSessionPlacementStore();
    const rows: PlacementRow[] = [];
    for (const name of ["exact", "bulk"]) {
      const sessionId = `independent-placement-${name}`;
      const key = `agent:main:${sessionId}`;
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        {
          sessionId,
          updatedAt: 1,
          label: category && name === "exact" ? "Fresh exact description" : undefined,
        },
      );
      rows.push({
        key,
        sessionId,
        placement: await placements.startDispatch({
          agentId: "main",
          sessionKey: key,
          sessionId,
        }),
      });
    }
    const exactRow = rows[0]!;
    const bulkRow = rows[1]!;
    const bulkEntered = createDeferredCore();
    const releaseBulk = createDeferredCore();
    let holdBulk = false;
    const readProjection = async (
      ids: readonly string[],
    ): Promise<WorkerSessionPlacementProjection> => {
      const snapshot: WorkerSessionPlacementProjection = {
        placements: new Map(
          rows
            .filter((row) => ids.includes(row.sessionId))
            .map((row) => [row.sessionId, row.placement]),
        ),
        moves: new Map(),
        pendingResults: new Map(),
        workspaceJournalOwnerSessionIds: new Set(),
        environments: new Map(),
        workspaceResultReconcilingSessionIds: new Set(),
        workspaceRecoveryPendingSessionIds: new Set(),
      };
      if (holdBulk && ids.includes(bulkRow.sessionId)) {
        bulkEntered.resolve();
        await releaseBulk.promise;
      }
      return snapshot;
    };
    const releaseForeground = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({
      cfg,
      modelCatalog: [],
      placementFactsReader: { readProjection },
    }).catch((error: unknown) => {
      releaseForeground();
      throw error;
    });
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const pending: Promise<unknown>[] = [];
    try {
      await projection.ensureMaterialized();
      for (const row of rows) {
        expect(projection.snapshot({ agentId: "main", key: row.key }).row?.placement).toEqual(
          projectWorkerSessionPlacement(row.placement),
        );
      }
      holdBulk = true;
      bulkRow.placement = placements.transition({
        sessionId: bulkRow.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: bulkRow.placement.generation,
      });
      reportPlacementTransition(undefined, bulkRow.placement);
      const bulk = projection.ensureMaterialized();
      pending.push(Promise.allSettled([bulk]));
      await withinTest(
        awaitGateBeforeSettlement(
          bulkEntered.promise,
          bulk,
          "Bulk placement refresh did not enter",
        ),
        signal,
      );
      if (!category) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: exactRow.key },
          { sessionId: exactRow.sessionId, updatedAt: 2, label: "Fresh exact description" },
        );
      }
      exactRow.placement = placements.transition({
        sessionId: exactRow.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: exactRow.placement.generation,
      });
      reportPlacementTransition(undefined, exactRow.placement);
      const sql = observeHostDataSql();
      if (category) {
        sessionChanges.emit({ sessionKey: exactRow.key, factsInvalidated: "category" });
      }
      const respond = vi.fn();
      const description = Promise.resolve(
        sessionByKeyReadHandlers["sessions.describe"]!({
          req: { type: "req", id: exactRow.sessionId, method: "sessions.describe" },
          params: { key: exactRow.key },
          client: null,
          context,
          isWebchatConnect: () => false,
          respond,
        }),
      );
      pending.push(Promise.allSettled([description]));
      const membership = category ? projection.prepareMembership() : Promise.resolve();
      pending.push(Promise.allSettled([membership]));
      try {
        await withinTest(Promise.all([description, membership]), signal);
        if (category) {
          expect(
            projection.sharingTargetState({ agentId: "main", key: exactRow.key }),
          ).toMatchObject({ status: "ready" });
        }
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({
          key: exactRow.key,
          sessionId: exactRow.sessionId,
          label: "Fresh exact description",
          placement: projectWorkerSessionPlacement(exactRow.placement),
        }),
      });
      releaseBulk.resolve();
      await bulk;
      expect(projection.snapshot({ agentId: "main", key: bulkRow.key }).row?.placement).toEqual(
        projectWorkerSessionPlacement(bulkRow.placement),
      );
    } finally {
      releaseBulk.resolve();
      await Promise.all(pending);
      projection.dispose();
      releaseForeground();
    }
  });
});

it.each([false, true])(
  "preserves stored session ID spelling in placement facts (archived: %s)",
  async (archived) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const target = { agentId: "main", sessionKey: "agent:main:placement-spelling" };
      const sessionId = " placement-spelling ";
      replaceSessionEntrySync(target, {
        sessionId,
        updatedAt: 1,
        ...(archived ? { archivedAt: 1 } : {}),
      });
      expect(loadSessionEntryReadOnly(target)?.sessionId).toBe(sessionId);
      const placements = createWorkerSessionPlacementStore();
      await placements.startDispatch({ ...target, sessionId });
      const projection = await createSessionRowProjection({
        cfg,
        modelCatalog: [],
        placementFactsReader: placements,
      });
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      const respond = vi.fn();
      try {
        await projection.ensureMaterialized();
        expect(projection.materializedCount).toBe(archived ? 0 : 1);
        await sessionByKeyReadHandlers["sessions.describe"]!({
          req: { type: "req", id: "placement-spelling", method: "sessions.describe" },
          params: { key: target.sessionKey },
          client: null,
          context,
          isWebchatConnect: () => false,
          respond,
        });
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
          session: expect.objectContaining({
            key: target.sessionKey,
            sessionId,
            placement: expect.objectContaining({ state: "requested" }),
          }),
        });
        expect(loadSessionEntryReadOnly(target)?.sessionId).toBe(sessionId);
      } finally {
        projection.dispose();
      }
    });
  },
);

it.each([false, true])(
  "consumes an incognito describe response without SQLite or resident private rows (repository=%s)",
  async (withRepository) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const repository = withRepository
        ? await getSessionRepositoryWorkspaceStore().create({
            agentId: query.agentId,
            sessionKey: query.key,
            url: "https://github.com/synthetic/private-description.git",
            branch: "private-description",
            assertCurrent: () => {},
          })
        : undefined;
      replaceSessionEntrySync(
        { agentId: query.agentId, sessionKey: query.key },
        {
          sessionId: "private-description",
          lifecycleRevision: "original",
          updatedAt: 1,
          incognito: true,
          ...(repository ? { repositoryWorkspaceId: repository.workspaceId } : {}),
        },
      );
      const placements = createWorkerSessionPlacementStore();
      await placements.startDispatch({
        agentId: query.agentId,
        sessionKey: query.key,
        sessionId: "private-description",
      });
      const projection = await createSessionRowProjection({
        cfg,
        placementFactsReader: placements,
      });
      const prepare = projection.withPreparedExactRows.bind(projection);
      let retained: SessionRowReadView | undefined;
      const prepared = vi
        .spyOn(projection, "withPreparedExactRows")
        .mockImplementation((queries, consume) => {
          const statements = [
            vi.spyOn(DatabaseSync.prototype, "exec"),
            ...(["all", "get", "iterate", "run"] as const).map((method) =>
              vi.spyOn(StatementSync.prototype, method),
            ),
          ];
          return prepare(queries, (read) => {
            retained = read;
            expect(
              statements.reduce((count, statement) => count + statement.mock.calls.length, 0),
            ).toBeGreaterThan(0);
            for (const statement of statements) {
              statement.mockClear();
            }
            const result = consume(read);
            for (const statement of statements) {
              expect(statement).not.toHaveBeenCalled();
            }
            return result;
          }).finally(() => {
            for (const statement of statements) {
              statement.mockRestore();
            }
          });
        });
      const escapedPlacement = createDeferredCore<unknown>();
      const respond = vi.fn(() => {
        queueMicrotask(() => {
          try {
            escapedPlacement.resolve(
              repository
                ? projection.describe(query, undefined, repository)?.materialized.row.placement
                : projection.snapshot(query).row?.placement,
            );
          } catch (error) {
            escapedPlacement.reject(error);
          }
        });
      });
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      try {
        await sessionByKeyReadHandlers["sessions.describe"]!({
          req: { type: "req", id: "private-description", method: "sessions.describe" },
          params: { key: query.key },
          client: null,
          context,
          isWebchatConnect: () => false,
          respond,
        });
        expect(prepared).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
          session: expect.objectContaining({
            key: query.key,
            sessionId: "private-description",
            placement: expect.objectContaining({ state: "requested" }),
            ...(repository
              ? { repository: { url: repository.url, branch: repository.branch } }
              : {}),
          }),
        });
        expect(await escapedPlacement.promise).toBeUndefined();
        expect(projection.selectEntries()).toEqual([]);
        expect(() => retained?.describe(query)).toThrow("no longer active");
      } finally {
        projection.dispose();
      }
    });
  },
);

it("keeps missing private reads absent and refuses unprepared keys and asynchronous consumers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const projection = await createSessionRowProjection({ cfg });
    let retained: SessionRowReadView | undefined;
    try {
      await projection.withPreparedExactRows(
        () => [query],
        (read) => {
          expect(read.describe(query)).toBeUndefined();
          expect(() => read.describe({ ...query, key: `${query.key}-other` })).toThrow(
            "not prepared",
          );
        },
      );
      await expect(
        projection.withPreparedExactRows(
          () => [],
          (read) => {
            retained = read;
            return Promise.resolve();
          },
        ),
      ).rejects.toThrow("must remain synchronous");
      expect(() => retained?.selectEntries({ key: query.key })).toThrow("no longer active");
      expect(projection.capture(query)).toBeUndefined();
      expect(projection.selectEntries()).toEqual([]);
    } finally {
      projection.dispose();
    }
  });
});

it("prepares only the private response's child selections before consumption", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    replaceSessionEntrySync(
      { agentId: query.agentId, sessionKey: query.key },
      { sessionId: "private-parent", updatedAt: 1, incognito: true },
    );
    const projection = await createSessionRowProjection({ cfg });
    try {
      const row = projection.describe(query);
      if (!row) {
        throw new Error("Expected the private parent fixture");
      }
      const childKey = "agent:main:child-visibility";
      row.materialized.row.swarm = {
        otherActiveGroups: 0,
        groups: [
          {
            groupId: "private-group",
            createdAt: 1,
            queued: 0,
            running: 1,
            done: 0,
            failed: 0,
            children: [{ sessionKey: childKey, status: "running" }],
          },
        ],
      };
      vi.spyOn(projection, "describe").mockReturnValue(row);
      const select = vi.spyOn(projection, "selectEntries").mockReturnValue([]);
      await projection.withPreparedExactRows(
        () => [query],
        (read) => {
          expect(select).toHaveBeenCalledExactlyOnceWith({ key: childKey });
          select.mockClear();
          select.mockImplementation(() => {
            throw new Error("child metadata must be read before consumption");
          });
          expect(read.selectEntries({ key: childKey })).toEqual([]);
          expect(() => read.selectEntries({ key: "agent:main:unprepared-child" })).toThrow(
            "not prepared",
          );
          expect(select).not.toHaveBeenCalled();
        },
      );
      expect(projection.capture(query)?.entry?.sessionId).toBe("private-parent");
    } finally {
      projection.dispose();
    }
  });
});
