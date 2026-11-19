import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentSessionListReadSnapshotIdentity,
  prepareSubagentSessionListReadCache,
} from "../agents/subagents/registry/subagent-registry-state.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { ACTIVITY_SUMMARY_FORMAT_REVISION } from "../config/sessions/activity-summary.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  persistSessionTranscriptTurn,
  readSessionTranscriptWatermark,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { SessionRowDatabaseFacts } from "../config/sessions/session-row-facts.types.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.native.js";
import type { InternalSessionEntry, SessionAcpMeta } from "../config/sessions/types.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { setSessionActivitySummaryState } from "./session-activity-summary-state.js";
import * as projectionWork from "./session-projection-work.js";
import * as databaseFactsRead from "./session-row-database-facts.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { isColdArchivedSessionRow } from "./session-row-projection-archive.js";
import { ready, type Row } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import * as rowFixture from "./session-row-projection.read-fixture.test-support.js";
import { withSessionRowProjectionState } from "./session-row-projection.test-support.js";
import * as rowInputs from "./session-utils-row.js";

/** Pause after the real worker read scope has released its request hold. */
export async function withAcceptedSuffix(
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
    legacyAcp?: true;
  } = {},
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {
      agents: { entries: { main: {} }, defaults: { utilityModel: "unit-test/small" } },
    };
    setRuntimeConfigSnapshot(cfg);
    const keys = [
      "agent:main:accepted-a",
      options.acpMeta === undefined ? "agent:main:accepted-b" : "agent:main:acp:accepted-b",
    ];
    const query = { agentId: "main", key: keys[1]! };
    const scope = { agentId: query.agentId, sessionKey: query.key };
    const [profileOwner, viewer] = options.membership
      ? ["owner", "viewer"].map((name) => ensureProfileForEmail(`accepted-${name}@example.test`))
      : [];
    const entries = keys.map<InternalSessionEntry>((_key, index) => ({
      sessionId: `accepted-${index}`,
      updatedAt: 1,
      label: `initial-${index}`,
    }));
    const suffixEntry = entries[1]!;
    if (options.acpMeta !== undefined) {
      suffixEntry.lifecycleRevision = "accepted-lifecycle";
    }
    if (options.archived) {
      suffixEntry.archivedAt = 1;
    }
    if (profileOwner) {
      suffixEntry.visibility = "read-only";
      suffixEntry.createdActor = { type: "human", source: "profile", id: profileOwner.id };
    }
    for (const [index, sessionKey] of keys.entries()) {
      rowFixture.seedRow(sessionKey, entries[index]!);
    }
    if (options.acpMeta) {
      seedCanonicalAcpSessionMeta({
        sessionKey: keys[1]!,
        sessionId: suffixEntry.sessionId,
        lifecycleRevision: options.legacyAcp ? undefined : "accepted-lifecycle",
        meta: options.acpMeta,
        now: () => 1,
      });
    }
    if (profileOwner && viewer) {
      addSessionMember(scope, { identityId: viewer.id, addedBy: profileOwner.id, addedAt: 1 });
    }
    const replacementPath = state.statePath("imports", "accepted-replacement.sqlite");
    if (options.replacement) {
      replaceSessionEntrySync(
        { ...scope, storePath: replacementPath },
        { ...suffixEntry, updatedAt: 2, label: "replacement store" },
      );
      await closeOpenClawAgentDatabaseByPathAsync(replacementPath, "main");
    }
    using _ = rowFixture.holdForeground();
    using projection = await rowFixture.createTestProjection({ cfg, modelCatalog: [] });
    const paused = createDeferredCore();
    const release = createDeferredCore();
    let reading: Promise<void> | undefined;
    try {
      await projection.ensureMaterialized();
      const previous = await withReadySessionRows(
        projection,
        () => keys.map((key) => ({ agentId: "main", key })),
        (read) => read.describe(query)!,
      );
      const count = projection.materializedCount;
      let releases = 0;
      let trackingCustody = false;
      const reads: SessionRowDatabaseFacts[][] = [];
      const databases = rowFixture.watchRowFacts((owner) => async (input) => {
        const reply = await owner.readRowFacts(input);
        reads.push(structuredClone(reply.rows));
        return reply;
      });
      const readDatabases = databases.getMockImplementation()!;
      databases.mockImplementation(async (...args) => {
        const tracked = trackingCustody;
        const result = await readDatabases(...args);
        releases += tracked ? 1 : 0;
        return result;
      });
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
      const acceptedEntries = entries.map((entry, index) =>
        Object.assign({}, entry, { updatedAt: 2, label: `accepted-${index}` }),
      );
      for (const [index, sessionKey] of keys.entries()) {
        rowFixture.seedRow(sessionKey, acceptedEntries[index]!);
        sessionChanges.emit({
          agentId: "main",
          storePath: previous.storeTarget.storePath,
          sessionKey,
          factsInvalidated: true,
        });
      }
      reading = projection.ensureMaterialized();
      await awaitGateBeforeSettlement(
        paused.promise,
        reading,
        "Drain bypassed the released-custody boundary",
      );
      expect(releases).toBe(1);
      const suffix = projection.findBySessionId({
        agentId: "main",
        sessionId: suffixEntry.sessionId,
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
        viewerId: viewer?.id,
        scope,
        entry: acceptedEntries[1]!,
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
    }
  });
}

