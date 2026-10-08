import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  assignSessionOwner,
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  readCommittedSessionEntryCache,
  readSessionEntryCache,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { runSqliteSessionReclamation } from "../config/sessions/session-accessor.sqlite-reclamation-run.js";
import { createSessionMaintenanceFinalizationOperation } from "../config/sessions/session-accessor.sqlite-reclamation.js";
import { applySessionEntryExactReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
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
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as projectionWork from "./session-projection-work.js";
import * as materialization from "./session-row-projection-materialize.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => vi.restoreAllMocks());

it.each(["native", "worker"] as const)(
  "retains assigned owner and participants before observers after a %s metadata write",
  async (writer) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
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
        const publishedSource = projection.capture(query)?.publishedSource;
        expect(publishedSource).toBeDefined();
        const sql = observeHostDataSql();
        try {
          sessionChanges.emit({ agentId: scope.agentId, sessionKey: scope.sessionKey });
          expect(projection.dirtyRowCount).toBeGreaterThan(0);
          expect(projection.sharingTarget(query)?.entry).toMatchObject(expected);
          expect(projection.capture(query)?.publishedSource).toBe(publishedSource);
          sessionChanges.emit({
            ...scope,
            storePath: warm!.storeTarget.storePath,
            facts: { kind: "unchanged" },
          });
          expect(projection.sharingTarget(query)?.entry).toMatchObject(expected);
          expect(projection.capture(query)?.publishedSource).toBe(publishedSource);
          // Participant persistence already published its compact facts before this notice.
          emitSessionLifecycleEvent({
            agentId: scope.agentId,
            sessionKey: scope.sessionKey,
            reason: "participants",
            scope: "session-entry",
          });
          expect(projection.sharingTarget(query)?.entry).toMatchObject(expected);
          expect(projection.capture(query)?.publishedSource).toBe(publishedSource);
          // Unknown storage changes still revoke compact facts until an exact refresh.
          sessionChanges.emit({ ...scope, storePath: warm!.storeTarget.storePath });
          expect(projection.sharingTarget(query)).toBeNull();
          expect(projection.capture(query)?.publishedSource).toBeUndefined();
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

it("keeps a captured row when another physical store resets the same key and session ID", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {
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
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
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
    } finally {
      projection.dispose();
    }
  });
});

it("invalidates a published row after an unprepared reset with the same session ID", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:unprepared-reset",
      storePath: database.path,
    };
    const entry = { sessionId: "same-session", lifecycleRevision: "original", updatedAt: 1 };
    replaceSessionEntrySync(scope, entry);
    const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
    const query = { agentId: scope.agentId, key: scope.sessionKey, storePath: scope.storePath };
    try {
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
    } finally {
      projection.dispose();
    }
  });
});

it("retains newer cached native metadata through reentrant identity publication", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const scope = { agentId: "main", sessionKey: "agent:main:identity-publication-reentry" };
    const updatedAt = Date.now();
    replaceSessionEntrySync(scope, { sessionId: "original", updatedAt });
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    readSessionEntryCache(database, { cache: true });
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const list = () => listProjectedSessions({ projection, opts: {} });
    let stopRows = () => {};
    try {
      await list();
      expect(Boolean(readCommittedSessionEntryCache(database.db))).toBe(true);
      const originalGeneration = projection.capture({
        agentId: scope.agentId,
        key: scope.sessionKey,
      })?.generation;
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
      const current = projection.capture({ agentId: scope.agentId, key: scope.sessionKey });
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
    const cfg = { agents: { entries: { main: {} } } };
    const scope = { agentId: "main", sessionKey: "agent:main:publication-reentry" };
    replaceSessionEntrySync(scope, { sessionId: "removed", updatedAt: Date.now() });
    const databaseOptions = { agentId: "main", env: state.env };
    const database = openOpenClawAgentDatabase(databaseOptions);
    readSessionEntryCache(database, { cache: true });
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    await listProjectedSessions({ projection, opts: {} });
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
            cachedId: readCommittedSessionEntryCache(database.db)?.get(scope.sessionKey)?.sessionId,
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
      expect(readCommittedSessionEntryCache(database.db)?.get(scope.sessionKey)?.sessionId).toBe(
        "removed",
      );
      await runSqliteSessionReclamation({ forceInProcess: false, plan, diagnostics });
      expect(diagnostics).toMatchObject({ workerThreadId: expect.any(Number) });
      expect(callbackErrors).toEqual([]);
      expect(identities).toEqual(["delete:removed", "create:replacement"]);
      expect(removalState).toEqual([{ cachedId: undefined, storedId: undefined }]);
      expect(loadSessionEntry(scope)?.sessionId).toBe("replacement");
      const result = await listProjectedSessions({ projection, opts: {} });
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
