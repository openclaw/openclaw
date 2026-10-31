import { isMainThread } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { archiveCompletedSubagentRuns } from "../agents/subagents/registry/subagent-registry-archive.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../agents/subagents/registry/subagent-registry-persistence.js";
import { publishSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import * as registryQueries from "../agents/subagents/registry/subagent-registry-queries.js";
import { persistRegistryFixture } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentSessionListReadSnapshotIdentity,
  prepareSubagentSessionListReadCache,
} from "../agents/subagents/registry/subagent-registry-state.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { readPreparedSessionEntryChange } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import { applySessionEntryExactReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import * as agentRuns from "../infra/agent-run-registry.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveApprovalSessionAudienceWithFallback } from "./approval-session-audience.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import type { RespondFn } from "./server-methods/types.js";
import { makeGatewayClient } from "./server-request-context.test-support.js";
import * as projectionWork from "./session-projection-work.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import * as materialization from "./session-row-projection-materialize.js";
import { writeRow } from "./session-row-projection-read-fixtures.test-support.js";
import {
  createTestProjection,
  holdForeground,
  holdSubagentExecution,
  watchRowFacts as observeRowFacts,
} from "./session-row-projection.read-fixture.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";
import * as rowProjection from "./session-utils-projection.js";
import * as rowPresentation from "./session-utils-row.js";

afterEach(() => {
  vi.restoreAllMocks();
  subagentRuns.clear();
});

const cfg = { agents: { entries: { main: {} } } };
function withRegistryState(run: () => Promise<void>) {
  return withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    run,
  );
}

