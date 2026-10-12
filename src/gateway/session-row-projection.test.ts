import { performance } from "node:perf_hooks";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { ready } from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";
import * as rowInputs from "./session-utils-row.js";
import type { SessionsListResult } from "./session-utils.types.js";

afterEach(() => vi.restoreAllMocks());

it("resolves agent-scoped legacy locators from resident topology for reads and dirty publications", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const locator = state.statePath("shared", "sessions.json");
    const cfg = {
      agents: { entries: { main: {}, work: {} }, defaults: { sessionStore: { agentId: "main" } } },
      session: { store: locator },
    };
    for (const agentId of ["main", "work"]) {
      replaceSessionEntrySync(
        { agentId, sessionKey: "global", storePath: locator },
        { sessionId: `${agentId}-alias`, updatedAt: 1 },
      );
    }
    const projection = await createSessionRowProjection({ cfg });
    await projection.ensureMaterialized();
    try {
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
      expect(
        projection.snapshot({ agentId: "main", key: "global", storePath: locator }).row?.sessionId,
      ).toBe("main-alias");
      expect(projection.describe({ agentId: "work", key: "global", storePath: locator })).toBe(
        work,
      );
      await projection.ensureMaterialized();
      expect(projection.materializedCount - before).toBe(1);
      sessionChanges.emit({ all: true, scope: { storePath: locator } });
      expect(projection.dirtyRowCount).toBe(2);
      await projection.ensureMaterialized();
    } finally {
      projection.dispose();
    }
  });
});

it("keeps session-ID aliases out of exact-key describe", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:actual" },
      { sessionId: "agent:main:missing", updatedAt: 1 },
    );
    const projection = await createSessionRowProjection({ cfg });
    await projection.ensureMaterialized();
    try {
      expect(projection.snapshot({ agentId: "main", key: "agent:main:missing" }).row).toBeNull();
      expect(
        projection.snapshot({ agentId: "main", key: "agent:main:actual" }).row?.sessionId,
      ).toBe("agent:main:missing");
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:missing" },
        { sessionId: "new-session", updatedAt: 2 },
      );
      await projection.ensureMaterialized();
      expect(
        projection.snapshot({ agentId: "main", key: "agent:main:missing" }).row?.sessionId,
      ).toBe("new-session");
      expect(projection.selectEntries().filter(ready)).toHaveLength(2);
    } finally {
      projection.dispose();
    }
  });
});

it("materializes the committed row through its main alias", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const scope = { agentId: "main", sessionKey: "agent:main:main" };
    replaceSessionEntrySync(scope, { sessionId: "old", updatedAt: 1, label: "before" });
    const projection = await createSessionRowProjection({ cfg });
    await projection.ensureMaterialized();
    try {
      replaceSessionEntrySync(scope, { sessionId: "old", updatedAt: 2, label: "after" });
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key: "main" }).row).toMatchObject({
        sessionId: "old",
        label: "after",
      });
    } finally {
      projection.dispose();
    }
  });
});

it("settles a committed write queued while the previous materialization is finishing", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:finishing-write";
    const scope = { agentId: "main", sessionKey: key };
    const cfg = { agents: { entries: { main: {} } } };
    const entry = { sessionId: "finishing-write", updatedAt: 1 };
    replaceSessionEntrySync(scope, entry);
    const projection = await createSessionRowProjection({ cfg });
    await projection.ensureMaterialized();
    try {
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
      expect(projection.snapshot({ agentId: "main", key }).row?.label).toBe("latest");
    } finally {
      projection.dispose();
    }
  });
});

