import { afterEach, expect, it, vi } from "vitest";
import type { SessionActor } from "../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { commitMemory } from "../config/sessions/session-actor-memory-publication.test-support.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import type { SessionActorStorageAuthority } from "../config/sessions/session-actor-storage-contract.js";
import { createSessionTranscriptHeader } from "../config/sessions/transcript-header.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withBoundIncognitoSessionRows } from "./session-row-projection-read.js";
import type { Row } from "./session-row-projection-record.js";
import { readSessionReactionsAsync } from "./session-transcript-readers.js";

const shared = vi.hoisted(() => ({ beforeAcp: undefined as (() => Promise<void>) | undefined }));
vi.mock("../acp/runtime/session-meta-read.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../acp/runtime/session-meta-read.js")>()),
  prepareAcpSessionEntryRead: async () => {
    await shared.beforeAcp?.();
    return { session: undefined, assertCurrent() {}, release() {} };
  },
}));
vi.mock("../agents/harness/session-runtime-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/harness/session-runtime-ownership.js")>()),
  readSessionRuntimeOwnershipAsync: async () => null,
}));
vi.mock("../agents/subagents/registry/subagent-registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../agents/subagents/registry/subagent-registry-read.js")
  >()),
  listSubagentSessionListRunsForControllers: () => [],
}));
vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory row opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory row allocated a worker");
  }),
}));

const cfg = { agents: { entries: { main: {}, work: {} } } };
const env = { OPENCLAW_STATE_DIR: "/synthetic/memory-row-projection" };
const key = "agent:main:dashboard:incognito-row";
const childKey = "agent:main:dashboard:incognito-child";
const parentKey = "agent:work:dashboard:incognito-parent";
const authority: SessionActorStorageAuthority = { assertCurrent() {}, authorize() {} };
const actors: SessionActor[] = [];

function patch(actor: SessionActor, fields: Partial<InternalSessionEntry>) {
  return commitMemory(actor.storage!, "session.entry.patch", {
    operation: { kind: "fields", patch: fields },
  });
}

afterEach(async () => {
  shared.beforeAcp = undefined;
  await Promise.all(actors.splice(0).map((actor) => actor.release()));
  memorySessionActorOwners.reset();
});

async function fixture(
  sessionKey = key,
  entry: Partial<InternalSessionEntry> = {},
  messages: unknown[] = [],
) {
  const agentId = sessionKey.split(":")[1]!;
  const owner = memorySessionActorOwners.get({
    agentId,
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId, env }),
  });
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  actors.push(actor);
  await commitMemory(actor.storage!, "session.entry.create", {
    entry: { sessionId: sessionKey, createdAt: 1, updatedAt: 1, incognito: true, ...entry },
    cwd: "/synthetic/workspace",
    transcriptEvents: [
      createSessionTranscriptHeader({ sessionId: sessionKey, cwd: "/synthetic/workspace" }),
      ...messages.map((message, index) => ({
        type: "message",
        id: String(index),
        parentId: index ? String(index - 1) : null,
        timestamp: new Date(1).toISOString(),
        message,
      })),
    ],
  });
  const binding: SessionActorStorageBinding = { actor, authority, agentId, path: owner.path };
  return { owner, actor, binding };
}

type Rows = ReadonlyMap<string, Row | undefined>;
function readRows<T>(
  binding: SessionActorStorageBinding | undefined,
  keys: string[],
  consume: (rows: Rows) => T,
) {
  const read = () =>
    withBoundIncognitoSessionRows(
      cfg,
      keys.map((sessionKey) => ({ key: sessionKey, agentId: sessionKey.split(":")[1]! })),
      consume,
      env,
    );
  return binding ? runWithSessionActorStorage(binding, read) : read();
}
const rowAt = (rows: Rows, sessionKey: string) =>
  rows.get(JSON.stringify([sessionKey.split(":")[1], sessionKey]));

