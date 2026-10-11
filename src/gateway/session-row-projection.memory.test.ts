import { afterEach, expect, it, vi } from "vitest";
import type { SessionActor } from "../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import type {
  SessionActorStorageAuthority,
  SessionActorStorageOutcome,
} from "../config/sessions/session-actor-storage-contract.js";
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

function committed<T>(outcome: SessionActorStorageOutcome<T>): T {
  if (outcome.kind !== "committed") {
    throw new Error(outcome.error.message);
  }
  return outcome.value;
}

afterEach(async () => {
  shared.beforeAcp = undefined;
  await Promise.all(actors.splice(0).map((actor) => actor.release()));
  memorySessionActorOwners.reset();
});

async function fixture(sessionKey = key, entry: Partial<InternalSessionEntry> = {}) {
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
  committed(
    await actor.storage!.mutate(
      {
        type: "session.entry.create",
        input: {
          entry: { sessionId: sessionKey, createdAt: 1, updatedAt: 1, incognito: true, ...entry },
          cwd: "/synthetic/workspace",
        },
      },
      authority,
    ),
  );
  const binding: SessionActorStorageBinding = { actor, authority, agentId, path: owner.path };
  const append = async (id: string, parentId: string | null, message: unknown) => {
    const result = await actor.appendTranscriptEvent(
      {
        commandId: id,
        phaseId: "turn",
        append: {
          kind: "metadata",
          input: {
            scope: { agentId, storePath: owner.path, sessionKey, sessionId: sessionKey },
            event: {
              type: "message",
              id,
              parentId,
              timestamp: new Date(1).toISOString(),
            },
            message: {
              messageJson: JSON.stringify(message),
              cwd: "/synthetic/workspace",
              validateTurn: false,
            },
            options: {},
          },
        },
      },
      authority,
    );
    expect(result.kind).toBe("committed");
  };
  return { owner, actor, binding, append };
}

function readRows<T>(
  binding: SessionActorStorageBinding,
  keys: string[],
  consume: (rows: ReadonlyMap<string, Row | undefined>) => T,
) {
  return runWithSessionActorStorage(binding, () =>
    withBoundIncognitoSessionRows(
      cfg,
      keys.map((sessionKey) => ({ key: sessionKey, agentId: sessionKey.split(":")[1]! })),
      consume,
      env,
    ),
  );
}
const rowAt = (rows: ReadonlyMap<string, Row | undefined>, sessionKey: string) =>
  rows.get(JSON.stringify([sessionKey.split(":")[1], sessionKey]));

it("prepares memory title, bounded fallback, board presence and cross-agent lineage", async () => {
  const root = await fixture(key, { parentSessionKey: parentKey });
  await fixture(parentKey, { displayName: "Parent" });
  await fixture(childKey, { parentSessionKey: key });
  await root.append("user", null, { role: "user", content: "A private question" });
  await root.append("answer", "user", {
    role: "assistant",
    content: "A private answer",
    stopReason: "stop",
    provider: "ollama",
    model: "example",
    __openclaw: { runId: "run" },
  });
  committed(
    await root.actor.storage!.mutate(
      {
        type: "session.entry.patch",
        input: {
          operation: {
            kind: "fields",
            patch: {
              status: "done",
              lastRunId: "run",
              fallbackNotice: {
                kind: "active",
                selectedModel: "openai/example",
                activeModel: "ollama/example",
                reason: "unavailable",
              },
            },
          },
        },
      },
      authority,
    ),
  );
  committed(
    await root.actor.storage!.mutate(
      {
        type: "boards.putWidget",
        input: {
          sessionKey: key,
          viewGeneration: "view",
          params: {
            sessionKey: key,
            name: "note",
            content: { kind: "html", html: "<p>Private</p>" },
          },
        },
      },
      authority,
    ),
  );
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
  committed(
    await root.actor.storage!.mutate(
      {
        type: "session.collaboration.add",
        input: { params: { identityId: "old", addedBy: "owner", addedAt: 1 } },
      },
      authority,
    ),
  );
  shared.beforeAcp = async () => {
    committed(
      await root.actor.storage!.mutate(
        { type: "session.collaboration.remove", input: { identityId: "old" } },
        authority,
      ),
    );
    committed(
      await root.actor.storage!.mutate(
        {
          type: "session.entry.patch",
          input: { operation: { kind: "fields", patch: { displayName: "Current name" } } },
        },
        authority,
      ),
    );
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

it("keeps absent and closed sibling selections out of native storage", async () => {
  const root = await fixture();
  const child = await fixture(childKey);
  child.owner.closeSession(childKey);
  const absent = "agent:work:dashboard:incognito-absent";
  await readRows(root.binding, [childKey, absent], (rows) => {
    expect(rowAt(rows, childKey)).toBeUndefined();
    expect(rowAt(rows, absent)).toBeUndefined();
  });
});

it("reads memory reactions after writes through the Gateway reader", async () => {
  const root = await fixture();
  const sibling = await fixture(childKey);
  await sibling.append("message", null, { role: "user", content: "React to this" });
  const params = {
    expectedSessionId: childKey,
    messageId: "message",
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
  committed(
    await sibling.actor.storage!.mutate(
      { type: "session.reaction.set", input: { params } },
      authority,
    ),
  );
  expect(await read()).toEqual({
    message: [{ emoji: "👍", count: 1, identities: [{ id: "viewer" }] }],
  });
  committed(
    await sibling.actor.storage!.mutate(
      { type: "session.reaction.set", input: { params: { ...params, remove: true } } },
      authority,
    ),
  );
  expect(await read()).toEqual({});
});

it("selects unbound row owners and keeps absent reads from recreating a closed session", async () => {
  const root = await fixture();
  const queries = [
    { key, agentId: "main" },
    { key: parentKey, agentId: "work" },
  ];
  const read = () =>
    withBoundIncognitoSessionRows(
      cfg,
      queries,
      (rows) => ({
        entry: rowAt(rows, key)?.entry,
        absent: rowAt(rows, parentKey),
      }),
      env,
    );
  expect(await read()).toMatchObject({ entry: { sessionId: key }, absent: undefined });
  committed(
    await root.actor.storage!.mutate(
      {
        type: "session.entry.patch",
        input: { operation: { kind: "fields", patch: { displayName: "Updated in memory" } } },
      },
      authority,
    ),
  );
  expect((await read()).entry?.displayName).toBe("Updated in memory");
  root.owner.closeSession(key);
  expect(await read()).toEqual({ entry: undefined, absent: undefined });
  expect(memorySessionActorOwners.list()).toHaveLength(1);
  expect(root.owner.listSessions(authority)).toEqual([]);
});
