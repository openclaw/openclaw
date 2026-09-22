import { renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import * as rowInputs from "./session-utils-row.js";

afterEach(() => vi.restoreAllMocks());

it("resolves agent-scoped legacy locators from resident topology for reads and dirty publications", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const locator = state.statePath("shared", "sessions.json");
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { store: locator },
    };
    for (const agentId of ["main", "work"]) {
      replaceSessionEntrySync(
        { agentId, sessionKey: "global", storePath: locator },
        { sessionId: `${agentId}-alias`, updatedAt: 1 },
      );
    }
    const projection = await createSessionRowProjection({ cfg });
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
      expect(() =>
        projection.snapshot({ agentId: "main", key: "global", storePath: locator }),
      ).toThrow("Await session projection");
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

it("retains current rows across agent scopes without SQLite and refreshes only the committed key", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }, { id: "work" }] } };
    for (const agentId of ["main", "work"]) {
      for (const name of ["parent", "child"]) {
        replaceSessionEntrySync(
          { agentId, sessionKey: `agent:${agentId}:${name}` },
          {
            sessionId: `${agentId}-${name}`,
            updatedAt: Date.now(),
            label: name,
            ...(name === "child" ? { parentSessionKey: `agent:${agentId}:parent` } : {}),
          },
        );
      }
    }
    const projection = await createSessionRowProjection({ cfg });
    try {
      expect(projection.select().length).toBe(4);
      const untouched = projection.describe({ agentId: "work", key: "agent:work:child" });
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      const first = projection.select({ agentId: "main" });
      expect(first.map((record) => record.key)).toEqual(["agent:main:child", "agent:main:parent"]);
      expect(
        projection.snapshot({ agentId: "main", key: "agent:main:parent" }).row?.childSessions,
      ).toEqual(["agent:main:child"]);
      expect(prepares).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
      prepares.mockRestore();
      exec.mockRestore();
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:child" },
        {
          sessionId: "main-child",
          updatedAt: Date.now(),
          label: "changed",
          parentSessionKey: "agent:main:parent",
        },
      );
      await projection.ensureMaterialized();
      expect(
        projection.describe({ agentId: "main", key: "agent:main:child" })?.materialized.row.label,
      ).toBe("changed");
      expect(projection.describe({ agentId: "work", key: "agent:work:child" })).toBe(untouched);
      const clean = vi.spyOn(DatabaseSync.prototype, "prepare");
      expect(projection.select({ parentSessionKey: "agent:main:parent" })).toHaveLength(1);
      expect(projection.snapshot({ agentId: "main", key: "agent:main:child" }).row?.label).toBe(
        "changed",
      );
      expect(clean).not.toHaveBeenCalled();
    } finally {
      projection.dispose();
    }
  });
});

it("keeps session-ID aliases out of exact-key describe", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:actual" },
      { sessionId: "agent:main:missing", updatedAt: 1 },
    );
    const projection = await createSessionRowProjection({ cfg });
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
      expect(projection.select()).toHaveLength(2);
    } finally {
      projection.dispose();
    }
  });
});

it("refreshes dirty canonical rows before presenting their main alias", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:main" },
      { sessionId: "main-session-id", updatedAt: 1, label: "before" },
    );
    const projection = await createSessionRowProjection({ cfg });
    try {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:main" },
        { sessionId: "main-session-id", updatedAt: 2, label: "after" },
      );
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key: "main" }).row?.label).toBe("after");
    } finally {
      projection.dispose();
    }
  });
});

it.each(["reset", "replace"] as const)(
  "keeps the committed same-key row after %s",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const key = "agent:main:session";
      const cfg = { agents: { list: [{ id: "main", default: true }] } };
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        { sessionId: "old", updatedAt: 1 },
      );
      const projection = await createSessionRowProjection({ cfg });
      try {
        const old = projection.describe({ agentId: "main", key });
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: key },
          { sessionId: "new", updatedAt: 2 },
        );
        emitSessionIdentityMutation({
          kind,
          agentId: "main",
          previous: { sessionId: "old", sessionKeys: [key] },
          current: { sessionId: "new", sessionKeys: [key] },
        });
        const current = projection.capture({ agentId: "main", key });
        expect(current).toBeDefined();
        await projection.ensureMaterialized();
        expect(projection.isCurrent(current!)).toBe(true);
        expect(projection.isCurrent(old!)).toBe(false);
        expect(projection.snapshot({ agentId: "main", key }).row?.sessionId).toBe("new");
        expect(old?.entry.sessionId).toBe("old");
      } finally {
        projection.dispose();
      }
    });
  },
);

