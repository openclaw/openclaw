import { performance } from "node:perf_hooks";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { updateSessionEntry } from "../config/sessions/session-accessor.entry-mutation.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { recordSessionParticipant as recordNativeParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import { recordSessionParticipantInWorker as recordSessionParticipant } from "../config/sessions/session-sharing-store.async.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import {
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { ready } from "./session-row-projection-record.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import {
  createTestProjection,
  holdForeground,
  watchRowFacts as observeRowFacts,
} from "./session-row-projection.read-fixture.test-support.js";
import {
  acpProjectionMeta,
  requestSessionRow,
  withSessionRowProjectionState as withProjectionState,
} from "./session-row-projection.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";
import * as rowInputs from "./session-utils-row.js";
import type { SessionsListResult } from "./session-utils.types.js";
import { reportPlacementTransition } from "./worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

afterEach(() => vi.restoreAllMocks());
const mainConfig = { agents: { entries: { main: {} } } };

function write(key: string, entry: SessionEntry, agentId = "main", storePath?: string) {
  replaceSessionEntrySync({ agentId, sessionKey: key, storePath }, entry);
}

const modelEntry = (sessionId: string, modelOverride: string, updatedAt = 1): SessionEntry => ({
  sessionId,
  updatedAt,
  providerOverride: "unit-test",
  modelOverride,
});

function snapshotRow(
  projection: SessionRowProjection,
  key: string,
  agentId = "main",
  storePath?: string,
) {
  return projection.snapshot({ agentId, key, storePath }).row;
}

function expectSummary(
  projection: SessionRowProjection,
  targets: { agentId: string; key: string }[],
  state: string,
) {
  for (const target of targets) {
    expect(projection.snapshot(target).row?.activitySummary?.state).toBe(state);
  }
}

function sharedStoreAgents() {
  return {
    ownership: "explicit" as const,
    entries: { main: {}, work: {} },
    defaults: { sessionStore: { agentId: "work" } },
  };
}

it("resolves agent-scoped legacy locators from resident topology for reads and dirty publications", () =>
  withProjectionState(async (create, state) => {
    const locator = state.statePath("shared", "sessions.json");
    const cfg = {
      agents: { entries: { main: {}, work: {} }, defaults: { sessionStore: { agentId: "main" } } },
      session: { store: locator },
    };
    for (const agentId of ["main", "work"]) {
      write("global", { sessionId: `${agentId}-alias`, updatedAt: 1 }, agentId, locator);
    }
    const projection = await create({ cfg });
    await projection.ensureMaterialized();
    for (const agentId of ["main", "work"]) {
      projection.describe({ agentId, key: "global" });
    }
    const main = projection.capture({ agentId: "main", key: "global" })!;
    const work = projection.capture({ agentId: "work", key: "global" })!;
    expect(main.storeTarget.storePath).not.toBe(work.storeTarget.storePath);
    const reads = vi.spyOn(DatabaseSync.prototype, "prepare");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    for (const [agentId, record] of [
      ["main", main],
      ["work", work],
    ] as const) {
      expect(projection.capture({ agentId, key: "global", storePath: locator })).toBe(record);
      expect(
        projection.findBySessionId({
          agentId,
          sessionId: `${agentId}-alias`,
          storePath: locator,
        }),
      ).toEqual([record]);
    }
    expect(reads).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    reads.mockRestore();
    exec.mockRestore();
    const before = projection.materializedCount;
    sessionChanges.emit({ agentId: "main", sessionKey: "global", storePath: locator });
    expect(snapshotRow(projection, "global", "main", locator)?.sessionId).toBe("main-alias");
    expect(projection.describe({ agentId: "work", key: "global", storePath: locator })).toBe(work);
    await projection.ensureMaterialized();
    expect(projection.materializedCount - before).toBe(1);
    sessionChanges.emit({ all: true, scope: { storePath: locator } });
    expect(projection.dirtyRowCount).toBe(2);
    await projection.ensureMaterialized();
  }));

