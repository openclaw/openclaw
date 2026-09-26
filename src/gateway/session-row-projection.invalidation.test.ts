import { renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
  prepareRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import * as agentIdentity from "../agents/identity.js";
import * as catalogLookup from "../agents/model-catalog-lookup.js";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import {
  getRuntimeConfigSnapshotMetadata,
  getRuntimeConfigSourceSnapshot,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSourceSnapshotIfCurrent,
} from "../config/runtime-snapshot.js";
import {
  assignSessionOwner,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  readCommittedSessionEntryCache,
  readSessionEntryCache,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import {
  createLifecycleArtifactReclamationPlan,
  createSessionMaintenanceFinalizationOperation,
  runSqliteSessionReclamation,
} from "../config/sessions/session-accessor.sqlite-reclamation.js";
import * as transcriptWorker from "../config/sessions/session-transcript-worker-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotRevisionState,
  setSecretsRuntimeSourceSnapshotIfCurrent,
} from "../secrets/runtime-state.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as databaseIdentity from "../state/openclaw-agent-db-identity.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail, linkEmail, setDisplayName } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import * as projectionWork from "./session-projection-work.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import * as materialization from "./session-row-projection-materialize.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => vi.restoreAllMocks());

it("reuses descendants after parent progress while keeping inherited models current", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    const cfg = {
      agents: {
        list: [{ id: "main", default: true }],
        defaults: { model: "unit-test/default" },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const parentKey = "agent:main:discord:channel:parent";
    const children = ["agent:main:child", `${parentKey}:thread:child`];
    const siblingKey = "agent:main:sibling";
    const scope = { agentId: "main", sessionKey: parentKey };
    const parent: SessionEntry = {
      sessionId: "parent",
      updatedAt: 1,
      visibility: "shared",
      providerOverride: "unit-test",
      modelOverride: "selected",
      modelOverrideSource: "user",
    };
    replaceSessionEntrySync(scope, { ...parent });
    for (const [index, sessionKey] of [...children, siblingKey].entries()) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        {
          sessionId: `child-${index}`,
          updatedAt: index + 2,
          visibility: "shared",
          ...(sessionKey === children[0] ? { parentSessionKey: parentKey } : {}),
        },
      );
    }
    const release = projectionWork.retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const client = identifiedClient("viewer");
    const list = () => listSessions({ context, client, request: {} });
    const sequence = (key: string) =>
      projection.capture({ agentId: "main", key })?.materializedSequence;
    try {
      const initial = await list();
      expect(initial.totalCount).toBe(4);
      expect(initial.sessions.map((row) => row.key)).toEqual([
        siblingKey,
        children[1],
        children[0],
        parentKey,
      ]);
      expect(initial.sessions.find((row) => row.key === parentKey)?.childSessions).toEqual([
        children[0],
      ]);
      const reads: string[] = [];
      const readDatabases = transcriptWorker.withSessionHistoryWorkerDatabases;
      vi.spyOn(transcriptWorker, "withSessionHistoryWorkerDatabases").mockImplementation(
        (targets, consume) =>
          readDatabases(targets, (owners) =>
            consume(
              owners.map((owner) => ({
                ...owner,
                readRowFacts(input) {
                  reads.push(...input.sessionKeys);
                  return owner.readRowFacts(input);
                },
              })),
            ),
          ),
      );
      const original = children.map(sequence);
      const siblingSequence = sequence(siblingKey);
      for (const change of [undefined, { label: "Updated parent", updatedAt: 10 }]) {
        if (change) {
          Object.assign(parent, change);
          replaceSessionEntrySync(scope, { ...parent });
        } else {
          sessionChanges.emit(scope);
        }
        await list();
        expect(children.map(sequence)).toEqual(original);
      }
      const cases: Array<{ change: Partial<SessionEntry>; provider: string; model: string }> = [
        { change: { providerOverride: "other-test" }, provider: "other-test", model: "selected" },
        { change: { modelOverride: "changed" }, provider: "other-test", model: "changed" },
        { change: { modelOverrideSource: "default" }, provider: "unit-test", model: "default" },
        {
          change: {
            modelOverrideSource: "auto",
            modelOverrideFallbackOriginProvider: "other-test",
            modelOverrideFallbackOriginModel: "changed",
          },
          provider: "other-test",
          model: "changed",
        },
        {
          change: { modelOverrideFallbackOriginModel: "original" },
          provider: "unit-test",
          model: "default",
        },
        {
          change: {
            modelOverrideFallbackOriginModel: "changed",
            modelOverrideFallbackOriginProvider: "original-test",
          },
          provider: "unit-test",
          model: "default",
        },
      ];
      for (const { change, provider, model } of cases) {
        reads.length = 0;
        Object.assign(parent, change);
        replaceSessionEntrySync(scope, { ...parent });
        const result = await list();
        for (const key of children) {
          expect(result.sessions.find((row) => row.key === key)).toMatchObject({
            modelProvider: provider,
            model,
          });
        }
        expect(sequence(siblingKey)).toBe(siblingSequence);
        expect.soft(reads, `Stored facts after ${JSON.stringify(change)}`).toEqual([parentKey]);
      }
      parent.modelOverrideSource = "user";
      replaceSessionEntrySync(scope, { ...parent });
      const pinned = await list();
      for (const key of children) {
        expect(pinned.sessions.find((row) => row.key === key)?.model).toBe("changed");
      }
      const childScope = { agentId: "main", sessionKey: children[0]! };
      reads.length = 0;
      replaceSessionEntrySync(childScope, {
        ...loadSessionEntry(childScope)!,
        parentSessionKey: siblingKey,
      });
      const moved = await list();
      expect(moved.totalCount).toBe(4);
      expect(moved.sessions.find((row) => row.key === parentKey)?.childSessions).toBeUndefined();
      expect(moved.sessions.find((row) => row.key === siblingKey)?.childSessions).toEqual([
        children[0],
      ]);
      expect(moved.sessions.find((row) => row.key === children[0])?.model).toBe("default");
      expect.soft(reads, "Unchanged parents after a child moves").toEqual([childScope.sessionKey]);
      reads.length = 0;
      await deleteSessionEntryLifecycle({
        ...scope,
        storePath: projection.capture({ agentId: "main", key: parentKey })!.storeTarget.storePath,
        archiveTranscript: false,
        target: { canonicalKey: parentKey, storeKeys: [parentKey] },
      });
      const deleted = await list();
      expect(deleted.sessions.some((row) => row.key === parentKey)).toBe(false);
      expect(deleted.sessions.filter((row) => children.includes(row.key))).toEqual(
        expect.arrayContaining(
          children.map((key) => expect.objectContaining({ key, model: "default" })),
        ),
      );
      expect.soft(reads, "Unchanged descendants after parent deletion").toEqual([]);
    } finally {
      await projection.ensureMaterialized();
      projection.dispose();
      release();
    }
  });
});