it("reprocesses activity-summary policy when config changes during materialization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    let cfg = {
      agents: {
        entries: { main: {}, work: {} },
        defaults: { sessionStore: { agentId: "main" }, utilityModel: "unit-test/small" },
      },
    };
    const targets = ["main", "work"].flatMap((agentId) =>
      Array.from({ length: 80 }, (_, index) => ({
        agentId,
        key: `agent:${agentId}:policy-${index}`,
      })),
    );
    for (const target of targets) {
      replaceSessionEntrySync(
        { agentId: target.agentId, sessionKey: target.key },
        { sessionId: target.key, updatedAt: 1, displayName: "Policy fixture" },
      );
    }
    const projection = await createSessionRowProjection({
      cfg,
      getConfig: () => cfg,
      getModelCatalog: async () => [],
    });
    await projection.ensureMaterialized();
    try {
      for (const target of targets) {
        expect(projection.snapshot(target).row?.activitySummary?.state).toBe("stale");
      }
      const readInputs = rowInputs.readSessionRowInputs;
      vi.spyOn(rowInputs, "readSessionRowInputs").mockImplementationOnce((params) => {
        cfg = {
          ...cfg,
          agents: { ...cfg.agents, defaults: { ...cfg.agents.defaults, utilityModel: "" } },
        };
        sessionChanges.emit({ all: true, scope: "config" });
        return readInputs(params);
      });
      sessionChanges.emit({ all: true, scope: "acp" });
      await projection.ensureMaterialized();
      expect(projection.dirtyRowCount).toBe(0);
      for (const target of targets) {
        expect(projection.snapshot(target).row?.activitySummary?.state).toBe("unavailable");
      }
      cfg = {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: { ...cfg.agents.defaults, utilityModel: "unit-test/small" },
        },
      };
      sessionChanges.emit({ all: true, scope: "config" });
      await projection.ensureMaterialized();
      for (const target of targets) {
        expect(projection.snapshot(target).row?.activitySummary?.state).toBe("stale");
      }
    } finally {
      projection.dispose();
    }
  });
});

it.each(["static", "unowned-map", "empty-map"] as const)(
  "reprocesses utility policy after a synchronous model publication (catalog reader: %s)",
  async (catalogReader) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {
        agents: {
          entries: { main: {} },
          defaults: { model: "fixture/primary" },
        },
      };
      const publish = (enabled: boolean) => {
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
      };
      publish(true);
      const targets = ["first", "middle", "last"].map((name) => ({
        agentId: "main",
        key: `agent:main:publication-${name}`,
      }));
      try {
        for (const target of targets) {
          replaceSessionEntrySync(
            { agentId: target.agentId, sessionKey: target.key },
            { sessionId: target.key, updatedAt: 1, displayName: "Publication fixture" },
          );
        }
        const projection = await createSessionRowProjection({
          cfg,
          ...(catalogReader === "static"
            ? { modelCatalog: [] }
            : {
                getModelCatalog: async () =>
                  catalogReader === "empty-map" ? new Map() : new Map([["main", { entries: [] }]]),
              }),
        });
        await projection.ensureMaterialized();
        try {
          for (const target of targets) {
            expect(projection.snapshot(target).row?.activitySummary?.state).toBe("stale");
          }
          // Keep the publication and following rows in one deterministic synchronous slice.
          const clock = vi.spyOn(performance, "now").mockReturnValue(0);
          try {
            const readInputs = rowInputs.readSessionRowInputs;
            vi.spyOn(rowInputs, "readSessionRowInputs").mockImplementationOnce((params) => {
              publish(false);
              notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
              return readInputs(params);
            });
            sessionChanges.emit({ all: true, scope: "catalog" });
            await listProjectedSessions({ projection, opts: {} });
          } finally {
            clock.mockRestore();
          }
          expect(projection.dirtyRowCount).toBe(0);
          for (const target of targets) {
            expect(projection.snapshot(target).row?.activitySummary?.state).toBe("unavailable");
          }
        } finally {
          projection.dispose();
        }
      } finally {
        setCurrentPluginMetadataSnapshot(undefined);
      }
    });
  },
);