it("keeps session-ID aliases out of exact-key describe", () =>
  withProjectionState(async (create) => {
    write("agent:main:actual", { sessionId: "agent:main:missing", updatedAt: 1 });
    const projection = await create({ cfg: mainConfig });
    await projection.ensureMaterialized();
    expect(snapshotRow(projection, "agent:main:missing")).toBeNull();
    expect(snapshotRow(projection, "agent:main:actual")?.sessionId).toBe("agent:main:missing");
    write("agent:main:missing", { sessionId: "new-session", updatedAt: 2 });
    await projection.ensureMaterialized();
    expect(snapshotRow(projection, "agent:main:missing")?.sessionId).toBe("new-session");
    expect(projection.selectEntries().filter(ready)).toHaveLength(2);
  }));

it.each([
  ["agent:main:finishing-write", "agent:main:finishing-write"],
  ["agent:main:main", "main"],
])("settles queued commits through %s while prior materialization finishes", (key, readKey) =>
  withProjectionState(async (create) => {
    const scope = { agentId: "main", sessionKey: key };
    const entry = { sessionId: "finishing-write", updatedAt: 1, label: "before" };
    replaceSessionEntrySync(scope, entry);
    const projection = await create({ cfg: mainConfig });
    await projection.ensureMaterialized();
    projection.describe({ agentId: "main", key });
    const materialize = rowInputs.materializeSessionRow;
    let latestCommitted = false;
    vi.spyOn(rowInputs, "materializeSessionRow").mockImplementationOnce((inputs) => {
      const row = materialize(inputs);
      queueMicrotask(() => {
        replaceSessionEntrySync(scope, { ...entry, updatedAt: 3, label: "latest" });
        latestCommitted = true;
      });
      return row;
    });
    replaceSessionEntrySync(scope, { ...entry, updatedAt: 2, label: "first" });

    await projection.ensureMaterialized();

    expect(latestCommitted).toBe(true);
    expect(projection.dirtyRowCount).toBe(0);
    expect(snapshotRow(projection, readKey)).toMatchObject({
      sessionId: entry.sessionId,
      label: "latest",
    });
  }),
);

it.each(["config", "static", "unowned-map", "empty-map"] as const)(
  "reprocesses activity-summary policy during %s publication",
  (mode) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fromConfig = mode === "config";
      let cfg: OpenClawConfig = fromConfig
        ? {
            agents: {
              entries: { main: {}, work: {} },
              defaults: { sessionStore: { agentId: "main" }, utilityModel: "unit-test/small" },
            },
          }
        : { agents: { entries: { main: {} }, defaults: { model: "fixture/primary" } } };
      const publish = (enabled: boolean) => {
        if (fromConfig) {
          cfg = {
            ...cfg,
            agents: {
              ...cfg.agents,
              defaults: { ...cfg.agents?.defaults, utilityModel: enabled ? "unit-test/small" : "" },
            },
          };
          sessionChanges.emit({ all: true, scope: "config" });
        } else {
          const snapshot = createPluginMetadataSnapshotFixture({
            plugins: [
              {
                id: "fixture",
                providers: ["fixture"],
                modelCatalog: {
                  providers: {
                    fixture: {
                      models: [{ id: "primary" }],
                      ...(enabled ? { defaultUtilityModel: "small" } : {}),
                    },
                  },
                },
              },
            ],
          });
          setCurrentPluginMetadataSnapshot(snapshot, { config: cfg, compatibleConfigs: [cfg] });
        }
      };
      const targets = fromConfig
        ? ["main", "work"].flatMap((agentId) =>
            Array.from({ length: 80 }, (_, index) => ({
              agentId,
              key: `agent:${agentId}:policy-${index}`,
            })),
          )
        : ["first", "middle", "last"].map((name) => ({
            agentId: "main",
            key: `agent:main:publication-${name}`,
          }));
      if (!fromConfig) {
        publish(true);
      }
      using cleanup = new DisposableStack();
      cleanup.defer(() => {
        if (!fromConfig) {
          setCurrentPluginMetadataSnapshot(undefined);
        }
      });
      for (const target of targets) {
        write(target.key, { sessionId: target.key, updatedAt: 1 }, target.agentId);
      }
      using projection = await createTestProjection({
        cfg,
        ...(fromConfig
          ? { getConfig: () => cfg, getModelCatalog: async () => [] }
          : mode === "static"
            ? { modelCatalog: [] }
            : {
                getModelCatalog: async () =>
                  mode === "empty-map" ? new Map() : new Map([["main", { entries: [] }]]),
              }),
      });
      await projection.ensureMaterialized();
      expectSummary(projection, targets, "stale");
      // Catalog publication and the following rows must share one synchronous slice.
      const clock = fromConfig ? undefined : vi.spyOn(performance, "now").mockReturnValue(0);
      try {
        const readInputs = rowInputs.readSessionRowInputs;
        vi.spyOn(rowInputs, "readSessionRowInputs").mockImplementationOnce((params) => {
          publish(false);
          if (!fromConfig) {
            notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
          }
          return readInputs(params);
        });
        sessionChanges.emit({ all: true, scope: fromConfig ? "acp" : "catalog" });
        if (fromConfig) {
          await projection.ensureMaterialized();
        } else {
          await listProjectedSessions({ projection, opts: {} });
        }
      } finally {
        clock?.mockRestore();
      }
      expect(projection.dirtyRowCount).toBe(0);
      expectSummary(projection, targets, "unavailable");
      if (fromConfig) {
        publish(true);
        await projection.ensureMaterialized();
        expectSummary(projection, targets, "stale");
      }
    }),
);

