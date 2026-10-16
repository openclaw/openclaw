import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
import type { InternalSessionEntry as Entry } from "../config/sessions/types.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { captureSessionEntryCurrentCheckAsync as captureCurrent } from "./session-binding-runtime.js";
import {
  patchSessionEntry,
  cleanupSessionLifecycleArtifacts as cleanup,
  getSessionEntry as getEntry,
  getSessionEntryAsync as readEntry,
  getSessionEntryByIdAsync as readById,
  listSessionEntriesAsync as listEntries,
  readAmbientTranscriptWatermarkAsync as readWatermark,
  resolveAmbientTranscriptWatermarkKey as watermarkKey,
  resolveTranscriptSessionKeyBySessionId as resolveKey,
  resolveTranscriptSessionKeyBySessionIdAsync as resolveKeyAsync,
  upsertSessionEntry,
} from "./session-store-runtime.js";

const tempDirs = createTempDirTracker();
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const databases: { agentId: string; path: string }[] = [];
const makeScope = (prefix: string) => ({
  agentId: "main",
  env: { OPENCLAW_STATE_DIR: tempDirs.make(prefix) },
});
async function withoutHostSql<T>(run: () => Promise<T>): Promise<T> {
  const sql = observeHostDataSql();
  using _ = { [Symbol.dispose]: sql.restore };
  const result = await run();
  expect(sql.queries).toEqual([]);
  return result;
}
beforeEach(() => {
  setRuntimeConfigSnapshot({});
});
afterEach(async () => {
  for (const database of databases.splice(0)) {
    memorySessionActorOwners.closeDatabase(database);
  }
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  tempDirs.cleanup();
  clearRuntimeConfigSnapshot();
});

async function createMemory(env: NodeJS.ProcessEnv, sessionKey: string, entry: Entry) {
  const scope = { agentId: "main", env, sessionKey };
  const binding = await acquireSessionActorStorage(scope, { authority, lifetime, create: true });
  assert(binding, "Expected memory acquisition");
  databases.push({ agentId: binding.agentId, path: binding.path });
  await using _ = { [Symbol.asyncDispose]: () => binding.actor.release() };
  await binding.actor.storage.mutate({ type: "session.entry.create", input: { entry } }, authority);
  return { ...scope, storePath: binding.path };
}

