import "../test-utils/prepare-compiled-subprocesses.js";
import { existsSync } from "node:fs";
import { afterEach, expect, expectTypeOf, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { captureSessionEntryCurrentCheck } from "./session-binding-runtime.js";
import {
  patchSessionEntry,
  cleanupSessionLifecycleArtifacts,
  getSessionEntry,
  getSessionEntryAsync,
  getSessionEntryByIdAsync,
  listSessionEntriesAsync,
  readAmbientTranscriptWatermarkAsync,
  resolveAmbientTranscriptWatermarkKey,
  upsertSessionEntry,
} from "./session-store-runtime.js";

const tempDirs = createTempDirTracker();
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const databases: { agentId: string; path: string }[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) {
    memorySessionActorOwners.closeDatabase(database);
  }
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  tempDirs.cleanup();
});

async function createMemoryEntry(
  env: NodeJS.ProcessEnv,
  sessionKey: string,
  entry: InternalSessionEntry,
) {
  const scope = { agentId: "main", env, sessionKey };
  const binding = await acquireSessionActorStorage(scope, { authority, lifetime, create: true });
  if (!binding) {
    throw new Error("Expected memory acquisition");
  }
  databases.push({ agentId: binding.agentId, path: binding.path });
  try {
    await binding.actor.storage.mutate(
      { type: "session.entry.create", input: { entry } },
      authority,
    );
  } finally {
    await binding.actor.release();
  }
  return { ...scope, storePath: binding.path };
}

const completeEntry: InternalSessionEntry = {
  sessionId: "selected",
  updatedAt: 1,
  createdAt: 1,
  category: "Synthetic",
  execCwd: "/synthetic/workspace",
  skillsSnapshot: { prompt: "Complete saved prompt", skills: [] },
  pluginExtensions: { synthetic: { enabled: true } },
  pendingProjectGitUrl: "https://example.test/private-owner",
  cliHistoryBoundary: {
    version: 1,
    sessionId: "selected",
    state: "known",
    authFingerprint: "1".repeat(64),
    generation: "synthetic-generation",
    maxSeq: 7,
    writerRunId: "synthetic-writer",
  },
};

it("lists current public metadata off the host after an owner write without creating absent stores", async () => {
  expectTypeOf<
    PluginRuntime["agent"]["session"]["listSessionEntriesAsync"]
  >().parameters.toEqualTypeOf<Parameters<typeof listSessionEntriesAsync>>();
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("sdk-async-list-") };
  const scope = { agentId: "main", env };
  const sessionKey = "agent:main:listed";
  await expect(listSessionEntriesAsync(scope)).resolves.toEqual([]);
  expect(existsSync(resolveOpenClawAgentSqlitePath(scope))).toBe(false);

  replaceSessionEntrySync(
    { ...scope, sessionKey },
    {
      ...completeEntry,
      initializationPending: true,
    },
  );
  const read = async () => {
    const sql = observeHostDataSql();
    try {
      const entries = await listSessionEntriesAsync(scope);
      expect(sql.queries).toEqual([]);
      return entries;
    } finally {
      sql.restore();
    }
  };
  const before = await read();
  expect(before).toEqual([
    {
      sessionKey,
      entry: expect.objectContaining({
        sessionId: "selected",
        initializationPending: true,
        pluginExtensions: completeEntry.pluginExtensions,
      }),
    },
  ]);
  expect(before[0]?.entry).not.toHaveProperty("pendingProjectGitUrl");
  expect(before[0]?.entry).not.toHaveProperty("skillsSnapshot");

  await upsertSessionEntry({
    ...scope,
    sessionKey,
    entry: { sessionId: "replacement", updatedAt: 2, displayName: "Replacement" },
  });
  expect(await read()).toEqual([
    {
      sessionKey,
      entry: expect.objectContaining({ sessionId: "replacement", displayName: "Replacement" }),
    },
  ]);
  expect(before[0]?.entry.sessionId).toBe("selected");
});