it("retains config changes published while topology discovery is pending", ({ signal }) =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const oldStore = state.statePath("old", "sessions.json");
    const newStore = state.statePath("new", "sessions.json");
    const oldKey = "agent:main:old-topology";
    const newKey = "agent:work:new-topology";
    write(oldKey, { sessionId: "old-topology", updatedAt: 1 }, "main", oldStore);
    write(newKey, { sessionId: "new-topology", updatedAt: 1 }, "work", newStore);
    let cfg = { agents: { entries: { main: {} } }, session: { store: oldStore } };
    setRuntimeConfigSnapshot(cfg);
    const projection = await createSessionRowProjection({ cfg, getConfig: () => cfg });
    const captured = createDeferredCore();
    const release = createDeferredCore();
    let reading: Promise<void> | undefined;
    try {
      await projection.ensureMaterialized();
      const read = stateReads.executeExistingOpenClawStateRead;
      let held = false;
      vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(
        async (...args) => {
          const reply = await read(...args);
          if (args[1].type === "agentDatabaseDeletion.snapshot" && !held) {
            held = true;
            captured.resolve();
            await release.promise;
          }
          return reply;
        },
      );
      sessionChanges.emit({ all: true, scope: "config" });
      reading = projection.ensureMaterialized();
      await withinTest(
        awaitGateBeforeSettlement(captured.promise, reading, "Topology discovery was not held"),
        signal,
      );
      const latestConfig = {
        agents: { entries: { main: {}, work: {} } },
        session: { store: newStore },
      };
      cfg = latestConfig;
      setRuntimeConfigSnapshot(cfg);
      release.resolve();
      await withinTest(reading, signal);

      expect(projection.state.cfg).toEqual(latestConfig);
      expect(snapshotRow(projection, newKey, "work", newStore)).toMatchObject({
        sessionId: "new-topology",
      });
    } finally {
      release.resolve();
      await Promise.allSettled(reading ? [reading] : []);
      projection.dispose();
    }
  }));

