import { symlinkSync } from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { withSessionCompactionPersistenceAsync } from "../agents/sessions/session-compaction-persistence.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  assignSessionOwner,
  loadSessionEntry,
  persistCompactionBoundaryWithSessionEntryAsync,
  replaceSessionEntrySync,
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
  emitSessionIdentityMutation,
  emitSessionLifecycleEvent,
  onSessionIdentityMutation,
} from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import * as databaseIdentity from "../state/openclaw-agent-db-identity.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as projectionWork from "./session-projection-work.js";
import { observeSessionRowBackfill } from "./session-row-backfill.test-support.js";
import { SessionRowFactsPending } from "./session-row-prepared-read.js";
import * as materialization from "./session-row-projection-materialize.js";
import { listRows } from "./session-row-projection-read-fixtures.test-support.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import {
  createTestProjection,
  watchRowFacts,
} from "./session-row-projection.read-fixture.test-support.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => vi.restoreAllMocks());
const cfg = { agents: { entries: { main: {} } } };

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
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
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
      const release = projectionWork.retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const query = { agentId: scope.agentId, key: scope.sessionKey };
      let stop = () => {};
      try {
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
              replacements: [
                { sessionKey: scope.sessionKey, entry: { ...row!.entry, ...updated } },
              ],
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
          sharedReads.mock.calls.filter(
            ([, command]) => command.type === "sessionRows.sharedFacts",
          ),
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
      } finally {
        stop();
        await projection.ensureMaterialized();
        projection.dispose();
        release();
      }
    });
  },
);

it("accepts alias publications while another physical store keeps its own row", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
    using projection = await createTestProjection({ cfg: globalConfig, modelCatalog: [] });

    await projection.ensureMaterialized();
    const captured = projection.capture(query);
    expect(captured).toBeDefined();
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
  });
});

it("invalidates a published row after an unprepared reset with the same session ID", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const entry = { sessionId: "same-session", lifecycleRevision: "original", updatedAt: 1 };
    const seeded = seedPublication("unprepared-reset", entry);
    const scope = { ...seeded.scope, storePath: database.path };
    using projection = await createTestProjection({ cfg: {}, modelCatalog: [] });
    const query = { ...seeded.query, storePath: scope.storePath };

    await projection.ensureMaterialized();
    replaceSessionEntrySync(scope, { ...entry, label: "Published metadata", updatedAt: 2 });
    const captured = projection.capture(query);
    const identity = databaseIdentity.readOpenClawAgentDatabaseIdentity(database).identity;
    expect(captured?.entry?.label).toBe("Published metadata");
    expect(captured?.publishedSource?.identity).toBe(identity);
    expect(projection.isCurrent(captured!)).toBe(true);

    // A raw reset does not prove whether the previously published lifecycle still applies.
    emitSessionIdentityMutation({
      kind: "reset",
      agentId: scope.agentId,
      databaseIdentity: identity,
      previous: { sessionId: entry.sessionId, sessionKeys: [scope.sessionKey] },
      current: { sessionId: entry.sessionId, sessionKeys: [scope.sessionKey] },
    });
    expect(projection.isCurrent(captured!)).toBe(false);
    const invalidated = projection.capture(query);
    expect(invalidated).toBeDefined();
    expect(invalidated?.generation).not.toBe(captured?.generation);
    expect(invalidated?.entry).toBeUndefined();

    await projection.ensureMaterialized();
    expect(projection.capture(query)?.entry?.sessionId).toBe(entry.sessionId);
    expect(projection.isCurrent(captured!)).toBe(false);
  });
});

it("retains newer cached native metadata through reentrant identity publication", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const updatedAt = Date.now();
    const { scope, query } = seedPublication("identity-publication-reentry", {
      sessionId: "original",
      updatedAt,
    });
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    readSessionEntryCache(database, { cache: true });
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const list = () => listRows(projection);
    let stopRows = () => {};
    try {
      await list();
      expect(
        Boolean(readCommittedSessionEntryCache(requireNativeSqliteDatabase(database.db))),
      ).toBe(true);
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
    } finally {
      stopRows();
      await projection.ensureMaterialized();
      projection.dispose();
    }
  });
});

it("publishes maintenance removals before row listeners recreate the key", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { scope } = seedPublication("publication-reentry", {
      sessionId: "removed",
      updatedAt: Date.now(),
    });
    const databaseOptions = { agentId: "main", env: state.env };
    const database = openOpenClawAgentDatabase(databaseOptions);
    readSessionEntryCache(database, { cache: true });
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
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
    try {
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
    } finally {
      stopRows();
      stopIdentity();
      await projection.ensureMaterialized();
      projection.dispose();
    }
  });
});

it("retains compaction display facts until a branch change requires a new tail", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot(cfg);
    const scope = {
      agentId: "main",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      sessionKey: "agent:main:compaction-display",
      sessionId: "compaction-display",
    };
    const query = { agentId: scope.agentId, key: scope.sessionKey };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(scope);
    const keptId = await manager.appendMessageAsync({
      role: "user",
      content: "Keep this request",
      timestamp: 1,
    });
    expect(keptId).toBeTypeOf("string");
    await manager.appendMessageAsync(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Keep this reply" }],
        timestamp: 2,
      }),
    );
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    await projection.ensureMaterialized();
    expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
      lastMessagePreview: "Keep this reply",
      lastAssistantMessage: { text: "Keep this reply" },
    });
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
    expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
      totalTokens: 45,
      lastMessagePreview: "Keep this reply",
      lastAssistantMessage: { text: "Keep this reply" },
    });
    expect(projection.capture(query)?.entry?.compactionCount).toBe(1);
    expect(reads).toEqual([]);
    expect(backfill).not.toHaveBeenCalled();

    await manager.appendMessageAsync(
      makeAgentAssistantMessage({ content: [{ type: "text", text: "New reply" }], timestamp: 3 }),
    );
    await compact();
    await projection.ensureMaterialized();
    await nextTurn();
    expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
      lastMessagePreview: "New reply",
      lastAssistantMessage: { text: "New reply" },
    });
    expect(reads).toEqual([]);
    expect(backfill).not.toHaveBeenCalled();

    await manager.branchAsync(keptId!);
    const changedBranch = observeSessionRowBackfill([scope.sessionKey], projection, (row) =>
      row.lastMessagePreview === "Keep this request" && !row.lastAssistantMessage ? row.key : "",
    );
    await compact();
    await projection.ensureMaterialized();
    await withinTest(changedBranch, signal);
    expect(projection.snapshot(query, { includeLastMessage: true }).row?.lastMessagePreview).toBe(
      "Keep this request",
    );
    expect(
      projection.snapshot(query, { includeLastMessage: true }).row?.lastAssistantMessage,
    ).toBeUndefined();
    expect(backfill).toHaveBeenCalled();
  });
});