it("keeps cross-agent inheritance bound to a stored qualified parent", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: { entries: { main: {}, work: {} }, defaults: { sessionStore: { agentId: "main" } } },
      session: { scope: "global" as const },
    };
    for (const [agentId, sessionKey, label] of [
      ["main", "global", "main-global"],
      ["work", "global", "work-global"],
      ["work", "agent:work:main", "work"],
    ] as const) {
      replaceSessionEntrySync(
        { agentId, sessionKey },
        {
          sessionId: `${label}-parent`,
          updatedAt: 1,
          providerOverride: "unit-test",
          modelOverride: `${label}-model`,
        },
      );
    }
    const key = "agent:main:child";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      { sessionId: "child", updatedAt: 2, parentSessionKey: "agent:work:main" },
    );
    const projection = await createSessionRowProjection({ cfg });
    await projection.ensureMaterialized();
    try {
      expect(projection.snapshot({ agentId: "main", key }).row).toMatchObject({
        parentSessionKey: "agent:work:main",
        model: "work-model",
        modelOverrideSource: "inherited",
      });
      expect(
        projection.selectEntries({ agentId: "work", parentSessionKey: "agent:work:main" }),
      ).toEqual([]);
      expect(
        projection
          .selectEntries({ agentId: "main", parentSessionKey: "agent:work:main" })
          .map((row) => row.key),
      ).toEqual([key]);
      replaceSessionEntrySync(
        { agentId: "work", sessionKey: "agent:work:main" },
        {
          sessionId: "work-parent",
          updatedAt: 3,
          providerOverride: "unit-test",
          modelOverride: "updated-work-model",
        },
      );
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key }).row).toMatchObject({
        parentSessionKey: "agent:work:main",
        model: "updated-work-model",
        modelOverrideSource: "inherited",
      });
      await deleteSessionEntryLifecycle({
        agentId: "work",
        storePath: projection.capture({ agentId: "work", key: "agent:work:main" })!.storeTarget
          .storePath,
        archiveTranscript: false,
        target: { canonicalKey: "agent:work:main", storeKeys: ["agent:work:main"] },
      });
      await projection.ensureMaterialized();
      // Check the parent index before a keyed read can repair stale lineage.
      expect(
        projection.selectEntries({ parentSessionKey: "global" }).map((row) => row.key),
      ).toEqual([key]);
      expect(projection.snapshot({ agentId: "main", key }).row).toMatchObject({
        parentSessionKey: "global",
        model: "work-global-model",
        modelOverrideSource: "inherited",
      });
      replaceSessionEntrySync(
        { agentId: "work", sessionKey: "agent:work:main" },
        {
          sessionId: "restored-work-parent",
          updatedAt: 4,
          providerOverride: "unit-test",
          modelOverride: "restored-work-model",
        },
      );
      await projection.ensureMaterialized();
      expect(
        projection
          .selectEntries({ agentId: "main", parentSessionKey: "agent:work:main" })
          .map((row) => row.key),
      ).toEqual([key]);
      expect(projection.selectEntries({ parentSessionKey: "global" })).toEqual([]);
      expect(projection.snapshot({ agentId: "main", key }).row).toMatchObject({
        parentSessionKey: "agent:work:main",
        model: "restored-work-model",
        modelOverrideSource: "inherited",
      });
    } finally {
      projection.dispose();
    }
  });
});

it("inherits a raw sentinel parent from its physical store and refreshes its dependents", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("shared.sqlite");
    let cfg = {
      agents: {
        ownership: "explicit" as const,
        entries: { main: {}, work: {} },
        defaults: { sessionStore: { agentId: "work" } },
      },
      session: { scope: "global" as const, store: storePath },
    };
    openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    const parent = {
      sessionId: "work-parent",
      updatedAt: 1,
      providerOverride: "unit-test",
      modelOverride: "before",
    };
    replaceSessionEntrySync({ agentId: "work", storePath, sessionKey: "global" }, parent);
    const key = "agent:main:child";
    replaceSessionEntrySync(
      { agentId: "main", storePath, sessionKey: key },
      { sessionId: "child", updatedAt: Date.now(), parentSessionKey: "global" },
    );
    const projection = await createSessionRowProjection({ cfg, getConfig: () => cfg });
    try {
      expect(projection.snapshot({ agentId: "main", key }).row?.model).toBe("before");
      replaceSessionEntrySync(
        { agentId: "work", storePath, sessionKey: "global" },
        { ...parent, modelOverride: "after" },
      );
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key }).row?.model).toBe("after");
      expect(projection.snapshot({ agentId: "work", key: "global" }).row?.childSessions).toEqual([
        key,
      ]);
      const oldOwner = projection.describe({ agentId: "work", key: "global" })!;
      cfg = { ...cfg, agents: { ...cfg.agents, defaults: { sessionStore: { agentId: "main" } } } };
      sessionChanges.emit({ all: true, scope: "config" });
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "work", key: "global" }).row).toBeNull();
      expect(projection.snapshot({ agentId: "main", key: "global" }).row?.sessionId).toBe(
        "work-parent",
      );
      expect(projection.isCurrent(oldOwner)).toBe(false);
    } finally {
      projection.dispose();
    }
  });
});