it("keeps cross-agent inheritance bound to a stored qualified parent", () =>
  withProjectionState(async (create) => {
    const cfg = {
      agents: { entries: { main: {}, work: {} }, defaults: { sessionStore: { agentId: "main" } } },
      session: { scope: "global" as const },
    };
    for (const [agentId, sessionKey, label] of [
      ["main", "global", "main-global"],
      ["work", "global", "work-global"],
      ["work", "agent:work:main", "work"],
    ] as const) {
      write(sessionKey, modelEntry(`${label}-parent`, `${label}-model`), agentId);
    }
    const key = "agent:main:child";
    write(key, { sessionId: "child", updatedAt: 2, parentSessionKey: "agent:work:main" });
    const projection = await create({ cfg });
    const parentKey = "agent:work:main";
    const writeParent = (sessionId: string, updatedAt: number, modelOverride: string) =>
      write(parentKey, modelEntry(sessionId, modelOverride, updatedAt), "work");
    const children = (parentSessionKey: string, agentId?: string) =>
      projection.selectEntries({ agentId, parentSessionKey }).map((child) => child.key);
    const expectInherited = (parentSessionKey: string, model: string) =>
      expect(snapshotRow(projection, key)).toMatchObject({
        parentSessionKey,
        model,
        modelOverrideSource: "inherited",
      });
    await projection.ensureMaterialized();
    expectInherited(parentKey, "work-model");
    expect(children(parentKey, "work")).toEqual([]);
    expect(children(parentKey, "main")).toEqual([key]);
    expect(children("AGENT:WORK:MAIN", "main")).toEqual([key]);
    expect(
      projection
        .selectEntries({
          agentId: "main",
          parentSessionKey: projection.describe({ agentId: "work", key: parentKey })!,
        })
        .map((child) => child.key),
    ).toEqual([key]);
    writeParent("work-parent", 3, "updated-work-model");
    await projection.ensureMaterialized();
    expectInherited(parentKey, "updated-work-model");
    await deleteSessionEntryLifecycle({
      agentId: "work",
      storePath: projection.capture({ agentId: "work", key: "agent:work:main" })!.storeTarget
        .storePath,
      archiveTranscript: false,
      target: { canonicalKey: "agent:work:main", storeKeys: ["agent:work:main"] },
    });
    await projection.ensureMaterialized();
    // Check the parent index before a keyed read can repair stale lineage.
    expect(children("global")).toEqual([key]);
    expectInherited("global", "work-global-model");
    writeParent("restored-work-parent", 4, "restored-work-model");
    await projection.ensureMaterialized();
    expect(children(parentKey, "main")).toEqual([key]);
    expect(projection.selectEntries({ parentSessionKey: "global" })).toEqual([]);
    expectInherited(parentKey, "restored-work-model");
  }));

it.each(["global", "unknown"])(
  "inherits a raw %s parent from its physical store and refreshes its dependents",
  (sentinel) =>
    withProjectionState(async (create, state) => {
      const storePath = state.statePath("shared.sqlite");
      let cfg = {
        agents: sharedStoreAgents(),
        session: { scope: "global" as const, store: storePath },
      };
      openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      const parent = modelEntry("work-parent", "before");
      write(sentinel, parent, "work", storePath);
      const key = "agent:main:child";
      write(
        key,
        { sessionId: "child", updatedAt: Date.now(), parentSessionKey: sentinel },
        "main",
        storePath,
      );
      const projection = await create({ cfg, getConfig: () => cfg });
      expect(snapshotRow(projection, key)?.model).toBe("before");
      write(sentinel, { ...parent, modelOverride: "after" }, "work", storePath);
      await projection.ensureMaterialized();
      expect(snapshotRow(projection, key)?.model).toBe("after");
      expect(snapshotRow(projection, sentinel, "work")?.childSessions).toEqual([key]);
      const oldOwner = projection.describe({ agentId: "work", key: sentinel })!;
      expect(
        projection.selectEntries({ parentSessionKey: oldOwner }).map((row) => row.key),
      ).toEqual([key]);
      cfg = {
        ...cfg,
        agents: { ...cfg.agents, defaults: { sessionStore: { agentId: "main" } } },
      };
      sessionChanges.emit({ all: true, scope: "config" });
      await projection.ensureMaterialized();
      expect(snapshotRow(projection, sentinel, "work")).toBeNull();
      expect(snapshotRow(projection, sentinel)?.sessionId).toBe("work-parent");
      expect(projection.isCurrent(oldOwner)).toBe(false);
    }),
);

