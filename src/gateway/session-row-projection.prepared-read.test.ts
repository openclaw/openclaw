import { renameSync } from "node:fs";
import { StatementSync } from "node:sqlite";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import { describe, afterEach, beforeEach, expect, it, vi, onTestFinished } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import {
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  replaceSessionEntry,
  deleteSessionEntryLifecycle,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { applySessionEntryExactReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { removeSessionMember } from "../config/sessions/session-sharing-store.native.js";
import type { SessionEntry, SessionAcpMeta } from "../config/sessions/types.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  emitSessionsChanged,
  flushPendingSessionsChangedEvents,
} from "./server-methods/session-change-event.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import {
  requestContext,
  identifiedClient,
  listSessions,
} from "./server-methods/sessions-read-cache.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { defaultPersistDigest } from "./session-observer-model.js";
import * as databaseFactsRead from "./session-row-database-facts.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { isColdArchivedSessionRow } from "./session-row-projection-archive.js";
import {
  withAcceptedSuffix,
  registerAcceptedSuffixRaceTests,
} from "./session-row-projection.accepted-facts.test-support.js";
import {
  seedRow,
  waitForRead,
  createTestProjection,
  holdForeground,
} from "./session-row-projection.read-fixture.test-support.js";
import {
  requestSessionRow,
  acpProjectionMeta,
  withSessionRowProjectionState,
} from "./session-row-projection.test-support.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import { replaceSessionRowFacts } from "./session-utils-row.js";
import { projectWorkerSessionPlacement } from "./worker-environments/placement-projector.js";
import type { WorkerSessionPlacementProjection } from "./worker-environments/placement-read-projection.types.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";
import { reportPlacementTransition } from "./worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

