import { WorkerTaskError } from "@openclaw/worker-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import * as databaseFactsRead from "./session-row-database-facts.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import {
  seedRow,
  waitForRead,
  createTestProjection,
  holdForeground,
} from "./session-row-projection.read-fixture.test-support.js";
import { requestSessionRow } from "./session-row-projection.test-support.js";
import { replaceSessionRowFacts } from "./session-utils-row.js";
import { projectWorkerSessionPlacement } from "./worker-environments/placement-projector.js";
import type { WorkerSessionPlacementProjection } from "./worker-environments/placement-read-projection.types.js";
import {
  reportPlacementTransition,
  type WorkerSessionPlacementRecord,
} from "./worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

// Hold GatewayScheduler timeouts so WAL maintenance stays outside the request SQL budget.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  memorySessionActorOwners.reset();
});

const cfg = { agents: { entries: { main: {} } } };
const query = { agentId: "main", key: "agent:main:dashboard:incognito-prepared" };
const seedPrivate = (key: string, sessionId: string, entry: Partial<SessionEntry> = {}) =>
  replaceSessionEntry(
    { agentId: "main", sessionKey: key },
    { sessionId, updatedAt: 1, incognito: true, ...entry },
  );

type PlacementRow = {
  key: string;
  sessionId: string;
  placement: WorkerSessionPlacementRecord;
};

async function placeRow(
  placements: ReturnType<typeof createWorkerSessionPlacementStore>,
  key: string,
  sessionId: string,
  entry: Partial<SessionEntry>,
): Promise<PlacementRow> {
  seedRow(key, { sessionId, updatedAt: 1, ...entry });
  return {
    key,
    sessionId,
    placement: await placements.startDispatch({ agentId: "main", sessionKey: key, sessionId }),
  };
}

function placementSnapshot(
  rows: readonly PlacementRow[],
  ids: readonly string[],
): WorkerSessionPlacementProjection {
  return {
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
}

function describeSession(
  context: ReturnType<typeof requestContext>,
  key: string,
  id = key,
  respond = vi.fn(),
) {
  const completion = Promise.resolve(
    requestSessionRow(
      sessionByKeyReadHandlers["sessions.describe"]!,
      context,
      "sessions.describe",
      { key },
      respond,
      null,
      id,
    ),
  );
  return { respond, completion };
}

function expectPlacementResponse(
  respond: ReturnType<typeof vi.fn>,
  row: PlacementRow,
  extra: Partial<SessionEntry> = {},
) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
    session: expect.objectContaining({
      key: row.key,
      sessionId: row.sessionId,
      placement: projectWorkerSessionPlacement(row.placement),
      ...extra,
    }),
  });
}

async function heldPlacementReads(
  sessionCount: number,
  options: { sessionId?: (index: number) => string; maxPendingBytes?: number } = {},
) {
  const placements = createWorkerSessionPlacementStore();
  const rows: PlacementRow[] = [];
  for (let index = 0; index < sessionCount; index++) {
    const sessionId = options.sessionId?.(index) ?? `held-placement-${index}`;
    const key = `agent:main:held-placement-${index}`;
    rows.push(await placeRow(placements, key, sessionId, { archivedAt: 1 }));
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
        const snapshot = placementSnapshot(rows, ids);
        entered.resolve();
        await release.promise;
        return snapshot;
      } finally {
        pending--;
        pendingBytes -= inputBytes;
      }
    },
  );
  const releaseForeground = holdForeground();
  const projection = await createTestProjection({
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
      return { row, ...describeSession(context, row.key) };
    },
    dispose() {
      projection.dispose();
      releaseForeground();
    },
  };
}