it("assigns a newly committed unknown row to its logical store owner", async () => {
  const key = "unknown";
  await withProjectionState(async (create, state) => {
    const storePath = state.statePath("shared.sqlite");
    const cfg = {
      agents: sharedStoreAgents(),
      session: { store: storePath },
    };
    write("agent:main:seed", { sessionId: "seed", updatedAt: 1 }, "main", storePath);
    const projection = await create({ cfg });
    await projection.ensureMaterialized();
    write(key, { sessionId: "new-sentinel", updatedAt: 2 }, "main", storePath);
    await projection.ensureMaterialized();
    expect(projection.snapshot({ agentId: "work", key }).row?.sessionId).toBe("new-sentinel");
    expect(
      projection
        .selectEntries()
        .filter((row) => row.key === key)
        .map((row) => row.agentId),
    ).toEqual(["work"]);
  });
});

it("accepts a completed catalog when only session data changed during preparation", () =>
  withProjectionState(async (create) => {
    const key = "agent:main:catalog-write";
    const entry = { sessionId: "catalog-write", updatedAt: 1 };
    write(key, entry);
    let changed = false;
    const readCatalog = vi.fn(async () => {
      if (!changed) {
        changed = true;
        write(key, { ...entry, label: "concurrent write" });
      }
      return [];
    });
    const projection = await create({ cfg: mainConfig, getModelCatalog: readCatalog });
    expect(snapshotRow(projection, key)?.label).toBe("concurrent write");
    expect(readCatalog).toHaveBeenCalledTimes(1);
  }));

it("searches cold archives with worker-prepared facts across publications and lifecycle replacement", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const cfg = mainConfig;
    setRuntimeConfigSnapshot(cfg);
    setCurrentPluginMetadataSnapshot(createPluginMetadataSnapshotFixture(), {
      config: cfg,
      compatibleConfigs: [cfg],
    });
    const key = "agent:main:acp:archived";
    const target = { agentId: "main", sessionKey: key };
    const entry = {
      sessionId: "archived",
      updatedAt: 1,
      archivedAt: 1,
      lifecycleRevision: "first",
    };
    replaceSessionEntrySync(target, entry);
    write("agent:main:other", {
      sessionId: "other",
      updatedAt: 2,
      archivedAt: 1,
    });
    const publishAcp = (backend: string) =>
      seedCanonicalAcpSessionMeta({
        sessionKey: key,
        lifecycleRevision: "first",
        meta: acpProjectionMeta(backend, "archived"),
      });
    publishAcp("fixture-runtime-first");
    using cleanup = new DisposableStack();
    cleanup.defer(() => setCurrentPluginMetadataSnapshot(undefined));
    using _ = holdForeground();
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    using clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    void clock;
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const list = async (search: string, hasBoard?: boolean) => {
      const reads = observeSqliteReadSql(StatementSync.prototype);
      let result: SessionsListResult | undefined;
      try {
        await requestSessionRow(
          sessionReadHandlers["sessions.list"]!,
          context,
          "sessions.list",
          { archived: "all", search, hasBoard },
          (ok, value) => {
            expect(ok).toBe(true);
            result = value as SessionsListResult;
          },
        );
        expect(result).toBeDefined();
        expect(
          reads.queries.filter((sql) =>
            /acp_sessions|config_machine_state|board_tabs|session_participants/.test(sql),
          ),
          search,
        ).toEqual([]);
        return result!;
      } finally {
        reads.restore();
      }
    };
    await projection.ensureMaterialized();
    expect(projection.materializedCount).toBe(0);
    expect((await list("unmatched-search-needle")).sessions).toEqual([]);
    expect(projection.materializedCount).toBe(0);
    const original = await list("fixture-runtime-first");
    expect(original.sessions).toEqual([
      expect.objectContaining({
        key,
        sessionId: "archived",
        archivedAt: 1,
        agentRuntime: expect.objectContaining({ id: "fixture-runtime-first" }),
        runtimeSelectionLocked: true,
      }),
    ]);
    sessionChanges.emit({ all: true, scope: "catalog" });
    await projection.ensureMaterialized();
    const repeated = await list("fixture-runtime-first");
    expect(repeated).toEqual(original);
    sessionChanges.emit({ all: true, scope: "config" });
    await projection.ensureMaterialized();
    publishAcp("fixture-runtime-next");
    expect((await list("fixture-runtime-first")).sessions).toEqual([]);
    expect((await list("fixture-runtime-next")).sessions.map((row) => row.key)).toEqual([key]);
    const board = new SqliteBoardStore({
      resolveSession: ({ sessionKey }) => ({ agentId: "main", sessionKey }),
    });
    await board.putWidget({
      sessionKey: key,
      name: "status",
      content: { kind: "html", html: "<p>Ready</p>" },
    });
    expect((await list("fixture-runtime-next", true)).sessions.map((row) => row.key)).toEqual([
      key,
    ]);
    expect((await list("fixture-runtime-next", false)).sessions).toEqual([]);
    replaceSessionEntrySync(target, { ...entry, lifecycleRevision: "replacement", updatedAt: 2 });
    expect((await list("fixture-runtime-next")).sessions).toEqual([]);
  }));

