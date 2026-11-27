import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync as closeDatabase } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  listSessionEntriesCore as listEntries,
  loadSessionEntryReadOnly as readEntry,
  loadSessionEntryByIdReadOnly as readById,
  patchSessionEntryCore as patchEntry,
  prepareQualifiedSessionEntryTarget as prepareTarget,
  replaceSessionEntry as replaceEntry,
  replaceSessionEntrySync as replaceEntrySync,
  resolveSessionEntryAccessTarget as resolveTarget,
  updateResolvedSessionEntry as updateEntry,
} from "./session-accessor.entry.js";
import type { SessionEntry } from "./types.js";

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
const project = (scope: Parameters<typeof resolveTarget>[0]) =>
  resolveTarget(scope, { keyFormat: "agent-qualified" });
const setLabel = (label: string) => (entry: SessionEntry) => {
  entry.label = label;
};
const address = (sessionKey = "global", agentId = "main", dbPath = storePath) => ({
  sessionKey,
  agentId,
  storePath: dbPath,
});
const makeEntry = (sessionId: string, fields: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId,
  updatedAt: 1,
  ...fields,
});

async function captureSession(entry: SessionEntry) {
  const sessionKey = "global";
  const physical = address(sessionKey);
  await replaceEntry(physical, entry);
  const scope = { cfg: config(), sessionKey, agentId: "main" };
  const target = await project(scope);
  return { physical, scope, target };
}

it.each([
  ["global", "global", "agent:research:global"],
  ["main", "agent:research:primary", "agent:research:primary"],
  [
    "agent:research:signal:group:AbC",
    "agent:research:signal:group:AbC",
    "agent:research:signal:group:AbC",
  ],
])(
  "projects %s without changing its admitted selector or stored key",
  async (input, stored, logical) => {
    const global = input === "global";
    const cfg: OpenClawConfig = {
      session: {
        store: path.join(tempDir, "{agentId}.json"),
        scope: global ? "global" : undefined,
        mainKey: global ? undefined : "primary",
      },
      agents: { entries: { research: {}, ops: {} } },
    };
    const physical = address(stored, "research", path.join(tempDir, "research.json"));
    await replaceEntry(physical, makeEntry("selected", { label: "before" }));
    const scope = { cfg, agentId: "research", sessionKey: input };
    const legacy = resolveTarget(scope);
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
    const result = await updateEntry(
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
      result: "selected",
    });
    expect(readEntry(physical)?.label).toBe("after");
    expect(
      listEntries({ agentId: "research", storePath: physical.storePath }).map(
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
    await replaceEntry({ ...physical, sessionKey: key }, makeEntry(sessionId));
  }
  expect(resolveTarget(scope).entry?.sessionId).toBe("raw");
  await expect(project(scope)).rejects.toThrow("ambiguous stored identity");
  expect(
    listEntries(physical)
      .map((row) => row.entry.sessionId)
      .toSorted(),
  ).toEqual(["qualified", "raw"]);
});

it("does not select a qualified conversation when its old alias row is absent", async () => {
  const scope = researchScope();
  const physical = address(
    "agent:research:global",
    "research",
    path.join(tempDir, "research.json"),
  );
  await replaceEntry(physical, makeEntry("literal"));
  const target = await project(scope);
  expect(target.entry).toBeUndefined();
  const update = vi.fn();
  await expect(updateEntry(scope, update, { target })).resolves.toMatchObject({
    found: false,
  });
  expect(update).not.toHaveBeenCalled();
  expect(readEntry(physical)?.sessionId).toBe("literal");
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
  await replaceEntry(
    { agentId: "ops", defaultAgentId: "ops", storePath: shared, sessionKey: "global" },
    makeEntry("ops-global"),
  );
  const physical = address("agent:research:global", "research", shared);
  await replaceEntry(physical, makeEntry("research-global"));
  const scope = { cfg, sessionKey: physical.sessionKey, agentId: "research" };
  const target = await project(scope);
  expect(target).toMatchObject({
    agentId: "research",
    readSource: { agentId: "ops" },
    storeKeys: [physical.sessionKey],
  });
  await updateEntry(scope, setLabel("research only"), { target });
  expect(readEntry(physical)?.label).toBe("research only");
  expect(
    readEntry({ agentId: "ops", storePath: shared, sessionKey: "global" })?.label,
  ).toBeUndefined();
});

