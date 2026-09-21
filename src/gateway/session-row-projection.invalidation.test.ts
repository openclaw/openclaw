import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as agentIdentity from "../agents/identity.js";
import * as catalogLookup from "../agents/model-catalog-lookup.js";
import {
  assignSessionOwner,
  loadSessionEntry,
  recordSessionParticipant,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  readCommittedSessionEntryCache,
  readSessionEntryCache,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import {
  createLifecycleArtifactReclamationPlan,
  createSessionMaintenanceFinalizationOperation,
  runSqliteSessionReclamation,
} from "../config/sessions/session-accessor.sqlite-reclamation.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail, linkEmail, setDisplayName } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as projectionWork from "./session-projection-work.js";
import * as materialization from "./session-row-projection-materialize.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => vi.restoreAllMocks());

it.each(["maintenance-finalize", "lifecycle-artifacts"] as const)(
  "publishes %s removals before row listeners recreate the key",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { list: [{ id: "main", default: true }] } };
      const scope = { agentId: "main", sessionKey: "agent:main:publication-reentry" };
      replaceSessionEntrySync(scope, { sessionId: "removed", updatedAt: Date.now() });
      const databaseOptions = { agentId: "main", env: state.env };
      const database = openOpenClawAgentDatabase(databaseOptions);
      readSessionEntryCache(database, { cache: true });
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      await listProjectedSessions({ projection, opts: {} });
      const entries = [{ sessionKey: scope.sessionKey, expectedEntry: loadSessionEntry(scope) }];
      const params = { agentId: "main", databaseOptions, entries, materializedPlans: [] };
      const plan =
        kind === "maintenance-finalize"
          ? createSessionMaintenanceFinalizationOperation(params)
          : createLifecycleArtifactReclamationPlan(params);
      const identities: string[] = [];
      const removalState: Array<{ cachedId?: string; storedId?: string }> = [];
      const callbackErrors: unknown[] = [];
      const stopIdentity = onSessionIdentityMutation((event) => {
        try {
          if (event.kind === "delete" && event.previous.sessionKeys.includes(scope.sessionKey)) {
            identities.push(`delete:${event.previous.sessionId}`);
            removalState.push({
              cachedId: readCommittedSessionEntryCache(database.db)?.get(scope.sessionKey)
                ?.sessionId,
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
  },
);

it.each([
  "profiles",
  "agent-runs",
  "subagent-runs",
  "worker-environments",
  "worker-placements",
  "sessions",
])(
  "serves concurrent lists after broad %s changes without a session-entry drain",
  async (scope) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {
        agents: { list: [{ id: "main", default: true }], defaults: { model: "unit-test/model" } },
      };
      const count = 256;
      for (let index = 0; index < count + 8; index++) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: `agent:main:row-${index}` },
          {
            sessionId: `row-${index}`,
            updatedAt: index < count ? index + 2 : 1,
            ...(index >= count ? { archivedAt: 1 } : {}),
          },
        );
      }
      const release = projectionWork.retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({
        cfg,
        modelCatalog: [{ provider: "unit-test", id: "model", name: "Model" }],
      });
      const opts = { limit: 20, archived: "all", search: "unit-test/model" } as const;
      const drain = createDeferredCore();
      try {
        await listProjectedSessions({ projection, opts });
        const catalogReads = vi.spyOn(catalogLookup, "findModelCatalogEntry");
        await listProjectedSessions({ projection, opts });
        const warmCatalogLookups = catalogReads.mock.calls.length;
        catalogReads.mockClear();
        const reads = vi.spyOn(materialization, "readSessionRowEntry");
        vi.spyOn(projectionWork, "yieldSessionListWork").mockReturnValue(drain.promise);
        sessionChanges.emit({ all: true, scope });
        const lists = Promise.all(
          Array.from({ length: 8 }, () => listProjectedSessions({ projection, opts })),
        );
        const result = await Promise.race([lists, nextTurn().then(() => undefined)]);
        expect(result?.map((list) => list.count)).toEqual(Array.from({ length: 8 }, () => 20));
        expect(reads).not.toHaveBeenCalled();
        // Presentation changes must not add catalog work beyond the warm request's defaults.
        expect(catalogReads.mock.calls.length).toBeLessThanOrEqual(warmCatalogLookups * 8);
        expect(projection.dirtyRowCount).toBe(0);
      } finally {
        drain.resolve();
        await projection.ensureMaterialized();
        projection.dispose();
        release();
      }
    });
  },
);

