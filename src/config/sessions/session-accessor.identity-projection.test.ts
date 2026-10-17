import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
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
  prepareQualifiedSessionEntryTarget,
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

  function config(store = storePath): OpenClawConfig {
    return { session: { store, scope: "global" }, agents: { entries: { main: {} } } };
  }
  function researchScope() {
    return {
      cfg: {
        session: { store: path.join(tempDir, "{agentId}.json"), scope: "global" as const },
        agents: { entries: { research: {} } },
      },
      agentId: "research",
      sessionKey: "global",
    };
  }
  const project = (scope: Parameters<typeof resolveSessionEntryAccessTarget>[0]) =>
    resolveSessionEntryAccessTarget(scope, { keyFormat: "agent-qualified" });
  const setLabel = (label: string) => (entry: SessionEntry) => {
    entry.label = label;
  };

  async function captureSession(entry: SessionEntry) {
    const sessionKey = "global";
    const physical = { agentId: "main", storePath, sessionKey };
    await replaceSessionEntry(physical, entry);
    const scope = { cfg: config(), sessionKey, agentId: "main" };
    const target = await project(scope);
    return { physical, scope, target };
  }

  it.each([
    { input: "global", stored: "global", logical: "agent:research:global", global: true },
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
        agents: { entries: { research: {}, ops: {} } },
      };
      const physical = {
        agentId: "research",
        sessionKey: stored,
        storePath: path.join(tempDir, "research.json"),
      };
      await replaceSessionEntry(physical, { sessionId: "selected", updatedAt: 1, label: "before" });
      const scope = { cfg, agentId: "research", sessionKey: input };
      const legacy = resolveSessionEntryAccessTarget(scope);
      const projected = await project(scope);
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
          expect(context).toMatchObject({ canonicalKey: logical, storeKey: stored });
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

  it("refuses a qualified projection collision without changing legacy reads", async () => {
    const scope = researchScope();
    const physical = { agentId: "research", storePath: path.join(tempDir, "research.json") };
    for (const { key, sessionId } of [
      { key: "global", sessionId: "raw" },
      { key: "agent:research:global", sessionId: "qualified" },
    ]) {
      await replaceSessionEntry({ ...physical, sessionKey: key }, { sessionId, updatedAt: 1 });
    }
    expect(resolveSessionEntryAccessTarget(scope).entry?.sessionId).toBe("raw");
    await expect(project(scope)).rejects.toThrow("ambiguous stored identity");
    expect(
      listSessionEntriesCore(physical)
        .map((row) => row.entry.sessionId)
        .toSorted(),
    ).toEqual(["qualified", "raw"]);
  });

  it("does not select a qualified conversation when its old alias row is absent", async () => {
    const scope = researchScope();
    const physical = {
      agentId: "research",
      storePath: path.join(tempDir, "research.json"),
      sessionKey: "agent:research:global",
    };
    await replaceSessionEntry(physical, { sessionId: "literal", updatedAt: 1 });
    const target = await project(scope);
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
        entries: { research: {}, ops: {} },
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
    const target = await project(scope);
    expect(target).toMatchObject({
      agentId: "research",
      readSource: { agentId: "ops" },
      storeKeys: [physical.sessionKey],
    });
    await updateResolvedSessionEntry(scope, setLabel("research only"), { target });
    expect(loadSessionEntryReadOnly(physical)?.label).toBe("research only");
    expect(
      loadSessionEntryReadOnly({ agentId: "ops", storePath: shared, sessionKey: "global" })?.label,
    ).toBeUndefined();
  });

  it.each([
    { kind: "session", error: "Captured session generation changed" },
    { kind: "file", error: "file identity changed" },
  ] as const)("rejects a replaced $kind capture", async (variant) => {
    const capturedEntry: SessionEntry =
      variant.kind === "session"
        ? { sessionId: "original", updatedAt: 1 }
        : { sessionId: "same-session", lifecycleRevision: "same", updatedAt: 1 };
    const { physical, scope, target } = await captureSession(capturedEntry);
    if (variant.kind === "session") {
      await replaceSessionEntry(physical, { sessionId: "replacement", updatedAt: 2 });
    } else if (variant.kind === "file") {
      await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
      const previousPath = `${target.storePath}.original`;
      fs.renameSync(target.storePath, previousPath);
      fs.copyFileSync(previousPath, target.storePath);
    }
    const update = vi.fn(setLabel("must not write"));
    await expect(updateResolvedSessionEntry(scope, update, { target })).rejects.toThrow(
      variant.error,
    );
    expect(update).not.toHaveBeenCalled();
    expect(loadSessionEntryReadOnly(physical)?.label).toBeUndefined();
    if (variant.kind === "file") {
      expect(loadSessionEntryReadOnly(physical)).toMatchObject({
        sessionId: "same-session",
        lifecycleRevision: "same",
      });
      const fresh = await project(scope);
      expect(fresh.readSource?.databaseIdentity).not.toBe(target.readSource?.databaseIdentity);
    }
  });

  it("rejects a successor lifecycle with the same SID after waiting for FIFO admission", async () => {
    const { physical, scope, target } = await captureSession({
      sessionId: "same-session",
      lifecycleRevision: "before",
      updatedAt: 1,
    });
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
    const scope = { cfg: config(), agentId: "main", sessionKey: "global" };
    const target = await project(scope);
    expect(target.readSource).toBeDefined();
    await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
    await updateResolvedSessionEntry(scope, setLabel("same physical record"), { target });
    const reopened = await project(scope);
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

  it("rechecks counterpart absence after an awaited captured update", async () => {
    const { physical, scope, target } = await captureSession({
      sessionId: "original",
      updatedAt: 1,
    });
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

  it("checks sibling ambiguity off-thread once and keeps later writes on the selected source", async () => {
    const sessionKey = "agent:main:source-pinned";
    const cfg: OpenClawConfig = { session: { store: storePath } };
    const scope = { cfg, agentId: "main", sessionKey };
    const siblingStorePath = state.path("sibling.sqlite");
    await replaceSessionEntry(
      { agentId: "main", storePath, sessionKey },
      { sessionId: "selected", updatedAt: 1 },
    );
    await replaceSessionEntry(
      { agentId: "main", storePath: siblingStorePath, sessionKey: "agent:main:other" },
      { sessionId: "other", updatedAt: 1 },
    );
    const selected = await project(scope);
    const sibling = await project({
      cfg: { session: { store: siblingStorePath } },
      agentId: "main",
      sessionKey: "agent:main:other",
    });
    if (!sibling.readSource) {
      throw new Error("Expected captured sibling source");
    }
    const host = observeHostDataSql();
    const target = await prepareQualifiedSessionEntryTarget(selected, [sibling.readSource]).finally(
      () => host.restore(),
    );
    expect(host.queries).toEqual([]);
    await replaceSessionEntry(
      { agentId: "main", storePath: siblingStorePath, sessionKey },
      { sessionId: "later-duplicate", updatedAt: 2 },
    );
    await updateResolvedSessionEntry(scope, setLabel("selected only"), { target });
    expect(loadSessionEntryReadOnly({ agentId: "main", storePath, sessionKey })?.label).toBe(
      "selected only",
    );
    const duplicate = loadSessionEntryReadOnly({
      agentId: "main",
      storePath: siblingStorePath,
      sessionKey,
    });
    expect(duplicate?.sessionId).toBe("later-duplicate");
    expect(duplicate?.label).toBeUndefined();
    await expect(
      prepareQualifiedSessionEntryTarget(selected, [sibling.readSource]),
    ).rejects.toThrow("ambiguous stored identity");
  });
});