it("assigns a newly committed unknown row to its logical store owner", async () => {
  const key = "unknown";
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("shared.sqlite");
    const cfg = {
      agents: {
        ownership: "explicit" as const,
        entries: { main: {}, work: {} },
        defaults: { sessionStore: { agentId: "work" } },
      },
      session: { store: storePath },
    };
    replaceSessionEntrySync(
      { agentId: "main", storePath, sessionKey: "agent:main:seed" },
      { sessionId: "seed", updatedAt: 1 },
    );
    const projection = await createSessionRowProjection({ cfg });
    await projection.ensureMaterialized();
    try {
      replaceSessionEntrySync(
        { agentId: "main", storePath, sessionKey: key },
        { sessionId: "new-sentinel", updatedAt: 2 },
      );
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "work", key }).row?.sessionId).toBe("new-sentinel");
      expect(
        projection
          .selectEntries()
          .filter((row) => row.key === key)
          .map((row) => row.agentId),
      ).toEqual(["work"]);
    } finally {
      projection.dispose();
    }
  });
});

it("accepts a completed catalog when only session data changed during preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const key = "agent:main:catalog-write";
    const entry = { sessionId: "catalog-write", updatedAt: 1 };
    replaceSessionEntrySync({ agentId: "main", sessionKey: key }, entry);
    let changed = false;
    const readCatalog = vi.fn(async () => {
      if (!changed) {
        changed = true;
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: key },
          { ...entry, label: "concurrent write" },
        );
      }
      return [];
    });
    const projection = await createSessionRowProjection({ cfg, getModelCatalog: readCatalog });
    try {
      expect(projection.snapshot({ agentId: "main", key }).row?.label).toBe("concurrent write");
      expect(readCatalog).toHaveBeenCalledTimes(1);
    } finally {
      projection.dispose();
    }
  });
});

it("searches cold archives with worker-prepared facts across publications and lifecycle replacement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const cfg = { agents: { entries: { main: {} } } };
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
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:other" },
      {
        sessionId: "other",
        updatedAt: 2,
        archivedAt: 1,
      },
    );
    const publishAcp = (backend: string) =>
      seedCanonicalAcpSessionMeta({
        sessionKey: key,
        lifecycleRevision: "first",
        meta: {
          backend,
          agent: "main",
          runtimeSessionName: "archived",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 1,
        },
      });
    publishAcp("fixture-runtime-first");
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const list = async (search: string, hasBoard?: boolean) => {
      const reads = observeSqliteReadSql(StatementSync.prototype);
      let result: SessionsListResult | undefined;
      try {
        await sessionReadHandlers["sessions.list"]!({
          req: { type: "req", id: "cold-search", method: "sessions.list" },
          params: { archived: "all", search, hasBoard },
          client: null,
          context,
          isWebchatConnect: () => false,
          respond(ok, value) {
            expect(ok).toBe(true);
            result = value as SessionsListResult;
          },
        });
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
    try {
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
    } finally {
      clock.mockRestore();
      projection.dispose();
      release();
      setCurrentPluginMetadataSnapshot(undefined);
    }
  });
});