it("reads archived task status and lineage without repopulating resident projection facts", async () => {
  await withRegistryState(async () => {
    setRuntimeConfigSnapshot(cfg);
    const child = "agent:main:subagent:kept-history";
    const parent = "agent:main:actual-requester";
    const now = Date.now();
    const endedAt = now - 31 * 86_400_000;
    writeRow(parent, { sessionId: "actual-requester", label: "Synthetic archive parent" });
    writeRow(child, {
      sessionId: "kept-history",
      label: "Synthetic archive child",
      spawnedBy: "agent:main:stale-requester",
    });
    const run = createSubagentRunRecord({
      runId: "kept-history",
      childSessionKey: child,
      childAgentId: "main",
      requesterSessionKey: parent,
      requesterAgentId: "main",
      cleanup: "keep",
      createdAt: endedAt - 1_000,
      execution: {
        status: "terminal",
        startedAt: endedAt - 1_000,
        endedAt,
        outcome: { status: "ok" },
      },
      cleanupCompletedAt: endedAt,
      delivery: { status: "not_required" },
      completion: { required: false },
      collect: true,
      groupId: "kept-history",
      swarmRequesterSessionKey: parent,
      collectorCompletion: { status: "done" },
    });
    const unrelated = Array.from({ length: 64 }, (_, index) =>
      createSubagentRunRecord({
        runId: `unrelated-hot-${index}`,
        childSessionKey: `agent:main:subagent:unrelated-${index}`,
        requesterSessionKey: "agent:main:unrelated-requester",
        createdAt: now,
      }),
    );
    const rows = new Map([run, ...unrelated].map((entry) => [entry.runId, entry]));
    await mutateSubagentRuns([...rows.keys()], () => ({
      value: undefined,
      postimages: rows,
    }));
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    await projection.ensureMaterialized();
    const beforeArchive = await listProjectedSessions({
      projection,
      opts: { limit: 10, ownerFirst: true },
    });
    expect(await archiveCompletedSubagentRuns(now)).toBe(1);
    await projection.ensureMaterialized();
    expect(subagentRuns.has(run.runId)).toBe(false);
    const exact = await withReadySessionRows(
      projection,
      () => [{ agentId: "main", key: child }],
      (read) => {
        const record = read.describe({ agentId: "main", key: child });
        expect(record).toBeDefined();
        return read.present(record!);
      },
    );
    expect(exact).toMatchObject({
      status: "done",
      subagentRunState: "historical",
      endedAt,
      runtimeMs: 1_000,
    });
    const archiveReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const indexBuilds = vi.spyOn(registryQueries, "buildSubagentRunReadIndexFromRuns");
    const listed = await listProjectedSessions({
      projection,
      opts: { limit: 10, ownerFirst: true },
    });
    expect(listed.sessions.map((row) => row.key)).toEqual(
      beforeArchive.sessions.map((row) => row.key),
    );
    expect(indexBuilds).toHaveBeenCalled();
    for (const [inputs] of indexBuilds.mock.calls) {
      expect([...inputs.runs.keys()]).toEqual([run.runId]);
      expect([...(inputs.inMemoryRuns ?? [])]).toEqual([]);
    }
    expect(
      archiveReads.mock.calls.flatMap(([, command]) =>
        command.type === "subagents.runs" && command.scope.kind === "archive"
          ? [command.scope.scope]
          : [],
      ),
    ).toEqual([
      { kind: "sessions", sessionKeys: expect.arrayContaining([parent, child]), descendants: true },
    ]);
    expect(listed.sessions.find((row) => row.key === child)).toMatchObject({
      status: "done",
      endedAt,
      runtimeMs: 1_000,
    });
    expect(listed.sessions.find((row) => row.key === parent)?.swarm).toMatchObject({
      groups: [
        { groupId: "kept-history", done: 1, children: [{ sessionKey: child, status: "done" }] },
      ],
    });
    archiveReads.mockClear();
    const searched = await listProjectedSessions({
      projection,
      opts: { search: "Synthetic archive", limit: 10, ownerFirst: true },
    });
    expect(searched.sessions).toEqual(
      listed.sessions.map((row) => Object.assign({}, row, { snapshotAt: expect.any(Number) })),
    );
    expect(
      archiveReads.mock.calls.flatMap(([, command]) =>
        command.type === "subagents.runs" && command.scope.kind === "archive"
          ? [command.scope.scope]
          : [],
      ),
    ).toEqual([
      { kind: "sessions", sessionKeys: expect.arrayContaining([parent, child]), descendants: true },
    ]);
    expect(await resolveApprovalSessionAudienceWithFallback(child, "main")).toEqual([
      child,
      parent,
    ]);
    const present = vi.spyOn(rowPresentation, "presentSessionRow");
    const progress = vi.spyOn(agentRuns, "prepareProjectedAgentRunProgressState");
    const readLeaf = () =>
      listProjectedSessions({
        projection,
        key: child,
        opts: { limit: 1 },
        acceptsSerializedJson: true,
      });
    const firstLeaf = (await readLeaf()).sessions[0];
    expect(firstLeaf).toMatchObject({ key: child, status: "done", endedAt });
    present.mockClear();
    progress.mockClear();
    const nextLeaf = (await readLeaf()).sessions[0];
    expect(progress).not.toHaveBeenCalled();
    expect(present).not.toHaveBeenCalled();
    expect(nextLeaf).toBe(firstLeaf);
    expect(subagentRuns.size).toBe(unrelated.length);
    expect(projection.state.rowContext.subagentRuns.getDisplaySubagentRun(child)).toBeNull();
  });
});