it.for([
  ["coalesces overlapping cold descriptions", 8, 0, 24, undefined, 3],
  ["splits 160 descriptions at byte capacity", 160, 4 * 1024, 160, 128 * 1024, 1],
  ["rejects overflow then admits after drain", 130, 12 * 1024, 128, undefined, 1],
] as const)("%s", async ([, count, idLength, accepted, maxPendingBytes, copies], { signal }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = await heldPlacementReads(count, {
      sessionId: (index) => ` placement-${index}-${"x".repeat(idLength)} `,
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
      if (copies > 1) {
        for (let index = 0; index < count * copies; index++) {
          describe(fixture.rows[index % count]!);
        }
      } else {
        describe(fixture.rows[0]!);
        // Bind waits to the test signal so a stall still releases the held placement reads.
        await waitForRead(
          fixture.entered.promise,
          requests[0]!.completion,
          signal,
          "First placement read did not enter",
        );
        describe(fixture.rows[1]!);
        await waitForRead(
          fixture.atCapacity.promise,
          requests[1]!.completion,
          signal,
          "Second placement read did not enter",
        );
        for (const row of fixture.rows.slice(2)) {
          describe(row);
        }
      }
      await withinTest(fixture.entered.promise, signal);
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
        expectPlacementResponse(respond, row);
      }
      for (const { respond } of requests.slice(accepted)) {
        expect(respond).not.toHaveBeenCalled();
      }
      if (copies === 1) {
        expect(fixture.peakPending).toBe(2);
      }
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
      await waitForRead(
        prepared.promise,
        request.completion,
        signal,
        "Exact row preparation did not enter",
      );
      expect(request.respond).not.toHaveBeenCalled();
      await fixture.projection.ensureMaterialized();
      expect(fixture.readProjection.mock.calls).toEqual([[[row.sessionId]]]);
      releasePreparation.resolve();
      expect(await completed).toEqual([{ status: "fulfilled", value: undefined }]);
      expectPlacementResponse(request.respond, row);
    } finally {
      fixture.release.resolve();
      releasePreparation.resolve();
      await completed;
      reads.mockRestore();
      fixture.dispose();
    }
  });
});

it.each(["stores", "config"] as const)(
  "keeps an exact placement read usable across an unrelated %s publication",
  async (scope) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = await heldPlacementReads(2);
      const row = fixture.rows[0]!;
      const unrelated = fixture.rows[1]!;
      const request = fixture.describe(row);
      const completed = Promise.allSettled([request.completion]);
      try {
        await fixture.entered.promise;
        seedRow(unrelated.key, {
          sessionId: unrelated.sessionId,
          updatedAt: 2,
          archivedAt: 1,
          label: "Unrelated update",
        });
        sessionChanges.emit({ all: true, scope });
        fixture.release.resolve();
        expect(await completed).toEqual([{ status: "fulfilled", value: undefined }]);
        expectPlacementResponse(request.respond, row);
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
  },
);

it("keeps exact category reads independent of bulk placement preparation", async ({ signal }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const placements = createWorkerSessionPlacementStore();
    const rows: PlacementRow[] = [];
    for (const name of ["exact", "bulk"]) {
      const sessionId = `independent-placement-${name}`;
      const key = `agent:main:${sessionId}`;
      rows.push(
        await placeRow(placements, key, sessionId, {
          label: name === "exact" ? "Fresh exact description" : undefined,
        }),
      );
    }
    const exactRow = rows[0]!;
    const bulkRow = rows[1]!;
    const bulkEntered = createDeferredCore();
    const releaseBulk = createDeferredCore();
    let holdBulk = false;
    const readProjection = async (
      ids: readonly string[],
    ): Promise<WorkerSessionPlacementProjection> => {
      const snapshot = placementSnapshot(rows, ids);
      if (holdBulk && ids.includes(bulkRow.sessionId)) {
        bulkEntered.resolve();
        await releaseBulk.promise;
      }
      return snapshot;
    };
    using releaseForeground = holdForeground();
    using projection = await createTestProjection({
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
      bulkRow.placement = await placements.transition({
        sessionId: bulkRow.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: bulkRow.placement.generation,
      });
      reportPlacementTransition(undefined, bulkRow.placement);
      const bulk = projection.ensureMaterialized();
      pending.push(Promise.allSettled([bulk]));
      await waitForRead(bulkEntered.promise, bulk, signal, "Bulk placement refresh did not enter");
      exactRow.placement = await placements.transition({
        sessionId: exactRow.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: exactRow.placement.generation,
      });
      reportPlacementTransition(undefined, exactRow.placement);
      const sql = observeHostDataSql();
      sessionChanges.emit({ sessionKey: exactRow.key, factsInvalidated: "category" });
      const { respond, completion: description } = describeSession(
        context,
        exactRow.key,
        exactRow.sessionId,
      );
      pending.push(Promise.allSettled([description]));
      const membership = projection.prepareMembership();
      pending.push(Promise.allSettled([membership]));
      try {
        await withinTest(Promise.all([description, membership]), signal);
        expect(projection.sharingTargetState({ agentId: "main", key: exactRow.key })).toMatchObject(
          { status: "ready" },
        );
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      expectPlacementResponse(respond, exactRow, { label: "Fresh exact description" });
      releaseBulk.resolve();
      await bulk;
      expect(projection.snapshot({ agentId: "main", key: bulkRow.key }).row?.placement).toEqual(
        projectWorkerSessionPlacement(bulkRow.placement),
      );
    } finally {
      releaseBulk.resolve();
      await Promise.all(pending);
    }
  });
});