/** Register in the caller's describe so its mock and state cleanup owns these races. */
export function registerAcceptedSuffixRaceTests(
  writeTranscript: (
    scope: Parameters<typeof persistSessionTranscriptTurn>[0],
    role: "user" | "assistant",
    content: string,
    options?: Omit<Parameters<typeof persistSessionTranscriptTurn>[1], "messages">,
  ) => ReturnType<typeof persistSessionTranscriptTurn>,
) {
  function activitySummary(
    sessionId: string,
    text: string,
    watermark: ReturnType<typeof readSessionTranscriptWatermark>,
    updatedAt: number,
    extra: Partial<NonNullable<InternalSessionEntry["activitySummary"]>> = {},
  ): NonNullable<InternalSessionEntry["activitySummary"]> {
    return {
      version: 1,
      formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION,
      text,
      updatedAt,
      sessionId,
      ...watermark,
      leafEntryId: null,
      coveredMessages: 1,
      totalMessages: 1,
      omittedContent: false,
      ...extra,
    };
  }

  it.each(["overlapping pinned pages", "transcript-only invalidation"] as const)(
    "handles an exact cold archive suffix during %s",
    async (mode) => {
      await withSessionRowProjectionState(
        async (create) => {
          const transcriptOnly = mode === "transcript-only invalidation";
          const cfg = {
            agents: {
              entries: { main: {}, ...(!transcriptOnly && { "zz-archive-pin": {} }) },
              defaults: { utilityModel: "unit-test/small" },
            },
          };
          setRuntimeConfigSnapshot(cfg);
          clearSubagentRunsReadCacheForTest();
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
          // Keep the held store after main when the owner groups reads by store identity.
          const pinnedQuery = {
            agentId: "zz-archive-pin",
            key: "agent:zz-archive-pin:awaiting-page",
          };
          if (!transcriptOnly) {
            replaceSessionEntrySync(
              { agentId: pinnedQuery.agentId, sessionKey: pinnedQuery.key },
              { sessionId: "awaiting-archive-page", updatedAt: 1, archivedAt: 1 },
            );
          }
          const firstPageQueries = transcriptOnly
            ? queries.slice(0, 2)
            : [...queries.slice(0, 2), pinnedQuery];
          const suffixScope = {
            agentId: "main",
            sessionKey: queries[1]!.key,
            sessionId: entries[1]!.sessionId,
          };
          if (transcriptOnly) {
            await writeTranscript(suffixScope, "user", "Summarized transcript", {
              config: cfg,
              touchSessionEntry: false,
              updateMode: "none",
            });
            const watermark = readSessionTranscriptWatermark(suffixScope);
            entries[1] = {
              ...entries[1]!,
              activitySummary: activitySummary(
                suffixScope.sessionId,
                "Stored archive summary",
                watermark,
                1,
              ),
            };
            replaceSessionEntrySync(suffixScope, entries[1]);
          }
          const releaseBulk = createDeferredCore();
          const registryPending = createDeferredCore();
          const releaseRegistry = createDeferredCore();
          const accepted = createDeferredCore();
          const releaseExact = createDeferredCore();
          const pinnedReadEntered = createDeferredCore();
          const releasePinnedRead = createDeferredCore();
          const suffixReady = createDeferredCore();
          let holdBulk = false;
          const createDrain = projectionWork.createSessionProjectionDrain;
          vi.spyOn(projectionWork, "createSessionProjectionDrain").mockImplementationOnce(
            (params) =>
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
          const projection = await create({ cfg, modelCatalog: [] });
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
            releaseRegistry.resolve();
            await recovery;
            await projection.prepareSelection({ metadataOnly: true });
            expect(
              projection
                .selectEntries({}, true)
                .filter((row) => queries.slice(0, 2).some((query) => query.key === row.key))
                .map((row) => row.entry.updatedAt),
            ).toEqual([2, 2]);
            rowFixture.watchRowFacts((owner) => async (input) => {
              const result = await owner.readRowFacts(input);
              if (input.sessionKeys.includes(pinnedQuery.key)) {
                pinnedReadEntered.resolve();
                await releasePinnedRead.promise;
              }
              return result;
            });
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
              () => firstPageQueries,
              (read) => firstPageQueries.map((query) => read.describe(query)!.key),
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
            if (transcriptOnly) {
              const previousWatermark = suffix.pendingDatabaseFacts!.activitySummaryWatermark;
              expect(previousWatermark).toMatchObject({
                generation: entries[1]!.activitySummary!.generation,
                maxSeq: entries[1]!.activitySummary!.maxSeq,
              });
              const publications: unknown[] = [];
              const unsubscribe = sessionChanges.subscribe((change) => publications.push(change));
              try {
                await writeTranscript(suffixScope, "user", "New archived transcript", {
                  config: cfg,
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
              return;
            }
            holdBulk = false;
            releaseBulk.resolve();
            bulk = projection.ensureMaterialized();
            projection.onFactsChange((change) => {
              if (change.kind === "row" && change.key === queries[1]!.key && ready(suffix)) {
                suffixReady.resolve();
              }
            });
            releaseExact.resolve();
            await Promise.all([suffixReady.promise, pinnedReadEntered.promise]);
            expect(ready(suffix)).toBe(true);
            expect(suffix.pendingDatabaseFacts).toBeUndefined();
            inputs.mockRestore();
            clock.mockRestore();
            await withReadySessionRows(
              projection,
              () => queries.slice(2),
              () => {
                expect(projection.selectEntries().filter(ready)).toHaveLength(102);
              },
            );
            // The first page retains its ready rows while its other physical store is pending.
            // Releasing the other page trims through the real LRU without evicting those pins.
            expect(projection.selectEntries().filter(ready)).toHaveLength(100);
            const residentKeys = new Set(
              projection
                .selectEntries()
                .filter(ready)
                .map((row) => row.key),
            );
            expect(queries.slice(0, 2).every((query) => residentKeys.has(query.key))).toBe(true);
            releasePinnedRead.resolve();
            expect(await page).toEqual(firstPageQueries.map((query) => query.key));
            await bulk;
          } finally {
            holdBulk = false;
            releaseRegistry.resolve();
            releaseExact.resolve();
            releasePinnedRead.resolve();
            releaseBulk.resolve();
            await Promise.allSettled([recovery, page, bulk, projection.ensureMaterialized()]);
          }
        },
        true,
        { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      );
    },
  );

  it("refreshes activity state independently of queued materialization and category preparation", async () => {
    await withAcceptedSuffix(async ({ projection, scope, query, entry, resume }) => {
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

        for (const state of ["updating", "unavailable", undefined] as const) {
          // Automation queues a refresh without changing the accepted database facts.
          sessionChanges.emit({ ...scope, scope: "automation" });
          setSessionActivitySummaryState(target, owner, state && { ...value, state });
          await projection.ensureMaterialized();
          expect(projection.snapshot(query).row?.activitySummary?.state).toBe(state ?? "stale");
        }

        // Category uncertainty blocks presentation, but equal reconciliation can reuse these facts.
        sessionChanges.emit({ sessionKey: query.key, factsInvalidated: "category" });
        expect(ready(projection.capture(query))).toBe(false);
        setSessionActivitySummaryState(target, owner, value);
        await projection.ensureMaterialized();
        expect(projection.snapshot(query).row?.activitySummary?.state).toBe("updating");
      } finally {
        setSessionActivitySummaryState(target, owner);
      }
    });
  });

  it("retries presentation with retained accepted database facts", async () => {
    await withAcceptedSuffix(
      async ({ projection, suffix, query, reads, resume, failNextRender }) => {
        failNextRender();
        await expect(resume()).rejects.toThrow("presentation unavailable");
        expect(ready(suffix)).toBe(false);
        await projection.ensureMaterialized();
        expect(reads).toHaveLength(1);
        expect(projection.snapshot(query).row?.label).toBe("accepted-1");
      },
    );
  });
}