it("finds a retired run model after archival with a cold session projection", async () => {
  await withRegistryState(async () => {
    const modelConfig = { agents: { entries: { main: { model: "openai/gpt-4.1" } } } };
    setRuntimeConfigSnapshot(modelConfig);
    const child = "agent:main:subagent:model-search-child";
    const parent = "agent:main:model-search-parent";
    const now = Date.now();
    const endedAt = now - 31 * 86_400_000;
    writeRow(parent, { sessionId: "model-search-parent" });
    writeRow(child, { sessionId: "model-search-child", spawnedBy: parent });
    const run = createSubagentRunRecord({
      runId: "model-search-run",
      childSessionKey: child,
      childAgentId: "main",
      requesterSessionKey: parent,
      requesterAgentId: "main",
      model: "openai/retired-archive-only",
      createdAt: endedAt - 1_000,
      execution: { status: "terminal", endedAt, outcome: { status: "ok" } },
      cleanupCompletedAt: endedAt,
      delivery: { status: "not_required" },
      completion: { required: false },
    });
    await mutateSubagentRuns([run.runId], () => ({
      value: undefined,
      postimages: new Map([[run.runId, run]]),
    }));
    const opts = { search: "retired-archive-only", limit: 10 };
    const expected = [
      expect.objectContaining({
        key: child,
        sessionId: "model-search-child",
        modelProvider: "openai",
        model: "gpt-4.1",
      }),
    ];
    {
      using projection = await createTestProjection({ cfg: modelConfig, modelCatalog: [] });
      expect((await listProjectedSessions({ projection, opts })).sessions).toEqual(expected);
    }
    expect(await archiveCompletedSubagentRuns(now)).toBe(1);
    expect(subagentRuns.has(run.runId)).toBe(false);
    expect(loadSessionEntry({ agentId: "main", sessionKey: child })).not.toHaveProperty("model");
    using projection = await createTestProjection({ cfg: modelConfig, modelCatalog: [] });
    const executeRead = stateReads.executeExistingOpenClawStateRead;
    const archiveReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    expect((await listProjectedSessions({ projection, opts })).sessions).toEqual(expected);
    const scopes = archiveReads.mock.calls.flatMap(([, command]) =>
      command.type === "subagents.runs" && command.scope.kind === "archive"
        ? [command.scope.scope]
        : [],
    );
    expect(scopes).not.toContainEqual({ kind: "all" });
    expect(scopes).toContainEqual({
      kind: "children",
      sessionKeys: expect.arrayContaining([child]),
    });
    expect(projection.modelSearchMayMatch(opts.search)).toBe(false);
    expect(subagentRuns.has(run.runId)).toBe(false);
    expect(projection.state.rowContext.subagentRuns.getDisplaySubagentRun(child)).toBeNull();
    writeRow(child, { sessionId: "model-search-child", spawnedBy: parent, label: opts.search });
    let removedLabel = false;
    archiveReads.mockImplementation(async (...args) => {
      const result = await executeRead(...args);
      const command = args[1];
      if (!removedLabel && command.type === "subagents.runs" && command.scope.kind === "archive") {
        const scope = command.scope.scope;
        if (scope.kind === "sessions" && scope.sessionKeys.includes(child)) {
          removedLabel = true;
          writeRow(child, { sessionId: "model-search-child", spawnedBy: parent });
        }
      }
      return result;
    });
    expect((await listProjectedSessions({ projection, opts })).sessions).toEqual(expected);
    expect(removedLabel).toBe(true);
    archiveReads.mockImplementation(executeRead);
    const latest = createSubagentRunRecord({
      ...run,
      runId: "model-search-latest",
      generation: 2,
      model: "openai/current-only",
      createdAt: now,
      execution: { status: "terminal", endedAt: now, outcome: { status: "ok" } },
      cleanupCompletedAt: now,
    });
    await mutateSubagentRuns([latest.runId], () => ({
      value: undefined,
      postimages: new Map([[latest.runId, latest]]),
    }));
    expect((await listProjectedSessions({ projection, opts })).sessions).toEqual([]);
    expect(
      (await listProjectedSessions({ projection, opts: { ...opts, search: "current-only" } }))
        .sessions,
    ).toEqual(expected);
    expect(subagentRuns.has(run.runId)).toBe(false);
  });
});