const completeEntry: Entry = {
  sessionId: "selected",
  updatedAt: 1,
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

type Store = Omit<Parameters<typeof readById>[0], "sessionId" | "orderBy">;
type SessionApi = PluginRuntime["agent"]["session"];
const byId = (scope: Store, sessionId = "selected", orderBy?: "updatedAt") =>
  readById({ ...scope, sessionId, orderBy });
function publicRow(sessionKey: string, entry: Partial<Entry>) {
  return { sessionKey, entry: expect.objectContaining(entry) };
}
const put = (scope: Parameters<typeof readEntry>[0], entry: Entry) =>
  upsertSessionEntry({ ...scope, entry });

it("resolves historical transcript keys off the host after the current session changes", async () => {
  expectTypeOf<typeof resolveKeyAsync>().parameters.toEqualTypeOf<Parameters<typeof resolveKey>>();
  const scope = makeScope("sdk-historical-transcript-key-");
  const sessionKey = "agent:main:history";
  const read = (sessionId: string) =>
    withoutHostSql(() => resolveKeyAsync({ ...scope, sessionId }));
  expect(await read("missing")).toBeUndefined();
  expect(existsSync(resolveOpenClawAgentSqlitePath(scope))).toBe(false);
  await put({ ...scope, sessionKey }, { sessionId: "historical", updatedAt: 1 });
  expect(await read("historical")).toBe(sessionKey);
  await put({ ...scope, sessionKey }, { sessionId: "current", updatedAt: 2 });
  expect(await read("historical")).toBe(sessionKey);
  expect(await read("current")).toBe(sessionKey);
  expect(await read("missing")).toBeUndefined();
  using warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  for (let call = 0; call < 2; call++) {
    expect(resolveKey({ ...scope, sessionId: "historical" })).toBe(sessionKey);
  }
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("resolveTranscriptSessionKeyBySessionIdAsync"),
    { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
  );
  expect(await byId(scope, "historical")).toBeUndefined();
});

it("lists current public metadata off the host after an owner write without creating absent stores", async () => {
  expectTypeOf<SessionApi["listSessionEntriesAsync"]>().parameters.toEqualTypeOf<
    Parameters<typeof listEntries>
  >();
  const scope = makeScope("sdk-async-list-");
  const sessionKey = "agent:main:listed";
  await expect(listEntries(scope)).resolves.toEqual([]);
  expect(existsSync(resolveOpenClawAgentSqlitePath(scope))).toBe(false);

  const target = { ...scope, sessionKey };
  replaceSessionEntrySync(target, { ...completeEntry, initializationPending: true });
  const read = () => withoutHostSql(() => listEntries(scope));
  const before = await read();
  expect(before).toEqual([
    publicRow(sessionKey, {
      sessionId: "selected",
      initializationPending: true,
      pluginExtensions: completeEntry.pluginExtensions,
    }),
  ]);
  expect(before[0]?.entry).not.toHaveProperty("pendingProjectGitUrl");
  expect(before[0]?.entry).not.toHaveProperty("skillsSnapshot");

  await put(target, { sessionId: "replacement", updatedAt: 2, displayName: "Replacement" });
  expect(await read()).toEqual([
    publicRow(sessionKey, { sessionId: "replacement", displayName: "Replacement" }),
  ]);
  expect(before[0]?.entry.sessionId).toBe("selected");
});

it("reads committed watermark updates off the host and ignores a reset predecessor", async () => {
  const scope = { ...makeScope("sdk-watermark-"), sessionKey: "agent:main:telegram:group:room" };
  const key = watermarkKey({ channel: "telegram", accountId: "default", conversationId: "room" });
  const entry = (messageId: string, updatedAt: number) => ({
    sessionId: "before-reset",
    updatedAt: 1,
    ambientTranscriptWatermarks: { [key]: { sessionId: "before-reset", messageId, updatedAt } },
  });
  const read = () => withoutHostSql(() => readWatermark({ ...scope, key }));
  await put(scope, entry("11", 1));
  expect(await read()).toMatchObject({ messageId: "11" });

  await put(scope, entry("12", 2));
  expect(await read()).toMatchObject({ messageId: "12" });

  await put(scope, { ...entry("12", 2), sessionId: "after-reset" });
  expect(await read()).toBeUndefined();
});

it.each(["durable", "memory"] as const)("orders duplicate IDs (%s)", async (mode) => {
  expectTypeOf<SessionApi["getSessionEntryByIdAsync"]>().parameters.toEqualTypeOf<
    Parameters<typeof readById>
  >();
  const base = makeScope(`sdk-id-order-${mode}-`);
  const { env } = base;
  const scope = {
    ...base,
    ...(mode === "memory" ? { storePath: resolveIncognitoOpenClawAgentSqlitePath(base) } : {}),
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
      await createMemory(env, sessionKey, entry);
    } else {
      replaceSessionEntrySync({ ...scope, sessionKey }, entry);
    }
  }
  const expectId = (sessionId: string, suffix: string, orderBy?: "updatedAt") =>
    expect(byId(scope, sessionId, orderBy)).resolves.toMatchObject({
      sessionKey: `${prefix}${suffix}`,
    });
  await expectId("duplicate", "a-old");
  await expectId("duplicate", "m-tied", "updatedAt");
  await expectId("legacy", "b-exact");
  await expectId("legacy", "n-trimmed", "updatedAt");
});

it("keeps the complete public projection for durable and memory entry reads", async () => {
  const { env } = makeScope("sdk-async-entry-");
  const durable = { agentId: "main", env, sessionKey: "agent:main:durable" };
  expect(await byId(durable, "missing")).toBeUndefined();
  expect(existsSync(resolveOpenClawAgentSqlitePath(durable))).toBe(false);
  replaceSessionEntrySync(durable, completeEntry);
  const publicEntry = getEntry(durable);
  expect(publicEntry).toMatchObject({
    skillsSnapshot: completeEntry.skillsSnapshot,
    pluginExtensions: completeEntry.pluginExtensions,
    execCwd: completeEntry.execCwd,
  });
  expect(publicEntry).not.toHaveProperty("pendingProjectGitUrl");
  expect(publicEntry).not.toHaveProperty("cliHistoryBoundary");
  expect(publicEntry).not.toBeInstanceOf(Promise);
  await expect(readEntry(durable)).resolves.toEqual(publicEntry);
  const detachedEntry = (await readEntry(durable))!;
  detachedEntry.skillsSnapshot!.prompt = "Plugin-local replacement";
  detachedEntry.skillsSnapshot!.skills.push({ name: "plugin-local" });
  await expect(readEntry(durable)).resolves.toEqual(publicEntry);
  expect(await byId(durable)).toEqual({ sessionKey: durable.sessionKey, entry: publicEntry });
  const scope = await createMemory(env, "agent:main:dashboard:incognito-selected", {
    ...completeEntry,
    incognito: true,
  });
  await withoutHostSql(async () => {
    const entry = await readEntry(scope);
    expect(entry).toEqual({ ...publicEntry, incognito: true });
    expect(getEntry(scope)).toEqual(entry);
    expect(await byId(scope)).toEqual({ sessionKey: scope.sessionKey, entry });
    expect(await byId(scope, "missing")).toBeUndefined();
  });
});