describe("accepted session facts existing coverage", () => {
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
    sessionId: string,
    entry: Partial<SessionEntry> = {},
    key = `agent:main:${sessionId}`,
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
      rows.push(await placeRow(placements, sessionId, { archivedAt: 1 }, key));
    }
    const entered = createDeferredCore();
    const atCapacity = createDeferredCore();
    const release = createDeferredCore();
    let pending = 0;
    let pendingBytes = 0;
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
    const settledReads: Promise<unknown>[] = [];
    return {
      rows,
      projection,
      entered,
      atCapacity,
      release,
      readProjection,
      describe(row: (typeof rows)[number]) {
        const request = describeSession(context, row.key);
        const settled = Promise.allSettled([request.completion]);
        settledReads.push(settled);
        return { row, ...request, settled };
      },
      async [Symbol.asyncDispose]() {
        projection.dispose();
        releaseForeground();
        release.resolve();
        await Promise.all(settledReads);
      },
    };
  }

  it.for([
    ["coalesces overlapping cold descriptions", 8, 0, 24, undefined, 3],
    ["splits 160 descriptions at byte capacity", 160, 4 * 1024, 160, 128 * 1024, 1],
    ["rejects overflow then admits after drain", 130, 12 * 1024, 128, undefined, 1],
  ] as const)("%s", async ([, count, idLength, accepted, maxPendingBytes, copies], { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await using fixture = await heldPlacementReads(count, {
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
      const describeRow = (row: (typeof fixture.rows)[number]) => {
        requests.push(fixture.describe(row));
      };
      if (copies > 1) {
        for (let index = 0; index < count * copies; index++) {
          describeRow(fixture.rows[index % count]!);
        }
      } else {
        describeRow(fixture.rows[0]!);
        // Bind waits to the test signal so a stall still releases the held placement reads.
        await waitForRead(
          fixture.entered.promise,
          requests[0]!.completion,
          signal,
          "First placement read did not enter",
        );
        describeRow(fixture.rows[1]!);
        await waitForRead(
          fixture.atCapacity.promise,
          requests[1]!.completion,
          signal,
          "Second placement read did not enter",
        );
        for (const row of fixture.rows.slice(2)) {
          describeRow(row);
        }
      }
      await withinTest(fixture.entered.promise, signal);
      await withinTest(allSelected.promise, signal);
      fixture.release.resolve();
      expect(await Promise.all(requests.map(({ settled }) => settled))).toEqual(
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
      expect(fixture.readProjection.mock.calls.flatMap(([ids]) => ids)).toEqual(
        fixture.rows.slice(0, accepted).map(({ sessionId }) => sessionId),
      );
      const afterDrain = fixture.describe(fixture.rows.at(-1)!);
      await afterDrain.completion;
      expect(afterDrain.respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({ sessionId: afterDrain.row.sessionId }),
      });
    });
  });

  it("reuses settled exact placement facts while archived row preparation is completing", async ({
    signal,
  }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await using fixture = await heldPlacementReads(1);
      const row = fixture.rows[0]!;
      const prepared = createDeferredCore();
      const releasePreparation = createDeferredCore();
      using cleanup = new DisposableStack();
      cleanup.defer(releasePreparation.resolve);
      const readFacts = databaseFactsRead.withSessionRowDatabaseFacts;
      cleanup.use(
        vi
          .spyOn(databaseFactsRead, "withSessionRowDatabaseFacts")
          .mockImplementation(async (...args) => {
            await readFacts(...args);
            if (args[0].selected?.size) {
              prepared.resolve();
              await releasePreparation.promise;
            }
          }),
      );
      const request = fixture.describe(row);
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
      expect(await request.settled).toEqual([{ status: "fulfilled", value: undefined }]);
      expectPlacementResponse(request.respond, row);
    });
  });

  it.each(["stores", "config"] as const)(
    "keeps an exact placement read usable across an unrelated %s publication",
    async (scope) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await using fixture = await heldPlacementReads(2);
        const row = fixture.rows[0]!;
        const unrelated = fixture.rows[1]!;
        const request = fixture.describe(row);
        await fixture.entered.promise;
        seedRow(unrelated.key, {
          sessionId: unrelated.sessionId,
          updatedAt: 2,
          archivedAt: 1,
          label: "Unrelated update",
        });
        sessionChanges.emit({ all: true, scope });
        fixture.release.resolve();
        expect(await request.settled).toEqual([{ status: "fulfilled", value: undefined }]);
        expectPlacementResponse(request.respond, row);
        expect(
          fixture.projection.capture({ agentId: "main", key: unrelated.key })?.entry?.label,
        ).toBe("Unrelated update");
        expect(
          fixture.readProjection.mock.calls.filter(([ids]) => ids.includes(row.sessionId)),
        ).toHaveLength(1);
      });
    },
  );

  it("keeps exact category reads independent of bulk placement preparation", async ({ signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const placements = createWorkerSessionPlacementStore();
      const exactRow = await placeRow(placements, "independent-placement-exact", {
        label: "Fresh exact description",
      });
      const bulkRow = await placeRow(placements, "independent-placement-bulk");
      const rows = [exactRow, bulkRow];
      const provision = async (row: PlacementRow) => {
        row.placement = await placements.transition({
          sessionId: row.sessionId,
          from: "requested",
          to: "provisioning",
          expectedGeneration: row.placement.generation,
        });
        reportPlacementTransition(undefined, row.placement);
      };
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
        holdBulk = true;
        await provision(bulkRow);
        const bulk = projection.ensureMaterialized();
        pending.push(Promise.allSettled([bulk]));
        await waitForRead(
          bulkEntered.promise,
          bulk,
          signal,
          "Bulk placement refresh did not enter",
        );
        await provision(exactRow);
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
          expect(
            projection.sharingTargetState({ agentId: "main", key: exactRow.key }),
          ).toMatchObject({ status: "ready" });
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
      vi.spyOn(projection, "withPreparedExactRows").mockImplementation((queries, consume) => {
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

      const describeRow = projection.describe.bind(projection);
      vi.spyOn(projection, "describe").mockImplementation((...args) => {
        const row = describeRow(...args);
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
});

describe("accepted session facts retained boundaries", () => {
  afterEach(() => vi.restoreAllMocks());

  function writeTranscript(
    scope: Parameters<typeof persistSessionTranscriptTurn>[0],
    role: "user" | "assistant",
    content: string,
    options: Omit<Parameters<typeof persistSessionTranscriptTurn>[1], "messages"> = {},
  ) {
    return persistSessionTranscriptTurn(scope, {
      messages: [{ message: { role, content } }],
      ...options,
    });
  }

  registerAcceptedSuffixRaceTests(writeTranscript);

  function sharedFactReads(reads: {
    mock: { calls: Parameters<typeof stateReads.executeExistingOpenClawStateRead>[] };
  }) {
    return reads.mock.calls.filter(([, command]) => command.type === "sessionRows.sharedFacts");
  }

  it.each([
    "ACP publication",
    "lifecycle reset",
    "worker legacy reset",
    "lifecycle adapter",
    "observer adapter",
    "transcript publication",
  ] as const)("carries complete accepted ACP facts across a yield: %s", async (change) => {
    const initial = acpProjectionMeta("accepted-acp-backend", "accepted-1");
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
          await writeTranscript(
            { ...scope, sessionId: entry.sessionId, storePath: suffix.storeTarget.storePath },
            "assistant",
            "New transcript content",
            { touchSessionEntry: false },
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
          expect(sharedFactReads(metadataReads)).toHaveLength(0);
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
      await withSessionRowProjectionState(async (create) => {
        const scope = { agentId: "main", sessionKey: "agent:main:acp:late-facts" };
        const projection = await create({
          cfg: { agents: { entries: { main: {} } } },
          modelCatalog: [],
        });
        const captured = createDeferredCore();
        const release = createDeferredCore();
        let reading: Promise<void> | undefined;
        try {
          await projection.ensureMaterialized();
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
          // A fresh identity has no warmed ACP receipt and must enter the held read.
          replaceSessionEntrySync(scope, { sessionId: "late-facts", updatedAt: 1 });
          sessionChanges.emit(scope);
          reading = projection.ensureMaterialized();
          await Promise.race([
            captured.promise,
            reading.then(() => {
              throw new Error("Drain bypassed the pending ACP read");
            }),
          ]);
          const row = projection.findBySessionId({ agentId: "main", sessionId: "late-facts" })[0]!;
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
        }
      }, true);
    },
  );

  it("lets keyed reads supersede accepted archive facts after a same-generation publication", async () => {
    await withAcceptedSuffix(
      async ({ projection, suffix, scope, query, entry, resume }) => {
        const label = "current archive";
        expect(isColdArchivedSessionRow(suffix)).toBe(false);
        // Equal timestamps still require the keyed reader to consume the owner's newer publication.
        replaceSessionEntrySync(scope, { ...entry, label });
        const pending = withReadySessionRows(
          projection,
          () => [query],
          (read) => read.describe(query)!,
        );
        await resume();
        const current = await pending;
        expect(current.generation).toBe(suffix.generation);
        expect(current.entry).toMatchObject({ updatedAt: entry.updatedAt, label });
        expect(isColdArchivedSessionRow(current)).toBe(false);
        expect(current.materialized.row.label).toBe(label);
      },
      { archived: true },
    );
  });

  it("discards invalidated presentation facts after custody release", async () => {
    await withAcceptedSuffix(async ({ projection, scope, query, entry, reads, resume }) => {
      const emit = sessionChanges.emit.bind(sessionChanges);
      vi.spyOn(sessionChanges, "emit").mockImplementation((publication, database) => {
        if ("sessionKey" in publication && publication.sessionKey === query.key) {
          emit({ all: true, scope: "profiles", factsInvalidated: true }, database);
          return;
        }
        emit(publication, database);
      });
      replaceSessionEntrySync(scope, { ...entry, label: "current value" });
      await resume();
      expect(reads.length).toBeGreaterThan(1);
      expect(projection.snapshot(query).row?.label).toBe("current value");
    });
  });

  it.each(["runtime activity", "membership revocation"] as const)(
    "presents current %s after accepting a shared suffix",
    async (change) => {
      await withAcceptedSuffix(
        async ({ projection, suffix, scope, query, entry, reads, viewerId, resume }) => {
          const runId = "accepted-suffix-current-run";
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
              expect(sharedFactReads(sharedReads)).toEqual([]);
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

  it.each(["delete", "store replacement"] as const)(
    "does not render the accepted suffix after %s",
    async (change) => {
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
          }
          await resume();
          expect(projection.isCurrent(suffix)).toBe(false);
          expect(projection.snapshot(query).row?.label ?? null).toBe(
            change === "store replacement" ? "replacement store" : null,
          );
        },
        { replacement: change === "store replacement" },
      );
    },
  );
});