it("keeps mixed descendant generations and physical child links in scoped historical reads", async () => {
  await withRegistryState(async () => {
    setRuntimeConfigSnapshot(cfg);
    const key = (id: string) => `agent:main:subagent:${id}`;
    const root = key("scope-root");
    const now = Date.now();
    const endedAt = now - 31 * 86_400_000;
    const entries = [
      ["scope-archived", "scope-root", true],
      ["scope-bridge", "scope-archived", false],
      ["scope-archived-leaf", "scope-bridge", true],
      ["scope-live-leaf", "scope-archived-leaf", false],
      ["scope-physical", "scope-foreign", false],
    ] as const;
    const runs = new Map(
      entries.map(([id, requester, archived]) => [
        id,
        createSubagentRunRecord({
          runId: id,
          childSessionKey: key(id),
          childAgentId: "main",
          requesterSessionKey: key(requester),
          requesterAgentId: "main",
          createdAt: archived ? endedAt - 1_000 : now,
          execution: archived
            ? { status: "terminal", endedAt }
            : { status: "running", startedAt: now },
          cleanupCompletedAt: archived ? endedAt : undefined,
          delivery: { status: "not_required" },
          completion: { required: false },
        }),
      ]),
    );
    writeRow(root, { sessionId: "scope-root" });
    writeRow(key("scope-physical"), { sessionId: "scope-physical", parentSessionKey: root });
    await mutateSubagentRuns([...runs.keys()], () => ({ value: undefined, postimages: runs }));
    using _ = holdSubagentExecution("scope-physical", key("scope-physical"));
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    await projection.ensureMaterialized();
    expect(await archiveCompletedSubagentRuns(now)).toBe(2);
    const readRoot = () =>
      withReadySessionRows(
        projection,
        () => [{ agentId: "main", key: root }],
        (read) => {
          const record = read.describe({ agentId: "main", key: root });
          expect(record).toBeDefined();
          const index = read.state.rowContext.subagentRuns;
          return {
            row: read.present(record!),
            active: index.countActiveDescendantRuns(root),
            physical: index.getDisplaySubagentRun(key("scope-physical"))?.runId,
          };
        },
      );
    expect(await readRoot()).toMatchObject({
      active: 2,
      physical: "scope-physical",
      row: { childSessions: [key("scope-physical")], hasActiveSubagentRun: true },
    });
    const moved = createSubagentRunRecord({
      ...runs.get("scope-archived")!,
      runId: "scope-moved-generation",
      generation: 2,
      requesterSessionKey: key("scope-foreign"),
      createdAt: now,
      execution: { status: "terminal", endedAt: now },
      cleanupCompletedAt: now,
    });
    await mutateSubagentRuns([moved.runId], () => ({
      value: undefined,
      postimages: new Map([[moved.runId, moved]]),
    }));
    expect(await readRoot()).toMatchObject({
      active: 0,
      physical: "scope-physical",
      row: { hasActiveSubagentRun: true },
    });
    for (const includeOwnerSessionCounts of [true, false]) {
      const listed = await listProjectedSessions({
        projection,
        key: root,
        opts: { includeOwnerSessionCounts },
      });
      expect(
        listed.sessions,
        `includeOwnerSessionCounts=${includeOwnerSessionCounts}`,
      ).toMatchObject([
        { key: root, childSessions: [key("scope-physical")], hasActiveSubagentRun: true },
      ]);
    }
    expect(subagentRuns.has("scope-archived")).toBe(false);
    expect(subagentRuns.has("scope-archived-leaf")).toBe(false);
  });
});

it("settles a registry revision after persisting an already absent run", async () => {
  await withRegistryState(async () => {
    setRuntimeConfigSnapshot(cfg);
    clearSubagentRunsReadCacheForTest();
    const target = { agentId: "main", sessionKey: "agent:main:registry-revision" };
    replaceSessionEntrySync(target, { sessionId: "registry-revision", updatedAt: 1 });
    const createDrain = projectionWork.createSessionProjectionDrain;
    let remainingRefreshes: number | undefined;
    vi.spyOn(projectionWork, "createSessionProjectionDrain").mockImplementation((owner) =>
      createDrain({
        ...owner,
        refresh: () => {
          // A regressed microtask loop would starve Vitest's own timeout.
          if (remainingRefreshes !== undefined && remainingRefreshes-- === 0) {
            throw new Error("Session projection did not settle the registry revision");
          }
          return owner.refresh();
        },
      }),
    );
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    using _ = holdForeground();
    await projection.ensureMaterialized();
    expect(projection.needsMaterialization).toBe(false);
    persistRegistryFixture(subagentRuns, ["already-absent-run"]);
    expect(projection.dirtyRowCount).toBe(0);
    remainingRefreshes = 10;
    await projection.ensureMaterialized();
    expect(projection.needsMaterialization).toBe(false);
    expect(
      projection.snapshot({ agentId: target.agentId, key: target.sessionKey }).row,
    ).toMatchObject({ sessionId: "registry-revision" });
  });
});