it("keeps a captured row when another physical store resets the same key and session ID", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
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

it("hydrates a same-path replacement with a reused inode and retires its previous inventory", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const staged = state.statePath("imports", "replacement.sqlite");
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      session: { store: storePath },
    };
    replaceSessionEntrySync(
      { agentId: "main", storePath, sessionKey: "agent:main:old" },
      { sessionId: "old", updatedAt: 1, category: "old group" },
    );
    replaceSessionEntrySync(
      { agentId: "main", storePath: staged, sessionKey: "agent:main:new" },
      { sessionId: "new", updatedAt: 2, category: "new group" },
    );
    await closeOpenClawAgentDatabaseByPathAsync(staged, "main");
    const projection = await createSessionRowProjection({ cfg });
    await projection.ensureMaterialized();
    try {
      const readIdentity = databaseIdentity.readOpenClawAgentDatabaseIdentity;
      const previousIdentity = readIdentity(
        openOpenClawAgentDatabase({ agentId: "main", path: storePath }),
      );
      const reusedIdentity = previousIdentity.identity;
      if (typeof reusedIdentity !== "string") {
        throw new Error("Expected a persistent fixture database identity");
      }
      expect([...projection.sessionGroupTargets().keys()]).toEqual(["old group"]);
      await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
      renameSync(staged, storePath);
      registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
      const replacementIdentity = readIdentity(
        openOpenClawAgentDatabase({ agentId: "main", path: storePath }),
      );
      // Coarse filesystem clocks must not determine whether the inode-reuse case is covered.
      const replacementBirthtime =
        replacementIdentity.birthtime === previousIdentity.birthtime
          ? (BigInt(previousIdentity.birthtime ?? "0") + 1n).toString()
          : replacementIdentity.birthtime;
      const identity = vi
        .spyOn(databaseIdentity, "readOpenClawAgentDatabaseIdentity")
        .mockImplementation((database) => {
          const prepared = readIdentity(database);
          return prepared.filename === replacementIdentity.filename
            ? { ...prepared, identity: reusedIdentity, birthtime: replacementBirthtime }
            : prepared;
        });
      const readDatabases = transcriptWorker.withSessionHistoryWorkerDatabases;
      // Both observations must describe the same simulated inode reuse.
      const workerIdentity = vi
        .spyOn(transcriptWorker, "withSessionHistoryWorkerDatabases")
        .mockImplementation((targets, consume) =>
          readDatabases(targets, (owners) =>
            consume(
              owners.map((owner) => ({
                ...owner,
                async readMembershipFacts(input) {
                  const reply = await owner.readMembershipFacts(input);
                  return reply.identity === replacementIdentity.identity &&
                    reply.birthtime === replacementIdentity.birthtime
                    ? {
                        ...reply,
                        identity: reusedIdentity,
                        birthtime: replacementBirthtime,
                      }
                    : reply;
                },
              })),
            ),
          ),
        );
      try {
        await withReadySessionRows(
          projection,
          () => [{ agentId: "main", key: "agent:main:new" }],
          (read) => {
            expect(read.describe({ agentId: "main", key: "agent:main:new" })?.entry.sessionId).toBe(
              "new",
            );
            expect(projection.selectEntries().map((row) => row.key)).toEqual(["agent:main:new"]);
          },
        );
        await projection.ensureMaterialized();
        expect(projection.selectEntries().map((row) => row.key)).toEqual(["agent:main:new"]);
        expect([...projection.sessionGroupTargets()]).toEqual([
          ["new group", [{ sessionKey: "agent:main:new", agentId: "main" }]],
        ]);
        const sql = vi.spyOn(DatabaseSync.prototype, "prepare");
        try {
          expect(projection.snapshot({ agentId: "main", key: "agent:main:old" }).row).toBeNull();
          expect(
            projection.snapshot({ agentId: "main", key: "agent:main:new" }).row?.sessionId,
          ).toBe("new");
          expect(sql).not.toHaveBeenCalled();
        } finally {
          sql.mockRestore();
        }
      } finally {
        workerIdentity.mockRestore();
        identity.mockRestore();
      }
    } finally {
      projection.dispose();
    }
  });
});

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
      const drain = createDeferredCore();
      const entryWorkRequested = createDeferredCore<never>();
      let holdEntryWork = false;
      const createDrain = projectionWork.createSessionProjectionDrain;
      const drainFactory = vi
        .spyOn(projectionWork, "createSessionProjectionDrain")
        .mockImplementationOnce((params) => {
          const ensure = createDrain(params);
          return () => {
            if (holdEntryWork && params.needsYield()) {
              entryWorkRequested.reject(
                new Error("Presentation-only lists requested a session-entry drain"),
              );
              return drain.promise;
            }
            return ensure();
          };
        });
      const projection = await createSessionRowProjection({
        cfg,
        modelCatalog: [{ provider: "unit-test", id: "model", name: "Model" }],
      });
      const opts = { limit: 20, archived: "all", search: "unit-test/model" } as const;
      let lists: Array<ReturnType<typeof listProjectedSessions>> = [];
      let stopWorkerReadGuard = () => {};
      try {
        await listProjectedSessions({ projection, opts });
        const catalogReads = vi.spyOn(catalogLookup, "findModelCatalogEntry");
        await listProjectedSessions({ projection, opts });
        const warmCatalogLookups = catalogReads.mock.calls.length;
        catalogReads.mockClear();
        const reads = vi.spyOn(materialization, "readSessionRowEntry");
        const readRowFacts = vi.fn(async () => {
          throw new Error("Presentation-only lists read stored session-row facts");
        });
        const readDatabases = transcriptWorker.withSessionHistoryWorkerDatabases;
        const workerReads = vi
          .spyOn(transcriptWorker, "withSessionHistoryWorkerDatabases")
          .mockImplementation((databases, consume) =>
            readDatabases(databases, (owners) =>
              consume(owners.map((owner) => ({ ...owner, readRowFacts }))),
            ),
          );
        stopWorkerReadGuard = () => workerReads.mockRestore();
        holdEntryWork = true;
        sessionChanges.emit({ all: true, scope });
        lists = Array.from({ length: 8 }, () => listProjectedSessions({ projection, opts }));
        const result = await Promise.race([Promise.all(lists), entryWorkRequested.promise]);
        expect(result.map((list) => list.count)).toEqual(Array.from({ length: 8 }, () => 20));
        expect(reads).not.toHaveBeenCalled();
        expect(readRowFacts).not.toHaveBeenCalled();
        // Presentation changes must not add catalog work beyond the warm request's defaults.
        expect(catalogReads.mock.calls.length).toBeLessThanOrEqual(warmCatalogLookups * 8);
        expect(projection.dirtyRowCount).toBe(0);
      } finally {
        holdEntryWork = false;
        stopWorkerReadGuard();
        drain.resolve();
        await Promise.allSettled(lists);
        await projection.ensureMaterialized();
        projection.dispose();
        drainFactory.mockRestore();
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
      const originalPeople = structuredClone(result.people);
      const live = await listProjectedSessions({
        projection,
        opts: { includePeople: true },
      });
      expect(live.people).toEqual(
        originalPeople?.map((person) => ({ ...person, sessionCount: 1 })),
      );
      expect(result.people).toEqual(originalPeople);
      for (const person of live.people ?? []) {
        person.sessionCount = 99;
        person.label = "Changed response";
      }
      const repeated = await listProjectedSessions({
        projection,
        opts: { archived: "all", includePeople: true },
      });
      expect(repeated.people).toEqual(originalPeople);
      expect(result.people).toEqual(originalPeople);
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

it("invalidates projected rows when the published config object is republished after an in-place edit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:same-object" },
      { sessionId: "same-object", updatedAt: 1 },
    );
    const release = projectionWork.retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      const published = structuredClone(cfg);
      setRuntimeConfigSnapshot(published);
      await projection.ensureMaterialized();
      expect(projection.dirtyRowCount).toBe(0);

      // An in-place edit republished on the same object can change what rows resolve,
      // so it must refresh every row even though the object compares equal to itself.
      Object.assign(published.agents, { defaults: { model: "unit-test/model" } });
      setRuntimeConfigSnapshot(published);
      expect(projection.dirtyRowCount).toBeGreaterThan(0);
    } finally {
      await projection.ensureMaterialized();
      projection.dispose();
      release();
      resetConfigRuntimeState();
    }
  });
});