it("refreshes profile display fields on selected live and archived rows without rereading entries", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const owner = ensureProfileForEmail("owner@example.com");
    const participant = ensureProfileForEmail("participant@example.com");
    for (const archived of [false, true]) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:profile-${archived}` },
        {
          sessionId: `profile-${archived}`,
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: owner.id },
          ...(archived
            ? { archivedAt: 1, archivedBy: { type: "human" as const, id: owner.id } }
            : {}),
        },
      );
    }
    for (const archived of [false, true]) {
      recordSessionParticipant(
        { agentId: "main", sessionKey: `agent:main:profile-${archived}` },
        { identity: { type: "profile", id: participant.id }, promptedAt: 1 },
      );
    }
    const release = projectionWork.retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      await listProjectedSessions({ projection, opts: { archived: "all", includePeople: true } });
      const reads = vi.spyOn(materialization, "readSessionRowEntry");
      setDisplayName(owner.id, "Current owner");
      setDisplayName(participant.id, "Current participant");
      const result = await listProjectedSessions({
        projection,
        opts: { archived: "all", includePeople: true },
      });
      expect(result.owners?.map((actor) => actor.label)).toEqual(["Current owner"]);
      expect(result.people).toEqual([
        expect.objectContaining({
          identity: { type: "profile", id: owner.id },
          label: "Current owner",
          sessionCount: 2,
        }),
        expect.objectContaining({
          identity: { type: "profile", id: participant.id },
          label: "Current participant",
          sessionCount: 2,
        }),
      ]);
      expect(result.sessions).toHaveLength(2);
      for (const row of result.sessions) {
        expect(row.createdActor?.label).toBe("Current owner");
        expect(row.owner?.actor.label).toBe("Current owner");
        expect(row.participants).toEqual([
          expect.objectContaining({ label: "Current participant" }),
        ]);
        if (row.archived) {
          expect(row.archivedBy?.label).toBe("Current owner");
        }
      }
      expect(reads).not.toHaveBeenCalled();
      linkEmail("participant@example.com", owner.id);
      const merged = await listProjectedSessions({
        projection,
        opts: {
          archived: "all",
          includePeople: true,
          profileRelation: { profileId: participant.id, relationship: "involving" },
        },
      });
      expect(merged.sessions).toHaveLength(2);
      expect(merged.people).toEqual([
        expect.objectContaining({
          identity: { type: "profile", id: owner.id },
          label: "Current owner",
          sessionCount: 2,
        }),
      ]);
      expect(merged.sessions.every((row) => row.participants === undefined)).toBe(true);
      expect(reads).not.toHaveBeenCalled();
    } finally {
      projection.dispose();
      release();
    }
  });
});

it("reuses row identities across lists until their entry, profile, or config changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: {
        entries: { main: { identity: { name: "Original agent" } } },
      },
    };
    const scope = { agentId: "main", sessionKey: "agent:main:identity-cache" };
    const entry = {
      sessionId: "identity-cache",
      updatedAt: 1,
      createdActor: { type: "agent" as const, id: "main" },
    };
    replaceSessionEntrySync(scope, entry);
    recordSessionParticipant(scope, { identity: { type: "agent", id: "main" } });
    const release = projectionWork.retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const list = () => listProjectedSessions({ projection, opts: {} });
    try {
      await list();
      const identities = vi.spyOn(agentIdentity, "resolveAgentIdentity");
      for (let index = 0; index < 3; index++) {
        expect((await list()).sessions[0]?.owner?.actor.label).toBe("Original agent");
      }
      expect(identities).not.toHaveBeenCalled();

      sessionChanges.emit({ all: true, scope: "profiles" });
      await list();
      expect(identities).toHaveBeenCalledTimes(3);
      identities.mockClear();
      await list();
      expect(identities).not.toHaveBeenCalled();

      cfg.agents.entries.main.identity.name = "Renamed agent";
      sessionChanges.emit({ all: true, scope: "config" });
      expect((await list()).owners?.[0]?.label).toBe("Renamed agent");
      assignSessionOwner(scope, {
        owner: { type: "agent", id: "missing" },
        assignedBy: { type: "system", id: "test" },
      });
      const unassigned = await list();
      expect(unassigned.owners).toEqual([]);
      expect(unassigned.sessions[0]?.owner).toBeUndefined();
      expect(unassigned.sessions[0]?.participants?.[0]?.label).toBe("Renamed agent");
      assignSessionOwner(scope, {
        owner: { type: "agent", id: "main" },
        assignedBy: { type: "system", id: "test" },
      });
      expect((await list()).sessions[0]?.owner?.actor.label).toBe("Renamed agent");
    } finally {
      await projection.ensureMaterialized();
      projection.dispose();
      release();
    }
  });
});