it.each([
  "existing",
  "new",
  "native replacement",
  "worker replacement",
  "native reset",
  "worker reset",
] as const)(
  "retains a %s archive publication while cold compact preparation is pending",
  async (kind) => {
    await withRegistryState(async () => {
      setRuntimeConfigSnapshot(cfg);
      clearSubagentRunsReadCacheForTest();
      const key = "agent:main:archive-during-recovery";
      const query = { agentId: "main", key };
      const target = { agentId: "main", sessionKey: key };
      const sessionId = "archive-during-recovery";
      const replacesIdentity = kind.endsWith("replacement");
      const resetsIdentity = kind.endsWith("reset");
      const changesIdentity = replacesIdentity || resetsIdentity;
      const previousSessionId = replacesIdentity ? "archive-before-replacement" : sessionId;
      const archivedEntry = {
        sessionId,
        archivedAt: expect.any(Number),
        ...(resetsIdentity ? { lifecycleRevision: "after-reset" } : {}),
      };
      const anchorKey = "agent:main:archive-recovery-anchor";
      writeRow(anchorKey, { sessionId: "archive-recovery-anchor" });
      if (kind !== "new") {
        writeRow(key, {
          sessionId: previousSessionId,
          ...(resetsIdentity ? { lifecycleRevision: "before-reset" } : {}),
        });
      }
      using _ = holdForeground();
      const context = createDirectChatContext({
        getRuntimeConfig: () => cfg,
        loadGatewayModelCatalog: async () => [],
      });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      using projection = await createTestProjection({ cfg, context, modelCatalog: [] });
      let recovery: Promise<unknown> | undefined;
      try {
        bindSessionRowProjection(context, () => projection);
        await projection.ensureMaterialized();
        const captured = projection.capture(query);
        expect(captured?.entry?.sessionId).toBe(kind === "new" ? undefined : previousSessionId);
        const executeRead = stateReads.executeExistingOpenClawStateRead;
        vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(
          async (...args) => {
            const result = await executeRead(...args);
            if (args[1].type === "subagents.sessionList") {
              entered.resolve();
              await release.promise;
            }
            return result;
          },
        );
        clearSubagentRunsReadCacheForTest();
        recovery = prepareSubagentSessionListReadCache().then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await entered.promise;
        expect(getSubagentSessionListReadSnapshotIdentity()).toBeUndefined();
        if (kind === "existing") {
          const respond = vi.fn<RespondFn>();
          await sessionMutationHandlers["sessions.patch"]!({
            req: { type: "req", id: "archive-during-recovery", method: "sessions.patch" },
            params: { key, archived: true, expectedSessionId: sessionId },
            client: makeGatewayClient({
              connId: "archive-during-recovery-client",
              clientId: "openclaw-control-ui",
              mode: "webchat",
              scopes: ["operator.read", "operator.write"],
            }),
            isWebchatConnect: () => false,
            context,
            respond,
          });
          expect(respond).toHaveBeenCalledTimes(1);
          expect(respond.mock.calls[0]?.[0]).toBe(true);
        } else if (changesIdentity) {
          const entry = {
            sessionId,
            updatedAt: 2,
            archivedAt: 2,
            ...(resetsIdentity ? { lifecycleRevision: "after-reset" } : {}),
          };
          if (kind.startsWith("worker")) {
            expect(isMainThread).toBe(true);
            const publications: Array<ReturnType<typeof readPreparedSessionEntryChange>> = [];
            const stop = onSessionIdentityMutation((mutation) => {
              if ("current" in mutation && mutation.current.sessionKeys.includes(key)) {
                publications.push(readPreparedSessionEntryChange(mutation, key));
              }
            });
            try {
              await applySessionEntryExactReplacements({
                agentId: target.agentId,
                storePath: captured!.storeTarget.storePath,
                sessionKeys: [key],
                update: ([row]) => ({
                  result: undefined,
                  replacements: [{ sessionKey: key, entry: { ...row!.entry, ...entry } }],
                }),
              });
              expect(publications).toEqual([
                expect.objectContaining({
                  entry: expect.objectContaining(entry),
                  source: expect.objectContaining({ revision: expect.any(Number) }),
                }),
              ]);
            } finally {
              stop();
            }
          } else {
            replaceSessionEntrySync(target, entry);
          }
        } else {
          replaceSessionEntrySync(target, { sessionId, updatedAt: 2, archivedAt: 2 });
        }
        const archived = loadSessionEntry(target);
        expect(archived).toMatchObject(archivedEntry);
        expect(projection.sharingTarget(query)?.entry).toMatchObject({
          ...archivedEntry,
          archivedAt: archived?.archivedAt,
        });
        if (changesIdentity) {
          expect(captured).toBeDefined();
          expect(projection.isCurrent(captured!)).toBe(false);
          const pending = projection.capture(query);
          expect(pending?.entry).toBeUndefined();
          expect(pending?.storedEntry).toMatchObject({
            ...archivedEntry,
            archivedAt: archived?.archivedAt,
          });
          if (replacesIdentity) {
            expect(
              projection.findBySessionId({ agentId: "main", sessionId: previousSessionId }),
            ).toEqual([]);
          }
        }
        release.resolve();
        expect(await recovery).toEqual({ value: undefined });
        await projection.ensureMaterialized();
        if (changesIdentity) {
          expect(projection.isCurrent(captured!)).toBe(false);
          expect(projection.capture(query)?.entry).toMatchObject({
            ...archivedEntry,
            archivedAt: archived?.archivedAt,
          });
        }
        const active = await listProjectedSessions({ projection, opts: { archived: false } });
        const archives = await listProjectedSessions({ projection, opts: { archived: true } });
        expect(active.sessions.map((row) => row.key)).toEqual([anchorKey]);
        expect(archives.sessions).toEqual([
          expect.objectContaining({ key, sessionId, archivedAt: archived?.archivedAt }),
        ]);
      } finally {
        release.resolve();
        await recovery;
      }
    });
  },
);