it("invalidates projected rows when a distinct config matches an in-place edit of the published one", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:edited-in-place" },
      { sessionId: "edited-in-place", updatedAt: 1 },
    );
    const release = projectionWork.retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      const published = structuredClone(cfg);
      setRuntimeConfigSnapshot(published);
      await projection.ensureMaterialized();
      expect(projection.dirtyRowCount).toBe(0);

      // Rows were built from the values published before the edit, so a distinct object
      // carrying the edited values is a change against that publication, not a republish.
      Object.assign(published.agents, { defaults: { model: "unit-test/model" } });
      setRuntimeConfigSnapshot(structuredClone(published));
      expect(projection.dirtyRowCount).toBeGreaterThan(0);
    } finally {
      await projection.ensureMaterialized();
      projection.dispose();
      release();
      resetConfigRuntimeState();
    }
  });
});

it("keeps projected rows clean when config.apply rewrites a value-identical config", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    for (let index = 0; index < 4; index++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:rewrite-${index}` },
        { sessionId: `rewrite-${index}`, updatedAt: index + 1 },
      );
    }
    const source = (version: string) => ({
      ...structuredClone(cfg),
      meta: { lastTouchedVersion: version },
    });
    const release = projectionWork.retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      activateSecretsRuntimeSnapshotState({
        snapshot: {
          sourceConfig: source("1"),
          config: structuredClone(cfg),
          authStores: prepareRuntimeAuthProfileStoreSnapshots([]),
          authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
          authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
          warnings: [],
          webTools: {
            search: { providerSource: "none", diagnostics: [] },
            fetch: { providerSource: "none", diagnostics: [] },
            diagnostics: [],
          },
        },
        refreshContext: null,
        refreshHandler: null,
      });
      await listProjectedSessions({ projection, opts: {} });
      await projection.ensureMaterialized();
      expect(projection.dirtyRowCount).toBe(0);

      // A value-identical config.apply only restamps the file's meta, so the gateway takes its
      // effective-config-unchanged branch: the runtime object stays and only its source advances.
      const rewritten = source("2");
      expect(
        setSecretsRuntimeSourceSnapshotIfCurrent({
          expectedSecretsRevision: getActiveSecretsRuntimeSnapshotRevisionState(),
          expectedRuntimeConfigRevision: getRuntimeConfigSnapshotMetadata()?.revision ?? 0,
          runtimeSourceConfig: rewritten,
          secretsSourceConfig: rewritten,
        }),
      ).toBe(true);
      expect(getRuntimeConfigSourceSnapshot()).toEqual(rewritten);
      expect(projection.dirtyRowCount).toBe(0);
    } finally {
      await projection.ensureMaterialized();
      projection.dispose();
      release();
      clearSecretsRuntimeSnapshotState();
      resetConfigRuntimeState();
    }
  });
});

it("keeps projected rows clean when a config publication resolves to the published snapshot", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    for (let index = 0; index < 4; index++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:republish-${index}` },
        { sessionId: `republish-${index}`, updatedAt: index + 1 },
      );
    }
    const release = projectionWork.retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      await listProjectedSessions({ projection, opts: {} });
      expect(projection.dirtyRowCount).toBe(0);

      // The first publication of a config is a real change: every row is invalidated.
      setRuntimeConfigSnapshot(structuredClone(cfg));
      expect(projection.dirtyRowCount).toBeGreaterThan(0);
      await projection.ensureMaterialized();
      expect(projection.dirtyRowCount).toBe(0);

      // The same config published again is not a session-data change, so no row is
      // invalidated and no drain starts.
      setRuntimeConfigSnapshot(structuredClone(cfg));
      expect(projection.dirtyRowCount).toBe(0);

      // Equal values with different resolution provenance can resolve differently, so rows refresh.
      const reresolved = structuredClone(cfg);
      setConfigResolutionFacts(
        reresolved,
        createConfigResolutionFacts([
          { varName: "UNIT_TEST_AGENT", configPath: "agents.list.0.id" },
        ]),
      );
      setRuntimeConfigSnapshot(reresolved);
      expect(projection.dirtyRowCount).toBeGreaterThan(0);
      await projection.ensureMaterialized();
      expect(projection.dirtyRowCount).toBe(0);

      // A source-only republish that changes provenance copies it onto the published object in
      // place, so it reaches rows through the same-object path.
      expect(
        setRuntimeConfigSourceSnapshotIfCurrent({
          expectedRevision: getRuntimeConfigSnapshotMetadata()?.revision ?? 0,
          sourceConfig: structuredClone(cfg),
        }),
      ).toBe(true);
      expect(projection.dirtyRowCount).toBeGreaterThan(0);
      await projection.ensureMaterialized();
      expect(projection.dirtyRowCount).toBe(0);

      // A real config change still dirties every row.
      setRuntimeConfigSnapshot({
        ...structuredClone(cfg),
        agents: { ...cfg.agents, defaults: { model: "unit-test/model" } },
      });
      expect(projection.dirtyRowCount).toBeGreaterThan(0);
    } finally {
      await projection.ensureMaterialized();
      projection.dispose();
      release();
      resetConfigRuntimeState();
    }
  });
});