it.each([
  { kind: "session", error: "Captured session generation changed" },
  { kind: "file", error: "file identity changed" },
] as const)("rejects a replaced $kind capture", async (variant) => {
  const capturedEntry: SessionEntry =
    variant.kind === "session"
      ? makeEntry("original")
      : makeEntry("same-session", { lifecycleRevision: "same" });
  const { physical, scope, target } = await captureSession(capturedEntry);
  if (variant.kind === "session") {
    await replaceEntry(physical, makeEntry("replacement", { updatedAt: 2 }));
  } else if (variant.kind === "file") {
    await closeDatabase(target.storePath);
    const previousPath = `${target.storePath}.original`;
    fs.renameSync(target.storePath, previousPath);
    fs.copyFileSync(previousPath, target.storePath);
  }
  const update = vi.fn(setLabel("must not write"));
  await expect(updateEntry(scope, update, { target })).rejects.toThrow(variant.error);
  expect(update).not.toHaveBeenCalled();
  expect(readEntry(physical)?.label).toBeUndefined();
  if (variant.kind === "file") {
    expect(readEntry(physical)).toMatchObject({
      sessionId: "same-session",
      lifecycleRevision: "same",
    });
    const fresh = await project(scope);
    expect(fresh.readSource?.databaseIdentity).not.toBe(target.readSource?.databaseIdentity);
  }
});

it("rejects a successor lifecycle with the same SID after waiting for FIFO admission", async () => {
  const { physical, scope, target } = await captureSession(
    makeEntry("same-session", { lifecycleRevision: "before" }),
  );
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
  const first = patchEntry(physical, async () => {
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
    const pending = updateEntry(scope, update, { target });
    rejected = expect(pending).rejects.toThrow("Captured session generation changed");
    resume.resolve();
    await Promise.all([first, rejected]);
  } finally {
    resume.resolve();
    await Promise.allSettled(rejected ? [first, rejected] : [first]);
  }
  expect(update).not.toHaveBeenCalled();
  expect(readEntry(physical)).toMatchObject({
    sessionId: "same-session",
    lifecycleRevision: "after",
    pluginNextTurnInjections: { fixture: [{ id: "successor" }] },
  });
});

it("accepts reopening the same physical file while preserving raw list, ID and lineage addresses", async () => {
  const physical = address();
  await replaceEntry(physical, makeEntry("parent", { lifecycleRevision: "same" }));
  await replaceEntry(
    { ...physical, sessionKey: "agent:main:child" },
    makeEntry("child", { parentSessionKey: "global", spawnedBy: "global" }),
  );
  const scope = { cfg: config(), agentId: "main", sessionKey: "global" };
  const target = await project(scope);
  expect(target.readSource).toBeDefined();
  await closeDatabase(target.storePath);
  await updateEntry(scope, setLabel("same physical record"), { target });
  const reopened = await project(scope);
  expect(reopened.canonicalKey).toBe("agent:main:global");
  expect(reopened.readSource).toEqual(target.readSource);
  expect(readById({ ...physical, sessionId: "parent" })?.sessionKey).toBe("global");
  const entries = listEntries({ agentId: "main", storePath });
  expect(entries.map((row) => row.sessionKey).toSorted()).toEqual(["agent:main:child", "global"]);
  expect(entries.find((row) => row.sessionKey === "agent:main:child")?.entry).toMatchObject({
    parentSessionKey: "global",
    spawnedBy: "global",
  });
  expect(readEntry(physical)?.label).toBe("same physical record");
});

it("rechecks counterpart absence after an awaited captured update", async () => {
  const { physical, scope, target } = await captureSession(makeEntry("original"));
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const pending = updateEntry(
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
    replaceEntrySync(
      { ...physical, sessionKey: "agent:main:global" },
      makeEntry("new-literal", { updatedAt: 2 }),
    );
  } finally {
    resume.resolve();
    await rejected;
  }
  expect(readEntry(physical)?.label).toBeUndefined();
  expect(readEntry({ ...physical, sessionKey: "agent:main:global" })?.sessionId).toBe(
    "new-literal",
  );
});

it("checks sibling ambiguity off-thread once and keeps later writes on the selected source", async () => {
  const sessionKey = "agent:main:source-pinned";
  const cfg: OpenClawConfig = { session: { store: storePath } };
  const scope = { cfg, agentId: "main", sessionKey };
  const siblingStorePath = state.path("sibling.sqlite");
  await replaceEntry(address(sessionKey), makeEntry("selected"));
  await replaceEntry(address("agent:main:other", "main", siblingStorePath), makeEntry("other"));
  const selected = await project(scope);
  const sibling = await project({
    cfg: { session: { store: siblingStorePath } },
    agentId: "main",
    sessionKey: "agent:main:other",
  });
  assert(sibling.readSource, "Expected captured sibling source");
  const host = observeHostDataSql();
  const target = await prepareTarget(selected, [sibling.readSource]).finally(() => host.restore());
  expect(host.queries).toEqual([]);
  await replaceEntry(
    address(sessionKey, "main", siblingStorePath),
    makeEntry("later-duplicate", { updatedAt: 2 }),
  );
  await updateEntry(scope, setLabel("selected only"), { target });
  expect(readEntry(address(sessionKey))?.label).toBe("selected only");
  const duplicate = readEntry(address(sessionKey, "main", siblingStorePath));
  expect(duplicate?.sessionId).toBe("later-duplicate");
  expect(duplicate?.label).toBeUndefined();
  await expect(prepareTarget(selected, [sibling.readSource])).rejects.toThrow(
    "ambiguous stored identity",
  );
});
