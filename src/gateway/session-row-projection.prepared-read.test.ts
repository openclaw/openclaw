import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { WorkerTaskError } from "../infra/worker-task-pool-core.js";
import { createDeferredCore } from "../shared/deferred.js";
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
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

afterEach(() => vi.restoreAllMocks());

const cfg = { agents: { entries: { main: {} } } };
const query = { agentId: "main", key: "agent:main:dashboard:incognito-prepared" };

async function heldPlacementReads(
  sessionCount: number,
  options: { sessionId?: (index: number) => string; maxPendingBytes?: number } = {},
) {
  const placements = createWorkerSessionPlacementStore();
  const rows = Array.from({ length: sessionCount }, (_, index) => {
    const sessionId = options.sessionId?.(index) ?? `held-placement-${index}`;
    const key = `agent:main:held-placement-${index}`;
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      { sessionId, updatedAt: 1, archivedAt: 1 },
    );
    return {
      key,
      sessionId,
      placement: placements.startDispatch({ agentId: "main", sessionKey: key, sessionId }),
    };
  });
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
          environments: new Map(),
          workspaceResultReconcilingSessionIds: new Set(),
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

it.each([
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
])("$name", async ({ count, idLength, accepted, maxPendingBytes }) => {
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
      await withTestTimeout(fixture.entered.promise, 2_000, "First placement read did not enter");
      describe(fixture.rows[1]!);
      await withTestTimeout(
        fixture.atCapacity.promise,
        2_000,
        "Second placement read did not enter",
      );
      for (const row of fixture.rows.slice(2)) {
        describe(row);
      }
      await withTestTimeout(allSelected.promise, 2_000, "Description burst was not selected");
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

it("reuses settled exact placement facts while archived row preparation is completing", async () => {
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
      await withTestTimeout(prepared.promise, 2_000, "Exact row preparation did not enter");
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

it("keeps an exact placement read usable across an unrelated session publication", async () => {
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
        { sessionId: unrelated.sessionId, updatedAt: 2, archivedAt: 1, label: "Unrelated update" },
      );
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
      ).toHaveLength(1);
    } finally {
      fixture.release.resolve();
      await completed;
      fixture.dispose();
    }
  });
});

it("serves an exact description while an unrelated bulk placement refresh is held", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const placements = createWorkerSessionPlacementStore();
    const rows = ["exact", "bulk"].map((name) => {
      const sessionId = `independent-placement-${name}`;
      const key = `agent:main:${sessionId}`;
      replaceSessionEntrySync({ agentId: "main", sessionKey: key }, { sessionId, updatedAt: 1 });
      return {
        key,
        sessionId,
        placement: placements.startDispatch({ agentId: "main", sessionKey: key, sessionId }),
      };
    });
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
        environments: new Map(),
        workspaceResultReconcilingSessionIds: new Set(),
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
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: bulkRow.key },
        { sessionId: bulkRow.sessionId, updatedAt: 2 },
      );
      const bulk = projection.ensureMaterialized();
      pending.push(Promise.allSettled([bulk]));
      await withTestTimeout(bulkEntered.promise, 2_000, "Bulk placement refresh did not enter");
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: exactRow.key },
        { sessionId: exactRow.sessionId, updatedAt: 2, label: "Fresh exact description" },
      );
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
      await withTestTimeout(
        description,
        2_000,
        "Exact description waited for an unrelated bulk placement refresh",
      );
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
      placements.startDispatch({ ...target, sessionId });
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

it("consumes an incognito describe response without SQLite or resident private rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    replaceSessionEntrySync(
      { agentId: query.agentId, sessionKey: query.key },
      {
        sessionId: "private-description",
        lifecycleRevision: "original",
        updatedAt: 1,
        incognito: true,
      },
    );
    const placements = createWorkerSessionPlacementStore();
    placements.startDispatch({
      agentId: query.agentId,
      sessionKey: query.key,
      sessionId: "private-description",
    });
    const projection = await createSessionRowProjection({ cfg, placementFactsReader: placements });
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
          escapedPlacement.resolve(projection.snapshot(query).row?.placement);
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
        }),
      });
      expect(await escapedPlacement.promise).toBeUndefined();
      expect(projection.selectEntries()).toEqual([]);
      expect(() => retained?.describe(query)).toThrow("no longer active");
    } finally {
      projection.dispose();
    }
  });
});

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
