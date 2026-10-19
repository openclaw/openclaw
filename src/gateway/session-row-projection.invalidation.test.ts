import { afterEach, expect, it, vi } from "vitest";
import type { SessionCommunicationMode } from "../../packages/gateway-protocol/src/session-communication.js";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
  prepareRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import * as agentIdentity from "../agents/identity.js";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
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
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearAgentRunContext,
  recordAgentRunModel,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotRevisionState,
  setSecretsRuntimeSourceSnapshotIfCurrent,
} from "../secrets/runtime-state.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { linkEmail, setDisplayName } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createPreparedGatewayModelCatalog } from "./server-model-catalog-view.js";
import * as listFilters from "./session-list-filters.js";
import { prepareSessionRowPublication } from "./session-row-presentation.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import * as materialization from "./session-row-projection-materialize.js";
import {
  createTestProjection,
  holdForeground,
} from "./session-row-projection.read-fixture.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => vi.restoreAllMocks());

it("reuses resident rows across plugin reloads while adopting changed model normalization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const baseConfig: OpenClawConfig = {
      agents: { entries: { main: {} }, defaults: { model: "example/list-alias" } },
      plugins: { entries: { "synthetic-hooks": { enabled: true } } },
    };
    let cfg = baseConfig;
    setRuntimeConfigSnapshot(cfg);
    const keys = Array.from({ length: 4 }, (_, index) => `agent:main:plugin-reload-${index}`);
    for (const [index, sessionKey] of keys.entries()) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        { sessionId: `plugin-reload-${index}`, updatedAt: index + 1, visibility: "shared" },
      );
    }
    const instances: PluginInstance[] = [];
    const view = (model: string, sourceDigest = "original-code") => {
      const owner = new PluginInstance("model-owner");
      owner.sourceDigest = sourceDigest;
      instances.push(owner);
      const pluginRegistry = createEmptyPluginRegistry();
      pluginRegistry.providers.push({
        pluginId: "model-owner",
        source: "/tmp/model-owner/index.js",
        provider: owner.wrap({
          id: "example",
          label: "Example",
          auth: [],
          aliases: ["example-alias"],
          hookAliases: ["example-hook"],
          resolveThinkingProfile: () => null,
        }),
      });
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          { id: "synthetic-hooks", hooks: ["before_prompt_build"] },
          {
            id: "model-owner",
            origin: "global",
            providers: ["example"],
            modelIdNormalization: {
              providers: { example: { aliases: { "list-alias": model } } },
            },
          },
        ],
      });
      const entries = [
        { provider: "example", id: "original", name: "Original" },
        { provider: "example", id: "replacement", name: "Replacement" },
      ];
      const prepared: ModelCatalogSnapshot = { entries, routeVariants: entries };
      prepareModelCatalogThinkingPolicies({ catalog: prepared, metadataSnapshot, pluginRegistry });
      return new Map([
        [
          "main",
          createPreparedGatewayModelCatalog({
            config: cfg,
            entries: prepared.entries,
            routeVariants: prepared.routeVariants,
            pluginRegistry,
            metadataSnapshot,
          }),
        ],
      ]);
    };
    let catalog = view("original");
    using release = holdForeground();
    using projection = await createTestProjection({
      cfg,
      getConfig: () => cfg,
      getModelCatalog: async () => catalog,
    });
    const list = () => listProjectedSessions({ projection, opts: {} });
    const sequences = () =>
      keys.map((key) => projection.capture({ agentId: "main", key })?.materializedSequence);
    try {
      const original = await list();
      await projection.ensureMaterialized();
      expect(original.sessions.map((row) => row.model)).toEqual(Array(4).fill("original"));
      const materialized = sequences();
      for (const entry of [
        { enabled: true, hooks: { allowPromptInjection: false } },
        { enabled: false },
        { enabled: true },
      ]) {
        cfg = { ...baseConfig, plugins: { entries: { "synthetic-hooks": entry } } };
        setRuntimeConfigSnapshot(cfg);
        expect(projection.dirtyRowCount).toBe(0);
        catalog = view("original");
        notifyPreparedModelRuntimePublication({ phase: "published" });
        const concurrent = await Promise.all(Array.from({ length: 8 }, list));
        await projection.ensureMaterialized();
        expect(
          concurrent.every((result) => result.sessions.every((row) => row.model === "original")),
        ).toBe(true);
        expect(sequences()).toEqual(materialized);
        expect(projection.dirtyRowCount).toBe(0);
      }
      // Captured code changes still invalidate policy even with the same registration shape.
      catalog = view("original", "changed-code");
      notifyPreparedModelRuntimePublication({ phase: "published" });
      await projection.ensureMaterialized();
      expect((await list()).sessions.map((row) => row.model)).toEqual(Array(4).fill("original"));
      expect(sequences()).not.toEqual(materialized);
      const beforeNormalization = sequences();
      // A manifest policy edit still changes rows even when catalog entries stay identical.
      catalog = view("replacement", "changed-code");
      notifyPreparedModelRuntimePublication({ phase: "published" });
      await projection.ensureMaterialized();
      expect((await list()).sessions.map((row) => row.model)).toEqual(Array(4).fill("replacement"));
      expect(sequences()).not.toEqual(beforeNormalization);
    } finally {
      await projection.ensureMaterialized();
      projection.dispose();
      release();
      resetConfigRuntimeState();
      await Promise.all(instances.map((instance) => instance.dispose()));
    }
  });
});

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
    using _ = holdForeground();
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
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
      const snapshot = (key: string) =>
        prepareSessionRowPublication(projection, Date.now())(
          client,
          createVisibleActiveSessionRunProjector(
            projection.state.rowContext.projectedAgentRuns,
            undefined,
            context.resolveGatewayContext,
          ),
        ).snapshot({
          agentId: "main",
          key,
        }).row!;
      const siblingSnapshot = snapshot(siblingKey);
      const parentSnapshot = snapshot(parentKey);
      const siblingBytes = JSON.stringify(siblingSnapshot);
      expect(() => {
        siblingSnapshot.label = "Reader mutation";
      }).toThrow(TypeError);
      expect(() => siblingSnapshot.childOwnerSessionKeys!.push(parentKey)).toThrow(TypeError);
      for (const change of [undefined, { label: "Updated parent", updatedAt: 10 }]) {
        if (change) {
          Object.assign(parent, change);
          replaceSessionEntrySync(scope, { ...parent });
        } else {
          sessionChanges.emit(scope);
        }
        await list();
        expect(children.map(sequence)).toEqual(original);
        expect(snapshot(siblingKey)).toBe(siblingSnapshot);
        expect(JSON.stringify(snapshot(siblingKey))).toBe(siblingBytes);
        if (change) {
          expect(snapshot(parentKey)).not.toBe(parentSnapshot);
          expect(snapshot(parentKey).label).toBe("Updated parent");
          expect(parentSnapshot.label).toBeUndefined();
        }
      }
      const cases: Array<[Partial<SessionEntry>, string, string]> = [
        [{ providerOverride: "other-test" }, "other-test", "selected"],
        [{ modelOverride: "changed" }, "other-test", "changed"],
        [{ modelOverrideSource: "default" }, "unit-test", "default"],
        [
          {
            modelOverrideSource: "auto",
            modelOverrideFallbackOriginProvider: "other-test",
            modelOverrideFallbackOriginModel: "changed",
          },
          "other-test",
          "changed",
        ],
        [{ modelOverrideFallbackOriginModel: "original" }, "unit-test", "default"],
        [
          {
            modelOverrideFallbackOriginModel: "changed",
            modelOverrideFallbackOriginProvider: "original-test",
          },
          "unit-test",
          "default",
        ],
      ];
      for (const [change, provider, model] of cases) {
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
        expect.soft(reads, `Stored facts after ${JSON.stringify(change)}`).toEqual([]);
      }
      parent.modelOverrideSource = "user";
      replaceSessionEntrySync(scope, { ...parent });
      const pinned = await list();
      for (const key of children) {
        expect(pinned.sessions.find((row) => row.key === key)?.model).toBe("changed");
      }
      registerAgentRunContext("publication-model", {
        agentId: "main",
        sessionKey: siblingKey,
        sessionId: "child-2",
        projectSessionActive: true,
      });
      try {
        for (const model of ["first", "replacement", undefined]) {
          recordAgentRunModel(
            "publication-model",
            model ? { provider: "unit-test", model } : undefined,
          );
          const row = snapshot(siblingKey);
          expect(row.activeModel).toBe(model);
          expect(snapshot(siblingKey)).toBe(row);
        }
      } finally {
        clearAgentRunContext("publication-model");
      }
      expect(snapshot(siblingKey).activeModel).toBeUndefined();
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
      expect.soft(reads, "Unchanged parents after a child moves").toEqual([]);
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
    }
  });
});