it("consumes an incognito repository description without SQLite or resident private rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const repository = await getSessionRepositoryWorkspaceStore().create({
      agentId: query.agentId,
      sessionKey: query.key,
      url: "https://github.com/synthetic/private-description.git",
      branch: "private-description",
      assertCurrent: () => {},
    });
    await seedPrivate(query.key, "private-description", {
      lifecycleRevision: "original",
      repositoryWorkspaceId: repository.workspaceId,
    });
    const placements = createWorkerSessionPlacementStore();
    await placements.startDispatch({
      agentId: query.agentId,
      sessionKey: query.key,
      sessionId: "private-description",
    });
    using projection = await createTestProjection({
      cfg,
      placementFactsReader: placements,
    });
    const prepare = projection.withPreparedExactRows.bind(projection);
    let retained: SessionRowReadView | undefined;
    const prepared = vi
      .spyOn(projection, "withPreparedExactRows")
      .mockImplementation((queries, consume) => {
        return prepare(queries, (read) => {
          retained = read;
          const sql = observeHostDataSql();
          try {
            const result = consume(read);
            expect(sql.queries).toEqual([]);
            return result;
          } finally {
            sql.restore();
          }
        });
      });
    const respond = vi.fn();
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);

    await describeSession(context, query.key, "private-description", respond).completion;
    expect(prepared).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
      session: expect.objectContaining({
        key: query.key,
        sessionId: "private-description",
        placement: expect.objectContaining({ state: "requested" }),
        repository: { url: repository.url, branch: repository.branch },
      }),
    });
    expect(() => projection.describe(query, undefined, repository)).toThrow(
      "require awaited row preparation",
    );
    expect(projection.selectEntries()).toEqual([]);
    expect(() => retained?.describe(query)).toThrow("no longer active");
    expect(() => retained?.selectEntries({ key: query.key })).toThrow("no longer active");
  });
});

it("keeps missing private reads absent and refuses unprepared keys and asynchronous consumers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    using projection = await createTestProjection({ cfg });
    let retained: SessionRowReadView | undefined;
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
  });
});

it("prepares only the private response's child selections before consumption", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await seedPrivate(query.key, "private-parent");
    const childKey = "agent:main:dashboard:incognito-child-visibility";
    await seedPrivate(childKey, "private-child", { parentSessionKey: query.key });
    using projection = await createTestProjection({ cfg });

    const describe = projection.describe.bind(projection);
    vi.spyOn(projection, "describe").mockImplementation((...args) => {
      const row = describe(...args);
      if (!row) {
        throw new Error("Expected the private parent fixture");
      }
      row.materialized = replaceSessionRowFacts(row.materialized, {
        swarm: {
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
        },
      });
      return row;
    });
    const select = vi.spyOn(projection, "selectEntries").mockImplementation(() => {
      throw new Error("private child metadata must come from the prepared actor read");
    });
    await projection.withPreparedExactRows(
      () => [query],
      (read) => {
        expect(read.selectEntries({ key: childKey })).toMatchObject([
          { key: childKey, entry: { sessionId: "private-child" } },
        ]);
        expect(() => read.selectEntries({ key: "agent:main:unprepared-child" })).toThrow(
          "not prepared",
        );
        expect(select).not.toHaveBeenCalled();
      },
    );
    expect(projection.capture(query)?.entry?.sessionId).toBe("private-parent");
  });
});