it("prepares memory title, bounded fallback, board presence and cross-agent lineage", async () => {
  const root = await fixture(key, { parentSessionKey: parentKey }, [
    { role: "user", content: "A private question" },
    {
      role: "assistant",
      content: "A private answer",
      stopReason: "stop",
      provider: "ollama",
      model: "example",
      __openclaw: { runId: "run" },
    },
  ]);
  await fixture(parentKey, { displayName: "Parent" });
  await fixture(childKey, { parentSessionKey: key });
  await patch(root.actor, {
    status: "done",
    lastRunId: "run",
    fallbackNotice: {
      kind: "active",
      selectedModel: "openai/example",
      activeModel: "ollama/example",
      reason: "unavailable",
    },
  });
  await commitMemory(root.actor.storage!, "boards.putWidget", {
    sessionKey: key,
    viewGeneration: "view",
    params: { sessionKey: key, name: "note", content: { kind: "html", html: "<p>Private</p>" } },
  });
  await readRows(root.binding, [key, childKey, parentKey], (rows) => {
    const row = rowAt(rows, key)!;
    expect(row.preparedPrivate).toMatchObject({
      titleFields: {
        firstUserMessage: "A private question",
        lastMessagePreview: "A private answer",
      },
      terminalModel: { modelProvider: "ollama", model: "example" },
      databaseFacts: { hasBoard: true },
      relatedRows: {
        [parentKey]: { agentId: "work", entry: { displayName: "Parent" } },
        [childKey]: { entry: { parentSessionKey: key } },
      },
    });
    expect(rowAt(rows, childKey)?.entry?.sessionId).toBe(childKey);
    expect(rowAt(rows, parentKey)?.entry?.sessionId).toBe(parentKey);
  });
});

it("uses current sharing facts after async preparation and closes the presentation lifetime", async () => {
  const root = await fixture();
  await commitMemory(root.actor.storage!, "session.collaboration.add", {
    params: { identityId: "old", addedBy: "owner", addedAt: 1 },
  });
  shared.beforeAcp = async () => {
    await commitMemory(root.actor.storage!, "session.collaboration.remove", { identityId: "old" });
    await patch(root.actor, { displayName: "Current name" });
  };
  let source: Row["privateSource"];
  await readRows(root.binding, [key], (rows) => {
    const row = rowAt(rows, key)!;
    expect(row.membership.size).toBe(0);
    expect(row.entry?.displayName).toBe("Current name");
    source = row.privateSource;
    source?.assertCurrent();
  });
  expect(() => source?.assertCurrent()).toThrow("no longer active");
  shared.beforeAcp = async () => root.owner.closeSession(key);
  await expect(readRows(root.binding, [key], () => undefined)).rejects.toThrow("closed");
});

it("prepares queued rows after the turn releases its actor without extending session lifetime", async () => {
  const root = await fixture();
  await fixture(childKey, { parentSessionKey: key });
  let authorized = true;
  const binding = {
    ...root.binding,
    authority: {
      ...authority,
      assertCurrent() {
        if (!authorized) {
          throw new Error("Disclosure authority revoked");
        }
      },
    },
  };
  await root.actor.release();
  await readRows(binding, [key, childKey], (rows) => {
    expect(rowAt(rows, key)?.entry).toMatchObject({ sessionId: key, incognito: true });
    expect(rowAt(rows, childKey)?.entry).toMatchObject({
      sessionId: childKey,
      parentSessionKey: key,
    });
  });
  authorized = false;
  await expect(readRows(binding, [key], () => undefined)).rejects.toThrow(
    "Disclosure authority revoked",
  );
  root.owner.closeSession(key);
  await readRows(root.binding, [key], (rows) => {
    expect(rowAt(rows, key)).toBeUndefined();
  });
});

it("reads memory reactions after writes through the Gateway reader", async () => {
  const root = await fixture();
  const sibling = await fixture(childKey, {}, [{ role: "user", content: "React to this" }]);
  const params = {
    expectedSessionId: childKey,
    messageId: "0",
    emoji: "👍",
    identityId: "viewer",
  };
  const read = () =>
    runWithSessionActorStorage(root.binding, () =>
      readSessionReactionsAsync({
        agentId: "main",
        sessionKey: childKey,
        sessionId: childKey,
        env,
      }),
    );
  await commitMemory(sibling.actor.storage!, "session.reaction.set", { params });
  expect(await read()).toEqual({
    0: [{ emoji: "👍", count: 1, identities: [{ id: "viewer" }] }],
  });
  await commitMemory(sibling.actor.storage!, "session.reaction.set", {
    params: { ...params, remove: true },
  });
  expect(await read()).toEqual({});
});

it("selects unbound row owners and keeps absent reads from recreating a closed session", async () => {
  const root = await fixture();
  const read = () =>
    readRows(undefined, [key, parentKey], (rows) => ({
      entry: rowAt(rows, key)?.entry,
      absent: rowAt(rows, parentKey),
    }));
  expect(await read()).toMatchObject({ entry: { sessionId: key }, absent: undefined });
  await patch(root.actor, { displayName: "Updated in memory" });
  expect((await read()).entry?.displayName).toBe("Updated in memory");
  root.owner.closeSession(key);
  expect(await read()).toEqual({ entry: undefined, absent: undefined });
  expect(memorySessionActorOwners.list()).toHaveLength(1);
  expect(root.owner.listSessions(authority)).toEqual([]);
});