it("refreshes profile display fields on selected live and archived rows without rereading entries", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const owner = ensureProfileForEmail("owner@example.com");
    const participant = ensureProfileForEmail("participant@example.com");
    for (const archived of [false, true]) {
      const scope = { agentId: "main", sessionKey: `agent:main:profile-${archived}` };
      replaceSessionEntrySync(scope, {
        sessionId: `profile-${archived}`,
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: owner.id },
        ...(archived
          ? { archivedAt: 1, archivedBy: { type: "human" as const, id: owner.id } }
          : {}),
      });
      recordSessionParticipant(scope, {
        identity: { type: "profile", id: participant.id },
        promptedAt: 1,
      });
    }
    using _ = holdForeground();
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    const list = (opts: Parameters<typeof listProjectedSessions>[0]["opts"], serialized = false) =>
      listProjectedSessions({ projection, opts, acceptsSerializedJson: serialized });
    const allPeople = { archived: "all", includePeople: true } as const;
    const expectedPerson = (id: string, label: string) =>
      expect.objectContaining({ identity: { type: "profile", id }, label, sessionCount: 2 });

    await list(allPeople, true);
    const reads = vi.spyOn(materialization, "readSessionRowEntry");
    setDisplayName(owner.id, "Current owner");
    setDisplayName(participant.id, "Current participant");
    const result = await list(allPeople, true);
    expect(result.owners?.map((actor) => actor.label)).toEqual(["Current owner"]);
    expect(result.people).toEqual([
      expectedPerson(owner.id, "Current owner"),
      expectedPerson(participant.id, "Current participant"),
    ]);
    expect(result.sessions).toHaveLength(2);
    const originalPeople = structuredClone(result.people);
    const live = await list({ includePeople: true });
    expect(live.people).toEqual(originalPeople?.map((person) => ({ ...person, sessionCount: 1 })));
    expect(result.people).toEqual(originalPeople);
    for (const person of live.people ?? []) {
      person.sessionCount = 99;
      person.label = "Changed response";
    }
    const repeated = await list(allPeople);
    expect(repeated.people).toEqual(originalPeople);
    expect(result.people).toEqual(originalPeople);
    for (const row of result.sessions) {
      expect(row.createdActor?.label).toBe("Current owner");
      expect(row.owner?.actor.label).toBe("Current owner");
      expect(row.participants).toMatchObject([{ label: "Current participant" }]);
      if (row.archived) {
        expect(row.archivedBy?.label).toBe("Current owner");
      }
    }
    expect(reads).not.toHaveBeenCalled();
    linkEmail("participant@example.com", owner.id);
    const merged = await list({
      ...allPeople,
      profileRelation: { profileId: participant.id, relationship: "involving" },
    });
    expect(merged.sessions).toHaveLength(2);
    expect(merged.people).toEqual([expectedPerson(owner.id, "Current owner")]);
    expect(merged.sessions.every((row) => row.participants === undefined)).toBe(true);
    expect(reads).not.toHaveBeenCalled();
  });
});