function sessionDescriber(context: ReturnType<typeof requestContext>, key: string) {
  return async (expected: Record<string, unknown>) => {
    const respond = vi.fn();
    await requestSessionRow(
      sessionByKeyReadHandlers["sessions.describe"]!,
      context,
      "sessions.describe",
      { key },
      respond,
    );
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
      session: expect.objectContaining(expected),
    });
    return respond;
  };
}

it("publishes local placement receipts without rereading or adopting another store's facts", async () => {
  await withProjectionState(async (create, state, cleanup) => {
    const cfg = mainConfig;
    const target = {
      agentId: "main",
      sessionKey: "agent:main:local-placement-receipt",
      sessionId: "local-placement-receipt",
    };
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
    const database = openOpenClawStateDatabase();
    let nowMs = 10;
    const placements = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    const projection = await create({
      cfg,
      modelCatalog: [],
      placementFactsReader: placements,
    });
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const read = sessionDescriber(context, target.sessionKey);
    const describe = (updatedAtMs: number) =>
      read({ placement: expect.objectContaining({ state: "local", updatedAtMs }) });
    const claimInput = {
      ...target,
      claimId: "receipt-claim",
      runId: "receipt-run",
      owner: { kind: "local" as const },
    };
    const resumeRead = createDeferredCore();
    cleanup.defer(resumeRead.resolve);
    await projection.ensureMaterialized();
    const readProjection = placements.readProjection.bind(placements);
    const reads = vi.spyOn(placements, "readProjection");
    const rowReads = vi.spyOn(history, "withSessionHistoryWorkerDatabases");
    const metadataReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const claim = await placements.claimTurn(claimInput);
    await describe(10);
    nowMs = 20;
    await placements.releaseTurn(claim);
    await describe(20);
    expect(reads).not.toHaveBeenCalled();
    expect(rowReads).not.toHaveBeenCalled();
    expect(
      metadataReads.mock.calls.filter(([, command]) => command.type === "sessionRows.sharedFacts"),
    ).toEqual([]);

    const reading = createDeferredCore();
    reads.mockImplementationOnce(async (...args) => {
      const snapshot = await readProjection(...args);
      reading.resolve();
      await resumeRead.promise;
      return snapshot;
    });
    sessionChanges.emit(target);
    await reading.promise;
    nowMs = 30;
    const next = await placements.claimTurn({ ...claimInput, claimId: "next-receipt-claim" });
    resumeRead.resolve();
    await describe(30);
    expect(reads).toHaveBeenCalledTimes(1);
    await placements.releaseTurn(next);

    reads.mockClear();
    const other = createWorkerSessionPlacementStore({
      database: openOpenClawStateDatabase({ path: state.statePath("other-state.sqlite") }),
      now: () => 99,
    });
    const otherClaim = await other.claimTurn(claimInput);
    await describe(30);
    expect(reads).toHaveBeenCalled();
    await other.releaseTurn(otherClaim);
    await projection.ensureMaterialized();

    reads.mockClear();
    const shared = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    nowMs = 40;
    const sharedClaim = await shared.claimTurn(claimInput);
    await describe(40);
    expect(reads).not.toHaveBeenCalled();
    nowMs = 50;
    await shared.releaseTurn(sharedClaim);
    await describe(50);
    expect(reads).not.toHaveBeenCalled();
  });
});

