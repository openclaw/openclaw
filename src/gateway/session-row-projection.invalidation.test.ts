import { renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
  prepareRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import * as agentIdentity from "../agents/identity.js";
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
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import * as transcriptWorker from "../config/sessions/session-transcript-worker-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotRevisionState,
  setSecretsRuntimeSourceSnapshotIfCurrent,
} from "../secrets/runtime-state.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import * as databaseIdentity from "../state/openclaw-agent-db-identity.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { linkEmail, setDisplayName } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
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
        entries: { main: {} },
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

it("hydrates a same-path replacement with a reused inode and retires its previous inventory", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const staged = state.statePath("imports", "replacement.sqlite");
    const cfg = {
      agents: { entries: { main: {} } },
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
    const readIdentity = databaseIdentity.readOpenClawAgentDatabaseIdentity;
    const previousIdentity = readIdentity(
      openOpenClawAgentDatabase({ agentId: "main", path: storePath }),
    );
    const replacementIdentity = readIdentity(
      openOpenClawAgentDatabase({ agentId: "main", path: staged }),
    );
    if (typeof replacementIdentity.identity !== "string") {
      throw new Error("Expected a persistent fixture database identity");
    }
    const reusedIdentity = replacementIdentity.identity;
    const previousBirthtime = (BigInt(replacementIdentity.birthtime ?? "0") + 1n).toString();
    const initialSource = (source: { identity?: string; birthtime?: string }) =>
      source.identity === previousIdentity.identity &&
      source.birthtime === previousIdentity.birthtime;
    const readDatabases = transcriptWorker.withSessionHistoryWorkerDatabases;
    // Simulate the initial inode while retaining real file verification at both admissions.
    const workerIdentity = vi
      .spyOn(transcriptWorker, "withSessionHistoryWorkerDatabases")
      .mockImplementation((targets, consume, lane) =>
        readDatabases(
          targets,
          (owners) =>
            consume(
              owners.map((owner) => ({
                ...owner,
                async readStoreProjection(input) {
                  const reply = await owner.readStoreProjection(input);
                  return reply.source && initialSource(reply.source)
                    ? {
                        ...reply,
                        source: {
                          ...reply.source,
                          identity: reusedIdentity,
                          birthtime: previousBirthtime,
                        },
                      }
                    : reply;
                },
                async readMembershipFacts(input) {
                  const reply = await owner.readMembershipFacts(input);
                  return initialSource(reply)
                    ? { ...reply, identity: reusedIdentity, birthtime: previousBirthtime }
                    : reply;
                },
              })),
            ),
          lane,
        ),
      );
    await closeOpenClawAgentDatabaseByPathAsync(staged, "main");
    const projection = await createSessionRowProjection({ cfg });
    await projection.ensureMaterialized();
    try {
      expect([...projection.sessionGroupTargets().keys()]).toEqual(["old group"]);
      await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
      renameSync(staged, storePath);
      registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
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
      }
    } finally {
      projection.dispose();
    }
  });
});

it("refreshes profile display fields on selected live and archived rows without rereading entries", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
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

it.each(["source rewrite", "resolved snapshot"] as const)(
  "keeps projected rows clean for an equivalent config %s",
  async (publication) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      for (let index = 0; index < 4; index++) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: `agent:main:republish-${index}` },
          { sessionId: `republish-${index}`, updatedAt: index + 1 },
        );
      }
      const release = projectionWork.retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      try {
        if (publication === "source rewrite") {
          const source = (version: string) => ({
            ...structuredClone(cfg),
            meta: { lastTouchedVersion: version },
          });
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
        } else {
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
              { varName: "UNIT_TEST_AGENT", configPath: "agents.entries.main" },
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
        }
      } finally {
        await projection.ensureMaterialized();
        projection.dispose();
        release();
        if (publication === "source rewrite") {
          clearSecretsRuntimeSnapshotState();
        }
        resetConfigRuntimeState();
      }
    });
  },
);