it.each([
  { publication: "broad-ownership", archived: true },
  { publication: "clear", archived: false },
  { publication: "persistence", archived: false },
  { publication: "keyed-ownership", archived: false },
  { publication: "keyed-swarm", archived: false },
] as const)(
  "refreshes subagent facts before synchronous $publication observers (archived=$archived)",
  async ({ publication, archived }) => {
    await withRegistryState(async () => {
      const child = "agent:main:child",
        parent = "agent:main:parent",
        nextParent = "agent:main:next";
      const keys = [child, parent, nextParent, "agent:main:unrelated"];
      for (const key of keys) {
        writeRow(key, archived && key === child ? { archivedAt: 1 } : {});
      }
      const run = createSubagentRunRecord({
        runId: "run",
        childSessionKey: child,
        requesterSessionKey: parent,
        requesterAgentId: "main",
        swarmRequesterSessionKey: parent,
        groupId: "group",
        collect: true,
        requesterDisplayKey: "parent",
        task: "Synthetic task",
        createdAt: 1,
        execution: { status: "running", startedAt: 1 },
        delivery: { status: "not_required" },
      });
      using _ = holdSubagentExecution(run.runId, child);
      subagentRuns.set(run.runId, run);
      if (archived) {
        persistRegistryFixture(subagentRuns);
      }
      using projection = await createTestProjection({ cfg });
      await projection.ensureMaterialized();
      const reads = vi.spyOn(materialization, "readSessionRowEntry");
      const childLinks = vi.spyOn(rowProjection, "projectSessionRowChildLinks");
      const snapshot = (key = child) =>
        archived && key === child ? undefined : projection.snapshot({ agentId: "main", key }).row;
      keys.forEach((key) => snapshot(key));
      childLinks.mockClear();
      let observed: ReturnType<typeof snapshot> | undefined;
      let observedParents: string[][] | undefined;
      using cleanup = new DisposableStack();
      cleanup.defer(
        sessionChanges.subscribe(() => {
          observed = snapshot();
          observedParents = [parent, nextParent].map((parentSessionKey) =>
            projection.selectEntries({ parentSessionKey }).map((row) => row.key),
          );
        }),
      );
      expect(snapshot()?.controlOwnerSessionKey).toBe(archived ? undefined : parent);
      const moved = publication !== "clear";
      const swarmOnly = publication === "keyed-swarm";
      const owner = swarmOnly ? parent : nextParent;
      if (moved) {
        const replacement = {
          ...run,
          ...(swarmOnly
            ? { collectorCompletion: { status: "done" as const } }
            : { requesterSessionKey: nextParent, swarmRequesterSessionKey: nextParent }),
        };
        subagentRuns.set(run.runId, replacement);
        // Control reflects the current executor immediately; navigation waits for publication.
        expect(snapshot()?.controlOwnerSessionKey).toBe(archived ? undefined : owner);
        if (publication === "broad-ownership") {
          publishSubagentRunChanges();
        } else if (publication.startsWith("keyed")) {
          subagentRuns.commitOwnership(replacement);
        } else {
          persistRegistryFixture(subagentRuns, [run.runId]);
        }
      } else {
        subagentRuns.clear();
      }
      expect(observed?.key).toBe(archived ? undefined : child);
      expect(observed?.controlOwnerSessionKey).toBe(!archived && moved ? owner : undefined);
      expect(observedParents).toEqual(swarmOnly ? [[child], []] : [[], moved ? [child] : []]);
      if (archived) {
        expect(projection.capture({ agentId: "main", key: child })?.materialized).toBeUndefined();
      }
      await projection.ensureMaterialized();
      expect(snapshot(swarmOnly ? nextParent : parent)?.childSessions).toBeUndefined();
      expect(snapshot(owner)?.childSessions).toEqual(moved ? [child] : undefined);
      if (publication !== "persistence") {
        expect(snapshot(swarmOnly ? nextParent : parent)?.swarm).toBeUndefined();
        const swarm = snapshot(owner)?.swarm;
        if (moved) {
          expect(swarm?.groups).toEqual([
            expect.objectContaining({ groupId: "group", [swarmOnly ? "done" : "running"]: 1 }),
          ]);
        } else {
          expect(swarm).toBeUndefined();
        }
        expect(reads).not.toHaveBeenCalled();
      }
      keys.forEach((key) => snapshot(key));
      if (publication.startsWith("keyed")) {
        expect(childLinks).toHaveBeenCalledTimes(swarmOnly ? 1 : 2);
      }
    });
  },
);