it("reuses placement after runtime events and entry writes and refreshes actual placement changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: {
        entries: { main: {} },
        defaults: { model: "unit-test/model", utilityModel: "" },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const target = {
      agentId: "main",
      sessionKey: "agent:main:entry-placement",
      sessionId: "entry-placement",
    };
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
    const placements = createWorkerSessionPlacementStore();
    await placements.startDispatch(target);
    using projection = await createTestProjection({
      cfg,
      modelCatalog: [],
      placementFactsReader: placements,
    });
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const describe = sessionDescriber(context, target.sessionKey);
    const requested = expect.objectContaining({ state: "requested" });

    await projection.ensureMaterialized();
    const reads = vi.spyOn(placements, "readProjection");
    for (let index = 0; index < 3; index++) {
      await persistSessionTranscriptTurn(target, {
        messages: [
          {
            eventId: `entry-message-${index}`,
            message: { role: "user", content: `Message ${index}` },
          },
        ],
        touchSessionEntry: true,
      });
      await describe({ sessionId: target.sessionId, placement: requested });
    }
    await updateSessionEntry(target, () => ({ label: "Updated by the entry worker" }));
    await describe({ label: "Updated by the entry worker", placement: requested });
    expect(reads).not.toHaveBeenCalled();

    const rowFactReads: string[][] = [];
    observeRowFacts((owner) => (input) => {
      rowFactReads.push([...input.sessionKeys]);
      return owner.readRowFacts(input);
    });
    const sharedReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    for (const [index, record] of [recordNativeParticipant, recordSessionParticipant].entries()) {
      const identity = { type: "agent" as const, id: `peer-${index}` };
      for (const promptedAt of [10, 20]) {
        rowFactReads.length = 0;
        sharedReads.mockClear();
        expect(await record(target, { identity, promptedAt })).toBe(
          promptedAt === 10 ? "inserted" : "updated",
        );
        await describe({
          participantCount: index + 1,
          participants: expect.arrayContaining(
            Array.from({ length: index + 1 }, (_, peer) =>
              expect.objectContaining({ identity: { type: "agent", id: `peer-${peer}` } }),
            ),
          ),
          placement: requested,
        });
        if (record === recordSessionParticipant) {
          expect(rowFactReads).toEqual([]);
          expect(
            sharedReads.mock.calls.filter(
              ([, command]) => command.type === "sessionRows.sharedFacts",
            ),
          ).toEqual([]);
        }
      }
    }
    expect(reads).not.toHaveBeenCalled();

    emitSessionLifecycleEvent({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      reason: "worker-runtime-install",
      scope: "runtime",
    });
    await describe({ label: "Updated by the entry worker", placement: requested });
    expect(reads).not.toHaveBeenCalled();

    sessionChanges.emit({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      factsInvalidated: true,
    });
    await describe({ placement: requested });
    expect(reads).toHaveBeenCalled();
    reads.mockClear();

    reportPlacementTransition(
      undefined,
      await placements.fail({ sessionId: target.sessionId, recoveryError: "Worker stopped" }),
    );
    await describe({
      placement: expect.objectContaining({ state: "failed", recoveryError: "Worker stopped" }),
    });
    expect(reads).toHaveBeenCalled();

    replaceSessionEntrySync(target, { sessionId: "replacement-session", updatedAt: 2 });
    const respond = await describe({ sessionId: "replacement-session" });
    expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("session.placement");
  });
});