it("settles a committed write queued while the previous materialization is finishing", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:finishing-write";
    const scope = { agentId: "main", sessionKey: key };
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const entry = { sessionId: "finishing-write", updatedAt: 1 };
    replaceSessionEntrySync(scope, entry);
    const projection = await createSessionRowProjection({ cfg });
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

it("retains dirty work after a failed materialization and retries the same committed row", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:retry";
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      { sessionId: "retry", updatedAt: 1 },
    );
    const projection = await createSessionRowProjection({ cfg });
    try {
      vi.spyOn(rowInputs, "readSessionRowInputs").mockImplementationOnce(() => {
        throw new Error("cold input unavailable");
      });
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        { sessionId: "retry", updatedAt: 2, label: "committed" },
      );
      await expect(projection.ensureMaterialized()).rejects.toThrow("cold input unavailable");
      expect(projection.dirtyRowCount).toBeGreaterThan(0);
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key }).row?.label).toBe("committed");
    } finally {
      projection.dispose();
    }
  });
});

it("invalidates parent links when a child moves and when deletion crosses a materialization batch", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const parent = "agent:main:a-parent";
    const nextParent = "agent:main:b-parent";
    const child = "agent:main:z-child";
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    for (const key of [
      parent,
      nextParent,
      ...Array.from({ length: 100 }, (_, index) => `agent:main:middle-${index}`),
      child,
    ]) {
      replaceSessionEntrySync(
        { agentId: "main", storePath, sessionKey: key },
        {
          sessionId: key.split(":").at(-1)!,
          updatedAt: Date.now(),
          ...(key === child ? { parentSessionKey: parent } : {}),
        },
      );
    }
    const projection = await createSessionRowProjection({ cfg });
    try {
      replaceSessionEntrySync(
        { agentId: "main", storePath, sessionKey: child },
        { sessionId: "z-child", updatedAt: Date.now(), parentSessionKey: nextParent },
      );
      await projection.ensureMaterialized();
      expect(
        projection.snapshot({ agentId: "main", key: parent }).row?.childSessions,
      ).toBeUndefined();
      expect(projection.snapshot({ agentId: "main", key: nextParent }).row?.childSessions).toEqual([
        child,
      ]);
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath,
        archiveTranscript: false,
        target: { canonicalKey: child, storeKeys: [child] },
      });
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key: child }).row).toBeNull();
      expect(
        projection.snapshot({ agentId: "main", key: nextParent }).row?.childSessions,
      ).toBeUndefined();
    } finally {
      projection.dispose();
    }
  });
});

it("hydrates a same-path replacement and retires its previous inventory", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const staged = state.statePath("imports", "replacement.sqlite");
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      session: { store: storePath },
    };
    replaceSessionEntrySync(
      { agentId: "main", storePath, sessionKey: "agent:main:old" },
      { sessionId: "old", updatedAt: 1 },
    );
    replaceSessionEntrySync(
      { agentId: "main", storePath: staged, sessionKey: "agent:main:new" },
      { sessionId: "new", updatedAt: 2 },
    );
    closeOpenClawAgentDatabaseByPath(staged, "main");
    const projection = await createSessionRowProjection({ cfg });
    try {
      closeOpenClawAgentDatabaseByPath(storePath, "main");
      renameSync(staged, storePath);
      registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
      await projection.ensureMaterialized();
      expect(projection.select().map((row) => row.key)).toEqual(["agent:main:new"]);
      const sql = vi.spyOn(DatabaseSync.prototype, "prepare");
      expect(projection.snapshot({ agentId: "main", key: "agent:main:old" }).row).toBeNull();
      expect(projection.snapshot({ agentId: "main", key: "agent:main:new" }).row?.sessionId).toBe(
        "new",
      );
      expect(sql).not.toHaveBeenCalled();
    } finally {
      projection.dispose();
    }
  });
});

it("normalizes parent lineage after configuration publication", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:child";
    let cfg = {
      agents: { list: [{ id: "main", default: true }] },
      session: { scope: "per-sender" as "per-sender" | "global" },
    };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      { sessionId: "child", updatedAt: Date.now(), parentSessionKey: "agent:main:main" },
    );
    const projection = await createSessionRowProjection({ cfg, getConfig: () => cfg });
    try {
      cfg = { ...cfg, session: { scope: "global" } };
      sessionChanges.emit({ all: true, scope: "config" });
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key }).row?.parentSessionKey).toBe("global");
    } finally {
      projection.dispose();
    }
  });
});

it("refreshes prepared catalog metadata after catalog publication", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const key = "agent:main:catalog";
    let catalog = [
      {
        id: "fixture",
        name: "Fixture",
        provider: "unit-test",
        contextWindow: 8192,
        contextTokens: 8192,
      },
    ];
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        sessionId: "catalog",
        updatedAt: 1,
        providerOverride: "unit-test",
        modelOverride: "fixture",
      },
    );
    const projection = await createSessionRowProjection({
      cfg,
      modelCatalog: catalog,
      getModelCatalog: async () => catalog,
    });
    try {
      expect(projection.snapshot({ agentId: "main", key }).row?.contextTokens).toBe(8192);
      catalog = [{ ...catalog[0]!, contextWindow: 16384, contextTokens: 16384 }];
      notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key }).row?.contextTokens).toBe(16384);
    } finally {
      projection.dispose();
    }
  });
});