it("keeps current row facts when the subagent snapshot changes during a list", async () => {
  await withRegistryState(async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:dashboard:registry-refresh" };
    const entry = { sessionId: "registry-refresh", updatedAt: 1, label: "Previous" };
    replaceSessionEntrySync(scope, entry);
    using _ = holdForeground();
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    await projection.ensureMaterialized();
    const reads: string[][] = [];
    observeRowFacts((owner) => async (input) => {
      const reply = await owner.readRowFacts(input);
      reads.push([...input.sessionKeys]);
      if (reads.length === 1) {
        const previous = getSubagentSessionListReadSnapshotIdentity();
        const run = createSubagentRunRecord({
          runId: "unrelated-refresh-run",
          childSessionKey: "agent:main:unrelated-child",
          requesterSessionKey: "agent:main:unrelated-parent",
          generation: 1,
          delivery: { status: "not_required" },
        });
        persistRegistryFixture(new Map([[run.runId, run]]));
        expect(getSubagentSessionListReadSnapshotIdentity()).not.toBe(previous);
      }
      return reply;
    });
    replaceSessionEntrySync(scope, { ...entry, updatedAt: 2, label: "Current" });
    sessionChanges.emit({ ...scope, factsInvalidated: true });
    const result = await listProjectedSessions({ projection, opts: { limit: 1 } });
    expect(result.sessions).toMatchObject([{ key: scope.sessionKey, label: "Current" }]);
    expect(reads).toEqual([[scope.sessionKey]]);
  });
});