it("reuses row identities across lists until their entry, profile, or config changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: {
        entries: { main: { identity: { name: "Original agent" } } },
      },
      session: { communication: { receive: "ask" as SessionCommunicationMode } },
    };
    const scope = { agentId: "main", sessionKey: "agent:main:identity-cache" };
    const entry = {
      sessionId: "identity-cache",
      updatedAt: 1,
      communication: { send: "never" as const },
      createdActor: { type: "agent" as const, id: "main" },
    };
    replaceSessionEntrySync(scope, entry);
    recordSessionParticipant(scope, { identity: { type: "agent", id: "main" } });
    using _ = holdForeground();
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    const list = () => listProjectedSessions({ projection, opts: {} });
    try {
      expect((await list()).sessions[0]?.effectiveCommunication).toEqual({
        send: "never",
        receive: "ask",
      });
      const identities = vi.spyOn(agentIdentity, "resolveAgentIdentity");
      for (let index = 0; index < 3; index++) {
        expect((await list()).sessions[0]?.owner?.actor.label).toBe("Original agent");
      }
      expect(identities).not.toHaveBeenCalled();

      const serialized = () =>
        listProjectedSessions({ projection, opts: {}, acceptsSerializedJson: true });
      await serialized();
      const selections = vi.spyOn(listFilters, "filterSessionEntries");
      sessionChanges.emit({ ...scope, scope: "runtime", facts: { kind: "unchanged" } });
      expect((await serialized()).sessions[0]?.owner?.actor.label).toBe("Original agent");
      expect(selections).not.toHaveBeenCalled();
      identities.mockClear();

      sessionChanges.emit({ all: true, scope: "profiles" });
      await list();
      expect(identities).toHaveBeenCalled();
      identities.mockClear();
      await list();
      expect(identities).not.toHaveBeenCalled();

      cfg.agents.entries.main.identity.name = "Renamed agent";
      cfg.session.communication.receive = "always";
      sessionChanges.emit({ all: true, scope: "config" });
      expect((await list()).owners?.[0]?.label).toBe("Renamed agent");
      expect((await list()).sessions[0]?.effectiveCommunication).toEqual({
        send: "never",
        receive: "always",
      });
      expect((await list()).sessions[0]?.communication).toEqual({ send: "never" });
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
      using release = holdForeground();
      using projection = await createTestProjection({ cfg, modelCatalog: [] });
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

          // A source-only restamp is a full no-op for runtime publication and resident rows.
          const previousSource = getRuntimeConfigSourceSnapshot();
          const previousMetadata = getRuntimeConfigSnapshotMetadata();
          const rewritten = source("2");
          expect(
            setSecretsRuntimeSourceSnapshotIfCurrent({
              expectedSecretsRevision: getActiveSecretsRuntimeSnapshotRevisionState(),
              expectedRuntimeConfigRevision: getRuntimeConfigSnapshotMetadata()?.revision ?? 0,
              runtimeSourceConfig: rewritten,
              secretsSourceConfig: rewritten,
            }),
          ).toBe(true);
          expect(getRuntimeConfigSourceSnapshot()).toBe(previousSource);
          expect(getRuntimeConfigSnapshotMetadata()).toBe(previousMetadata);
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