it("reads committed watermark updates off the host and ignores a reset predecessor", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("sdk-async-watermark-") };
  const scope = { agentId: "main", env, sessionKey: "agent:main:telegram:group:room" };
  const key = resolveAmbientTranscriptWatermarkKey({
    channel: "telegram",
    accountId: "default",
    conversationId: "room",
  });
  let entry = {
    sessionId: "before-reset",
    updatedAt: 1,
    ambientTranscriptWatermarks: {
      [key]: { sessionId: "before-reset", messageId: "11", updatedAt: 1 },
    },
  };
  const read = async () => {
    const sql = observeHostDataSql();
    try {
      const watermark = await readAmbientTranscriptWatermarkAsync({ ...scope, key });
      expect(sql.queries).toEqual([]);
      return watermark;
    } finally {
      sql.restore();
    }
  };
  await upsertSessionEntry({ ...scope, entry });
  expect(await read()).toMatchObject({ messageId: "11" });

  entry = {
    ...entry,
    ambientTranscriptWatermarks: {
      [key]: { sessionId: "before-reset", messageId: "12", updatedAt: 2 },
    },
  };
  await upsertSessionEntry({ ...scope, entry });
  expect(await read()).toMatchObject({ messageId: "12" });

  await upsertSessionEntry({ ...scope, entry: { ...entry, sessionId: "after-reset" } });
  expect(await read()).toBeUndefined();
});

it.each(["durable", "memory"] as const)(
  "selects the most recently updated duplicate ID only when requested in %s sessions",
  async (mode) => {
    expectTypeOf<
      PluginRuntime["agent"]["session"]["getSessionEntryByIdAsync"]
    >().parameters.toEqualTypeOf<Parameters<typeof getSessionEntryByIdAsync>>();
    const env = { OPENCLAW_STATE_DIR: tempDirs.make(`sdk-id-order-${mode}-`) };
    const scope = {
      agentId: "main",
      env,
      ...(mode === "memory"
        ? { storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }) }
        : {}),
    };
    const prefix = mode === "memory" ? "agent:main:dashboard:incognito-" : "agent:main:";
    for (const [suffix, sessionId, updatedAt] of [
      ["a-old", "duplicate", 1],
      ["z-new", "duplicate", 20],
      ["m-tied", "duplicate", 20],
      ["n-trimmed", "\t legacy \n", 30],
      ["b-exact", "legacy", 1],
    ] as const) {
      const sessionKey = `${prefix}${suffix}`;
      const entry = {
        sessionId,
        updatedAt,
        ...(mode === "memory" ? { incognito: true as const } : {}),
      };
      if (mode === "memory") {
        await createMemoryEntry(env, sessionKey, entry);
      } else {
        replaceSessionEntrySync({ ...scope, sessionKey }, entry);
      }
    }
    await expect(
      getSessionEntryByIdAsync({ ...scope, sessionId: "duplicate" }),
    ).resolves.toMatchObject({ sessionKey: `${prefix}a-old` });
    await expect(
      getSessionEntryByIdAsync({ ...scope, sessionId: "duplicate", orderBy: "updatedAt" }),
    ).resolves.toMatchObject({ sessionKey: `${prefix}m-tied` });
    await expect(
      getSessionEntryByIdAsync({ ...scope, sessionId: "legacy" }),
    ).resolves.toMatchObject({ sessionKey: `${prefix}b-exact` });
    await expect(
      getSessionEntryByIdAsync({ ...scope, sessionId: "legacy", orderBy: "updatedAt" }),
    ).resolves.toMatchObject({ sessionKey: `${prefix}n-trimmed` });
  },
);

it("keeps the complete public projection for durable and memory entry reads", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("sdk-async-entry-") };
  const durable = { agentId: "main", env, sessionKey: "agent:main:durable" };
  await expect(
    getSessionEntryByIdAsync({ ...durable, sessionId: "missing" }),
  ).resolves.toBeUndefined();
  expect(existsSync(resolveOpenClawAgentSqlitePath(durable))).toBe(false);
  replaceSessionEntrySync(durable, completeEntry);
  const publicEntry = getSessionEntry(durable);
  expect(publicEntry).toMatchObject({
    skillsSnapshot: completeEntry.skillsSnapshot,
    pluginExtensions: completeEntry.pluginExtensions,
    execCwd: completeEntry.execCwd,
  });
  expect(publicEntry).not.toHaveProperty("pendingProjectGitUrl");
  expect(publicEntry).not.toHaveProperty("cliHistoryBoundary");
  expect(publicEntry).not.toBeInstanceOf(Promise);
  await expect(getSessionEntryAsync(durable)).resolves.toEqual(publicEntry);
  await expect(getSessionEntryByIdAsync({ ...durable, sessionId: "selected" })).resolves.toEqual({
    sessionKey: durable.sessionKey,
    entry: publicEntry,
  });
  const scope = await createMemoryEntry(env, "agent:main:dashboard:incognito-selected", {
    ...completeEntry,
    incognito: true,
  });
  const sql = observeHostDataSql();
  try {
    const entry = await getSessionEntryAsync(scope);
    expect(entry).toEqual({ ...publicEntry, incognito: true });
    expect(getSessionEntry(scope)).toEqual(entry);
    await expect(getSessionEntryByIdAsync({ ...scope, sessionId: "selected" })).resolves.toEqual({
      sessionKey: scope.sessionKey,
      entry,
    });
    await expect(
      getSessionEntryByIdAsync({ ...scope, sessionId: "missing" }),
    ).resolves.toBeUndefined();
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("cleans an unbound private recall helper selected through its configured durable path", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("sdk-cleanup-memory-") };
  const scope = { agentId: "main", env };
  const storePath = resolveOpenClawAgentSqlitePath(scope);
  const sessionKey = "agent:main:subagent:incognito-helper";
  const durableKey = "agent:main:durable-helper";
  const entry = { sessionId: "helper", updatedAt: 1, pluginOwnerId: "active-memory" };
  replaceSessionEntrySync({ ...scope, sessionKey: durableKey }, entry);
  await createMemoryEntry(env, sessionKey, { ...entry, incognito: true });
  const sql = observeHostDataSql();
  try {
    await expect(
      cleanupSessionLifecycleArtifacts({
        ...scope,
        storePath,
        sessionKeySegmentPrefix: "subagent:incognito-helper",
        transcriptContentMarker: '"runId":"helper"',
        archiveRemovedEntryTranscripts: false,
        orphanTranscriptMinAgeMs: 0,
        nowMs: Date.now(),
      }),
    ).resolves.toEqual({ removedEntries: 1, archivedTranscriptArtifacts: 0 });
    await expect(getSessionEntryAsync({ ...scope, sessionKey })).resolves.toBeUndefined();
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
  expect(getSessionEntry({ ...scope, sessionKey: durableKey })).toMatchObject(entry);
});

