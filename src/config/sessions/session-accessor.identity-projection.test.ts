import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  listSessionEntriesCore,
  loadSessionEntryReadOnly,
  loadSessionEntryByIdReadOnly,
  patchSessionEntryCore,
  replaceSessionEntry,
  replaceSessionEntrySync,
  resolveSessionEntryAccessTarget,
  updateResolvedSessionEntry,
} from "./session-accessor.entry.js";
import type { SessionEntry } from "./types.js";

describe("qualified session accessor projection", () => {
  let state: OpenClawTestState;
  let tempDir: string;
  let storePath: string;
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "session-identity-projection-" });
    tempDir = state.root;
    storePath = state.path("sessions.json");
  });
  afterEach(async () => {
    await state.cleanup();
  });

  it.each([
    { input: "global", stored: "global", logical: "agent:research:global", global: true },
    {
      input: "agent:research:main",
      stored: "global",
      logical: "agent:research:global",
      global: true,
    },
    {
      input: "main",
      stored: "agent:research:primary",
      logical: "agent:research:primary",
      global: false,
    },
    {
      input: "agent:research:signal:group:AbC",
      stored: "agent:research:signal:group:AbC",
      logical: "agent:research:signal:group:AbC",
      global: false,
    },
  ])(
    "projects $input without changing its admitted selector or stored key",
    async ({ input, stored, logical, global }) => {
      const cfg: OpenClawConfig = {
        session: {
          store: path.join(tempDir, "{agentId}.json"),
          scope: global ? "global" : undefined,
          mainKey: global ? undefined : "primary",
        },
        agents: { entries: { research: { default: true }, ops: {} } },
      };
      const physical = {
        agentId: "research",
        sessionKey: stored,
        storePath: path.join(tempDir, "research.json"),
      };
      await replaceSessionEntry(physical, { sessionId: "selected", updatedAt: 1, label: "before" });
      const scope = { cfg, agentId: "research", sessionKey: input };
      const legacy = resolveSessionEntryAccessTarget(scope);
      const projected = resolveSessionEntryAccessTarget(scope, { keyFormat: "agent-qualified" });
      expect(projected).toMatchObject({
        agentId: "research",
        canonicalKey: logical,
        storeKey: stored,
        requestedKey: input,
        readSource: { agentId: "research" },
        entry: { sessionId: "selected" },
      });
      expect(projected.storePath).toBe(projected.readSource?.path);
      expect(legacy.storeKey).toBe(stored);
      const result = await updateResolvedSessionEntry(
        scope,
        (entry, context) => {
          expect(context.canonicalKey).toBe(logical);
          expect(context.storeKey).toBe(stored);
          entry.label = "after";
          return entry.sessionId;
        },
        { target: projected },
      );
      expect(result).toMatchObject({
        found: true,
        canonicalKey: logical,
        storeKey: stored,
        result: "selected",
      });
      expect(loadSessionEntryReadOnly(physical)?.label).toBe("after");
      expect(
        listSessionEntriesCore({ agentId: "research", storePath: physical.storePath }).map(
          (row) => row.sessionKey,
        ),
      ).toEqual([stored]);
    },
  );

  it.each(["global", "agent:research:global"])(
    "refuses a qualified projection collision for %s without changing legacy reads",
    async (sessionKey) => {
      const cfg: OpenClawConfig = {
        session: { store: path.join(tempDir, "{agentId}.json"), scope: "global" },
        agents: { entries: { research: { default: true } } },
      };
      const physical = { agentId: "research", storePath: path.join(tempDir, "research.json") };
      for (const { key, sessionId } of [
        { key: "global", sessionId: "raw" },
        { key: "agent:research:global", sessionId: "qualified" },
      ]) {
        await replaceSessionEntry({ ...physical, sessionKey: key }, { sessionId, updatedAt: 1 });
      }
      const scope = { cfg, sessionKey, agentId: "research" };
      expect(resolveSessionEntryAccessTarget(scope).entry?.sessionId).toBe(
        sessionKey === "global" ? "raw" : "qualified",
      );
      expect(() =>
        resolveSessionEntryAccessTarget(scope, { keyFormat: "agent-qualified" }),
      ).toThrow("ambiguous stored identity");
      expect(
        listSessionEntriesCore(physical)
          .map((row) => row.entry.sessionId)
          .toSorted(),
      ).toEqual(["qualified", "raw"]);
    },
  );

  it("does not select a qualified conversation when its old alias row is absent", async () => {
    const cfg: OpenClawConfig = {
      session: { store: path.join(tempDir, "{agentId}.json"), scope: "global" },
      agents: { entries: { research: { default: true } } },
    };
    const physical = {
      agentId: "research",
      storePath: path.join(tempDir, "research.json"),
      sessionKey: "agent:research:global",
    };
    await replaceSessionEntry(physical, { sessionId: "literal", updatedAt: 1 });
    const scope = { cfg, agentId: "research", sessionKey: "global" };
    const target = resolveSessionEntryAccessTarget(scope, { keyFormat: "agent-qualified" });
    expect(target.entry).toBeUndefined();
    const update = vi.fn();
    await expect(updateResolvedSessionEntry(scope, update, { target })).resolves.toMatchObject({
      found: false,
    });
    expect(update).not.toHaveBeenCalled();
    expect(loadSessionEntryReadOnly(physical)?.sessionId).toBe("literal");
  });

  it("keeps logical ownership separate from the fixed physical database owner", async () => {
    const shared = path.join(tempDir, "shared.sqlite");
    const cfg: OpenClawConfig = {
      session: { store: shared, scope: "global" },
      agents: {
        entries: { research: {}, ops: { default: true } },
        defaults: { sessionStore: { agentId: "ops" } },
      },
    };
    await replaceSessionEntry(
      { agentId: "ops", defaultAgentId: "ops", storePath: shared, sessionKey: "global" },
      { sessionId: "ops-global", updatedAt: 1 },
    );
    const physical = {
      agentId: "research",
      storePath: shared,
      sessionKey: "agent:research:global",
    };
    await replaceSessionEntry(physical, { sessionId: "research-global", updatedAt: 1 });
    const scope = { cfg, sessionKey: physical.sessionKey, agentId: "research" };
    const target = resolveSessionEntryAccessTarget(scope, { keyFormat: "agent-qualified" });
    expect(target.agentId).toBe("research");
    expect(target.readSource?.agentId).toBe("ops");
    expect(target.storeKeys).toEqual([physical.sessionKey]);
    await updateResolvedSessionEntry(
      scope,
      (entry) => {
        entry.label = "research only";
      },
      { target },
    );
    expect(loadSessionEntryReadOnly(physical)?.label).toBe("research only");
    expect(
      loadSessionEntryReadOnly({ agentId: "ops", storePath: shared, sessionKey: "global" })?.label,
    ).toBeUndefined();
  });

  it("rejects replacement of a captured session before its update starts", async () => {
    const cfg: OpenClawConfig = {
      session: { store: storePath, scope: "global" },
      agents: { entries: { main: { default: true } } },
    };
    const physical = { agentId: "main", storePath, sessionKey: "global" };
    await replaceSessionEntry(physical, { sessionId: "original", updatedAt: 1 });
    const scope = { cfg, sessionKey: "global", agentId: "main" };
    const target = resolveSessionEntryAccessTarget(scope, { keyFormat: "agent-qualified" });
    await replaceSessionEntry(physical, { sessionId: "replacement", updatedAt: 2 });
    const update = vi.fn((entry: SessionEntry) => {
      entry.label = "must not write";
    });
    await expect(updateResolvedSessionEntry(scope, update, { target })).rejects.toThrow(
      "Captured session generation changed",
    );
    expect(update).not.toHaveBeenCalled();
    expect(loadSessionEntryReadOnly(physical)?.label).toBeUndefined();
  });

  it("rejects a successor lifecycle with the same SID after waiting for FIFO admission", async () => {
    const cfg: OpenClawConfig = {
      session: { store: storePath, scope: "global" },
      agents: { entries: { main: { default: true } } },
    };
    const physical = { agentId: "main", storePath, sessionKey: "global" };
    await replaceSessionEntry(physical, {
      sessionId: "same-session",
      lifecycleRevision: "before",
      updatedAt: 1,
    });
    const scope = { cfg, agentId: "main", sessionKey: "global" };
    const target = resolveSessionEntryAccessTarget(scope, { keyFormat: "agent-qualified" });
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const successor = {
      lifecycleRevision: "after",
      pluginNextTurnInjections: {
        fixture: [
          {
            id: "successor",
            pluginId: "fixture",
            text: "new turn",
            createdAt: 1,
            placement: "prepend_context",
          },
        ],
      },
    } satisfies Partial<SessionEntry>;
    const first = patchSessionEntryCore(physical, async () => {
      entered.resolve();
      await resume.promise;
      return successor;
    });
    const update = vi.fn((entry: SessionEntry) => {
      delete entry.pluginNextTurnInjections;
    });
    let rejected: Promise<unknown> | undefined;
    try {
      await Promise.race([entered.promise, first]);
      const pending = updateResolvedSessionEntry(scope, update, { target });
      rejected = expect(pending).rejects.toThrow("Captured session generation changed");
      resume.resolve();
      await Promise.all([first, rejected]);
    } finally {
      resume.resolve();
      await Promise.allSettled(rejected ? [first, rejected] : [first]);
    }
    expect(update).not.toHaveBeenCalled();
    expect(loadSessionEntryReadOnly(physical)).toMatchObject({
      sessionId: "same-session",
      lifecycleRevision: "after",
      pluginNextTurnInjections: { fixture: [{ id: "successor" }] },
    });
  });

  it("accepts reopening the same physical file while preserving raw list, ID and lineage addresses", async () => {
    const cfg: OpenClawConfig = {
      session: { store: storePath, scope: "global" },
      agents: { entries: { main: { default: true } } },
    };
    const physical = { agentId: "main", storePath, sessionKey: "global" };
    await replaceSessionEntry(physical, {
      sessionId: "parent",
      lifecycleRevision: "same",
      updatedAt: 1,
    });
    await replaceSessionEntry(
      { ...physical, sessionKey: "agent:main:child" },
      {
        sessionId: "child",
        updatedAt: 1,
        parentSessionKey: "global",
        spawnedBy: "global",
      },
    );
    const scope = { cfg, agentId: "main", sessionKey: "global" };
    const target = resolveSessionEntryAccessTarget(scope, { keyFormat: "agent-qualified" });
    expect(target.readSource).toBeDefined();
    closeOpenClawAgentDatabaseByPath(target.storePath);
    await updateResolvedSessionEntry(
      scope,
      (entry) => {
        entry.label = "same physical record";
      },
      { target },
    );
    const reopened = resolveSessionEntryAccessTarget(scope, { keyFormat: "agent-qualified" });
    expect(reopened.canonicalKey).toBe("agent:main:global");
    expect(reopened.readSource).toEqual(target.readSource);
    expect(loadSessionEntryByIdReadOnly({ ...physical, sessionId: "parent" })?.sessionKey).toBe(
      "global",
    );
    const entries = listSessionEntriesCore({ agentId: "main", storePath });
    expect(entries.map((row) => row.sessionKey).toSorted()).toEqual(["agent:main:child", "global"]);
    expect(entries.find((row) => row.sessionKey === "agent:main:child")?.entry).toMatchObject({
      parentSessionKey: "global",
      spawnedBy: "global",
    });
    expect(loadSessionEntryReadOnly(physical)?.label).toBe("same physical record");
  });

  it("rejects an identical database copied over the captured physical pathname", async () => {
    const cfg: OpenClawConfig = {
      session: { store: storePath, scope: "global" },
      agents: { entries: { main: { default: true } } },
    };
    const physical = { agentId: "main", storePath, sessionKey: "global" };
    await replaceSessionEntry(physical, {
      sessionId: "same-session",
      lifecycleRevision: "same",
      updatedAt: 1,
    });
    const scope = { cfg, agentId: "main", sessionKey: "global" };
    const target = resolveSessionEntryAccessTarget(scope, { keyFormat: "agent-qualified" });
    closeOpenClawAgentDatabaseByPath(target.storePath);
    const previousPath = `${target.storePath}.original`;
    fs.renameSync(target.storePath, previousPath);
    fs.copyFileSync(previousPath, target.storePath);
    const update = vi.fn((entry: SessionEntry) => {
      entry.label = "must not write";
    });
    await expect(updateResolvedSessionEntry(scope, update, { target })).rejects.toThrow(
      "file identity changed",
    );
    expect(update).not.toHaveBeenCalled();
    expect(loadSessionEntryReadOnly(physical)).toMatchObject({
      sessionId: "same-session",
      lifecycleRevision: "same",
    });
    expect(loadSessionEntryReadOnly(physical)?.label).toBeUndefined();
    const fresh = resolveSessionEntryAccessTarget(scope, { keyFormat: "agent-qualified" });
    expect(fresh.readSource?.databaseIdentity).not.toBe(target.readSource?.databaseIdentity);
  });

  it.each([false, true])(
    "rejects retired incognito capture without creating a replacement when recreated=%s",
    async (recreated) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: { default: true } } } };
      const physical = {
        agentId: "main",
        storePath,
        sessionKey: "agent:main:dashboard:incognito-capture",
      };
      await replaceSessionEntry(physical, {
        sessionId: "same-session",
        lifecycleRevision: "same",
        updatedAt: 1,
      });
      const scope = { cfg, agentId: "main", sessionKey: physical.sessionKey };
      const target = resolveSessionEntryAccessTarget(scope, { keyFormat: "agent-qualified" });
      expect(typeof target.readSource?.databaseIdentity).toBe("symbol");
      closeOpenClawAgentDatabaseByPath(target.storePath);
      if (recreated) {
        await replaceSessionEntry(physical, {
          sessionId: "same-session",
          lifecycleRevision: "same",
          updatedAt: 1,
        });
      }
      const update = vi.fn((entry: SessionEntry) => {
        entry.label = "must not write";
      });
      await expect(updateResolvedSessionEntry(scope, update, { target })).rejects.toThrow(
        /Captured session database/,
      );
      expect(update).not.toHaveBeenCalled();
      expect(loadSessionEntryReadOnly(physical)?.label).toBeUndefined();
      expect(loadSessionEntryReadOnly(physical)?.sessionId).toBe(
        recreated ? "same-session" : undefined,
      );
      expect(fs.existsSync(target.storePath)).toBe(false);
    },
  );

  it("rechecks counterpart absence after an awaited captured update", async () => {
    const cfg: OpenClawConfig = {
      session: { store: storePath, scope: "global" },
      agents: { entries: { main: { default: true } } },
    };
    const physical = { agentId: "main", storePath, sessionKey: "global" };
    await replaceSessionEntry(physical, { sessionId: "original", updatedAt: 1 });
    const scope = { cfg, sessionKey: "global", agentId: "main" };
    const target = resolveSessionEntryAccessTarget(scope, { keyFormat: "agent-qualified" });
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const pending = updateResolvedSessionEntry(
      scope,
      async (entry) => {
        entered.resolve();
        await resume.promise;
        entry.label = "must not write";
      },
      { target },
    );
    const rejected = expect(pending).rejects.toThrow(/duplicate|changed/);
    try {
      await Promise.race([entered.promise, pending]);
      replaceSessionEntrySync(
        { ...physical, sessionKey: "agent:main:global" },
        { sessionId: "new-literal", updatedAt: 2 },
      );
    } finally {
      resume.resolve();
      await rejected;
    }
    expect(loadSessionEntryReadOnly(physical)?.label).toBeUndefined();
    expect(
      loadSessionEntryReadOnly({ ...physical, sessionKey: "agent:main:global" })?.sessionId,
    ).toBe("new-literal");
  });
});