it("cleans an unbound private recall helper selected through its configured durable path", async () => {
  const scope = makeScope("sdk-cleanup-memory-");
  const { env } = scope;
  const storePath = resolveOpenClawAgentSqlitePath(scope);
  const sessionKey = "agent:main:subagent:incognito-helper";
  const durableKey = "agent:main:durable-helper";
  const entry = { sessionId: "helper", updatedAt: 1, pluginOwnerId: "active-memory" };
  replaceSessionEntrySync({ ...scope, sessionKey: durableKey }, entry);
  await createMemory(env, sessionKey, { ...entry, incognito: true });
  await withoutHostSql(async () => {
    await expect(
      cleanup({
        ...scope,
        storePath,
        sessionKeySegmentPrefix: "subagent:incognito-helper",
        transcriptContentMarker: '"runId":"helper"',
        archiveRemovedEntryTranscripts: false,
        orphanTranscriptMinAgeMs: 0,
        nowMs: Date.now(),
      }),
    ).resolves.toEqual({ removedEntries: 1, archivedTranscriptArtifacts: 0 });
    await expect(readEntry({ ...scope, sessionKey })).resolves.toBeUndefined();
  });
  expect(getEntry({ ...scope, sessionKey: durableKey })).toMatchObject(entry);
});

it("keeps absent and closed memory owners absent without allocating a database", async () => {
  const { env } = makeScope("sdk-memory-absent-");
  const scope = { agentId: "main", env, sessionKey: "agent:main:dashboard:incognito-absent" };
  const database = { agentId: "main", path: resolveIncognitoOpenClawAgentSqlitePath(scope) };
  await expect(readEntry(scope)).resolves.toBeUndefined();
  const absent = await captureCurrent(scope);
  expect(absent.entry).toBeUndefined();
  await expect(absent.isCurrent()).resolves.toBe(true);
  expect(await byId({ ...scope, storePath: database.path }, "missing")).toBeUndefined();
  expect(memorySessionActorOwners.read(database)).toBeUndefined();
  const closed = { sessionId: "closed", updatedAt: 1, incognito: true };
  await createMemory(env, scope.sessionKey, closed);
  const binding = await acquireSessionActorStorage(scope, { authority, lifetime });
  assert(binding, "Expected existing memory session");
  await using _ = { [Symbol.asyncDispose]: () => binding.actor.release() };
  memorySessionActorOwners.closeDatabase(database);
  await expect(runWithSessionActorStorage(binding, () => readEntry(scope))).rejects.toThrow();
  await expect(readEntry(scope)).resolves.toBeUndefined();
  expect(memorySessionActorOwners.read(database)).toBeUndefined();
  expect(existsSync(database.path)).toBe(false);
});

it("keeps exact memory policy guards current without treating unrelated metadata as revocation", async () => {
  const { env } = makeScope("sdk-policy-current-");
  const target = await createMemory(env, "agent:main:dashboard:incognito-policy", {
    ...completeEntry,
    incognito: true,
    execHost: "node",
    execNode: "original-node",
  });
  await withoutHostSql(async () => {
    const prepared = await captureCurrent({ ...target, fields: ["execHost", "execNode"] });
    await expect(prepared.isCurrent()).resolves.toBe(true);
    expect(prepared.entry).toMatchObject({ execHost: "node", execNode: "original-node" });
    expect(prepared.entry).not.toHaveProperty("cliHistoryBoundary");
    expect(prepared.entry).not.toHaveProperty("pendingProjectGitUrl");
    prepared.entry!.execNode = "edited-return-value";
    await expect(prepared.isCurrent()).resolves.toBe(true);
    await patchSessionEntry({ ...target, update: () => ({ displayName: "unrelated" }) });
    await expect(prepared.isCurrent()).resolves.toBe(true);
    await patchSessionEntry({ ...target, update: () => ({ execNode: "replacement-node" }) });
    await expect(prepared.isCurrent()).resolves.toBe(false);
    await expect(prepared.assertCurrent()).rejects.toThrow("selected session changed");
    await expect(
      captureCurrent({
        ...target,
        fields: ["execNode"],
        expected: { sessionId: "selected", execNode: "original-node" },
      }),
    ).rejects.toThrow("selected session changed");
  });
});