it("keeps absent and closed memory owners absent without allocating a database", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("sdk-memory-absent-") };
  const scope = { agentId: "main", env, sessionKey: "agent:main:dashboard:incognito-absent" };
  const database = { agentId: "main", path: resolveIncognitoOpenClawAgentSqlitePath(scope) };
  await expect(getSessionEntryAsync(scope)).resolves.toBeUndefined();
  const absent = await captureSessionEntryCurrentCheck(scope);
  expect(absent.entry).toBeUndefined();
  expect(absent.isCurrent()).toBe(true);
  await expect(
    getSessionEntryByIdAsync({ ...scope, storePath: database.path, sessionId: "missing" }),
  ).resolves.toBeUndefined();
  expect(memorySessionActorOwners.read(database)).toBeUndefined();
  await createMemoryEntry(env, scope.sessionKey, {
    sessionId: "closed",
    updatedAt: 1,
    incognito: true,
  });
  const binding = await acquireSessionActorStorage(scope, { authority, lifetime });
  if (!binding) {
    throw new Error("Expected existing memory session");
  }
  try {
    memorySessionActorOwners.closeDatabase(database);
    await expect(
      runWithSessionActorStorage(binding, () => getSessionEntryAsync(scope)),
    ).rejects.toThrow();
    await expect(getSessionEntryAsync(scope)).resolves.toBeUndefined();
    expect(memorySessionActorOwners.read(database)).toBeUndefined();
    expect(existsSync(database.path)).toBe(false);
  } finally {
    await binding.actor.release();
  }
});

it("keeps exact memory policy guards current without treating unrelated metadata as revocation", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("sdk-policy-current-") };
  const target = await createMemoryEntry(env, "agent:main:dashboard:incognito-policy", {
    ...completeEntry,
    incognito: true,
    execHost: "node",
    execNode: "original-node",
  });
  const sql = observeHostDataSql();
  try {
    const prepared = await captureSessionEntryCurrentCheck({
      ...target,
      fields: ["execHost", "execNode"],
    });
    expect(prepared.isCurrent()).toBe(true);
    expect(prepared.entry).toMatchObject({ execHost: "node", execNode: "original-node" });
    expect(prepared.entry).not.toHaveProperty("cliHistoryBoundary");
    expect(prepared.entry).not.toHaveProperty("pendingProjectGitUrl");
    prepared.entry!.execNode = "edited-return-value";
    expect(prepared.isCurrent()).toBe(true);
    await patchSessionEntry({ ...target, update: () => ({ displayName: "unrelated" }) });
    expect(prepared.isCurrent()).toBe(true);
    await patchSessionEntry({ ...target, update: () => ({ execNode: "replacement-node" }) });
    expect(prepared.isCurrent()).toBe(false);
    expect(prepared.assertCurrent).toThrow("selected session changed");
    await expect(
      captureSessionEntryCurrentCheck({
        ...target,
        fields: ["execNode"],
        expected: { sessionId: "selected", execNode: "original-node" },
      }),
    ).rejects.toThrow("selected session changed");
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});