it("keeps cross-agent inheritance and parent selection when main aliases collapse to global", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" as const },
    };
    for (const agentId of ["main", "work"]) {
      replaceSessionEntrySync(
        { agentId, sessionKey: "global" },
        {
          sessionId: `${agentId}-parent`,
          updatedAt: 1,
          providerOverride: "unit-test",
          modelOverride: `${agentId}-model`,
        },
      );
    }
    const key = "agent:main:child";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      { sessionId: "child", updatedAt: 2, parentSessionKey: "agent:work:main" },
    );
    const projection = await createSessionRowProjection({ cfg });
    try {
      expect(projection.snapshot({ agentId: "main", key }).row).toMatchObject({
        parentSessionKey: "global",
        model: "work-model",
        modelOverrideSource: "inherited",
      });
      expect(
        projection
          .select({ agentId: "main", parentSessionKey: "agent:work:main" })
          .map((row) => row.key),
      ).toEqual([key]);
      replaceSessionEntrySync(
        { agentId: "work", sessionKey: "global" },
        {
          sessionId: "work-parent",
          updatedAt: 3,
          providerOverride: "unit-test",
          modelOverride: "updated-work-model",
        },
      );
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key }).row).toMatchObject({
        parentSessionKey: "global",
        model: "updated-work-model",
        modelOverrideSource: "inherited",
      });
    } finally {
      projection.dispose();
    }
  });
});

it("retains physical sentinels and stable store precedence after a primary update", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      session: { scope: "global" as const },
    };
    const primary = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const secondary = state.statePath("secondary.sqlite");
    for (const storePath of [primary, secondary]) {
      replaceSessionEntrySync(
        { agentId: "main", storePath, sessionKey: "global" },
        { sessionId: storePath === primary ? "primary" : "secondary", updatedAt: Date.now() },
      );
      registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
    }
    const projection = await createSessionRowProjection({ cfg });
    try {
      expect(projection.select().length).toBe(2);
      expect(
        projection.snapshot({ agentId: "main", key: "global", storePath: secondary }).row
          ?.sessionId,
      ).toBe("secondary");
      const selected = projection.describe({ agentId: "main", key: "global" })!;
      replaceSessionEntrySync(
        { ...selected.storeTarget, sessionKey: "global" },
        { ...selected.entry, label: "updated" },
      );
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key: "global" }).row?.sessionId).toBe(
        selected.entry.sessionId,
      );
      expect(projection.snapshot({ agentId: "main", key: "global" }).row?.label).toBe("updated");
      const childKey = "agent:main:qualified-child";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: childKey },
        {
          sessionId: "qualified-child",
          updatedAt: Date.now(),
          parentSessionKey: "agent:main:main",
        },
      );
      await projection.ensureMaterialized();
      expect(
        projection.snapshot({
          agentId: "main",
          key: "global",
          storePath: selected.storeTarget.storePath,
        }).row?.childSessions,
      ).toEqual([childKey]);
      const otherPath = selected.storeTarget.storePath === primary ? secondary : primary;
      expect(
        projection.snapshot({ agentId: "main", key: "global", storePath: otherPath }).row
          ?.childSessions,
      ).toBeUndefined();
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

it("keeps a committed insertion when topology publishes before the refresh", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:existing" },
      { sessionId: "existing", updatedAt: 1 },
    );
    const projection = await createSessionRowProjection({ cfg });
    try {
      const key = "agent:main:new";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        { sessionId: "new", updatedAt: 2 },
      );
      sessionChanges.emit({ all: true, scope: "config" });
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key }).row?.sessionId).toBe("new");
    } finally {
      projection.dispose();
    }
  });
});

it("refreshes thread model inheritance when its implicit parent changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const parentKey = "agent:main:discord:channel:root";
    const key = `${parentKey}:thread:child`;
    const parent = {
      sessionId: "parent",
      updatedAt: 1,
      providerOverride: "unit-test",
      modelOverride: "before",
    };
    replaceSessionEntrySync({ agentId: "main", sessionKey: parentKey }, parent);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      { sessionId: "thread", updatedAt: 2 },
    );
    const projection = await createSessionRowProjection({ cfg });
    try {
      expect(projection.snapshot({ agentId: "main", key }).row?.model).toBe("before");
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: parentKey },
        { ...parent, modelOverride: "after" },
      );
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key }).row?.model).toBe("after");
    } finally {
      projection.dispose();
    }
  });
});

it.each(["global", "unknown"])(
  "assigns a newly committed %s row to its logical store owner",
  async (key) => {
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
      try {
        replaceSessionEntrySync(
          { agentId: "main", storePath, sessionKey: key },
          { sessionId: "new-sentinel", updatedAt: 2 },
        );
        await projection.ensureMaterialized();
        expect(projection.snapshot({ agentId: "work", key }).row?.sessionId).toBe("new-sentinel");
        expect(
          projection
            .select()
            .filter((row) => row.key === key)
            .map((row) => row.agentId),
        ).toEqual(["work"]);
      } finally {
        projection.dispose();
      }
    });
  },
);

it("accepts a completed catalog when only session data changed during preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
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
