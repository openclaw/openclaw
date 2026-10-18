import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionEntry,
  statSessionEntrySync,
} from "../../../packages/memory-host-sdk/src/host/session-files.js";
import { readSessionResetRecallCutoff } from "../../../packages/memory-host-sdk/src/host/session-reset-recall-read.js";
import type { SessionLeafControl } from "../../agents/sessions/session-manager-types.js";
import {
  loadMemorySessionMetadata,
  loadMemorySessionMetadataAsync,
  loadMemorySessionMetadataBatchAsync,
} from "../../plugin-sdk/memory-core-host-engine-sessions.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionActorAuthority, SessionActorStorage } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { memoryStorage } from "./session-actor-memory-publication.test-support.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
} from "./session-actor-storage-binding.js";
import {
  readSessionTranscriptCorpusInWorker,
  resolveMemorySessionTargetsInWorker,
} from "./session-transcript-inventory-runtime.js";
import { readSessionTranscriptIndexStatus } from "./session-transcript-projection-writer.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import { searchSessionTranscripts } from "./session-transcript-search.js";
import type { SessionTranscriptSearchParams } from "./session-transcript-search.types.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory search opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory search allocated a worker");
  }),
}));

describe("actor-owned transcript search", () => {
  const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
  const lifetime = { assertCurrent() {}, assertReadable() {} };
  const agentId = "main";
  const env = { OPENCLAW_STATE_DIR: "/synthetic/incognito-search" };
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
  afterEach(() => memorySessionActorOwners.reset());

  function message(
    id: string,
    content: string,
    options: { role?: "user" | "assistant"; parentId?: string | null; timestamp?: number } = {},
  ) {
    return {
      type: "message" as const,
      id,
      parentId: options.parentId ?? null,
      timestamp: new Date(options.timestamp ?? 10).toISOString(),
      message: { role: options.role ?? "user", content, timestamp: options.timestamp ?? 10 },
    };
  }

  async function fixture() {
    const create = async (id: string, events: unknown[]) => {
      const sessionKey = `agent:main:dashboard:incognito-${id}`;
      const binding = (await acquireSessionActorStorage(
        { agentId, storePath, sessionKey, env },
        { authority, lifetime, create: true },
      ))!;
      const storage = binding.actor.storage;
      await memoryStorage(storage).commit("session.entry.create", {
        entry: { sessionId: id, updatedAt: 1 },
        cwd: "/synthetic",
        transcriptEvents: events,
      });
      return { sessionKey, storage, binding };
    };
    const search = (query: string, options: Partial<SessionTranscriptSearchParams> = {}) =>
      searchSessionTranscripts({ agentId, storePath, env, query, ...options });
    return { create, search };
  }

  async function append(
    storage: SessionActorStorage,
    sessionKey: string,
    sessionId: string,
    event: ReturnType<typeof message> | SessionLeafControl,
  ) {
    const prepared = event.type === "message" ? event : undefined;
    await memoryStorage(storage).commit("session.metadata.append", {
      scope: { agentId, storePath, sessionKey, sessionId },
      event: prepared
        ? {
            type: prepared.type,
            id: prepared.id,
            parentId: prepared.parentId,
            timestamp: prepared.timestamp,
          }
        : JSON.stringify(event),
      options: {},
      ...(prepared
        ? {
            message: {
              messageJson: JSON.stringify(prepared.message),
              cwd: "/synthetic",
              validateTurn: false,
            },
          }
        : {}),
    });
  }

  it("returns empty results without allocating a memory owner for an absent namespace", async () => {
    expect(await searchSessionTranscripts({ agentId, storePath, env, query: "missing" })).toEqual({
      hits: [],
      indexing: false,
      truncated: false,
    });
    expect(memorySessionActorOwners.list()).toEqual([]);
  });
  it("preserves literal phrases, AND terms, final prefix, accents and result bounds through the search adapter", async () => {
    const { create, search } = await fixture();
    await create("complete", [
      message("complete", "Per-session communication controls in Café UI"),
    ]);
    await create("earlier-prefix", [
      message("earlier-prefix", "Periodic sessions communication controls in UI"),
    ]);
    await create("literal", [message("literal", 'A literal "OR" keyword in the message')]);
    await create("greek", [message("greek", "ΟΣ ος")]);
    for (const [query, options, ids] of [
      ["per session communi", {}, []],
      ["per-session communi", { match: "prefix" }, ["complete"]],
      ["CAFE communication", {}, ["complete"]],
      ["οσ", {}, ["greek"]],
      ['literal "OR" key', { match: "prefix" }, ["literal"]],
      ["literal OR missing", {}, []],
      ['"', {}, []],
    ] as const) {
      expect(
        (await search(query, options)).hits.map((hit) => hit.messageId),
        query,
      ).toEqual(ids);
    }
    await expect(search(" ")).rejects.toThrow("query must not be empty");
    await expect(search("a".repeat(4097))).rejects.toThrow("query must not exceed 4096");
    const bounded = await search("communication", { limit: 1 });
    expect(bounded.hits).toHaveLength(1);
    expect(bounded.truncated).toBe(true);
  });

  it("uses corpus BM25 before scope filtering and preserves recent ordering and snippets", async () => {
    const { create, search } = await fixture();
    const selected = await create("selected", [message("a", "saffron", { role: "assistant" })]);
    await create("long", [
      message("b", "saffron saffron ballast ballast ballast", { timestamp: 20 }),
    ]);
    await create("background", [message("c", "background corpus vocabulary")]);
    const all = await search("saffron");
    const scoped = await search("saffron", {
      role: "assistant",
      sessionKeys: [selected.sessionKey],
      limit: 1,
    });
    expect(scoped.hits).toHaveLength(1);
    expect(scoped.hits[0]).toMatchObject({
      messageId: "a",
      snippet: "saffron",
      score: all.hits.find((hit) => hit.messageId === "a")!.score,
    });
    expect(scoped.hits[0]!.score).toBeCloseTo(0.000001375, 14);
    expect((await search("saffron", { order: "recent" })).hits.map((hit) => hit.messageId)).toEqual(
      ["b", "a"],
    );
    await create("snippet", [
      message("snippet", `${"before ".repeat(60)}saffron ${"after ".repeat(60)}`),
    ]);
    const snippet = (await search("saffron", { sessionId: "snippet" })).hits[0]!.snippet;
    expect(snippet).toContain("saffron");
    expect(snippet).toMatch(/^ … /u);
    expect(snippet).toMatch(/ … $/u);
    expect(snippet.split(/\s+/u).filter((token) => token !== "…" && token)).toHaveLength(48);
    await create("huge", [message("huge", `saffron ${"𐐀".repeat(400)}`)]);
    const huge = (await search("saffron", { sessionId: "huge" })).hits[0]!.snippet;
    expect(huge.length).toBeLessThanOrEqual(501);
    expect(huge.isWellFormed()).toBe(true);
  });

  it("reads append, rewind, reset and deletion from the committed owner without stale indexes", async () => {
    const { create, search } = await fixture();
    const session = await create("before-reset", [
      message("base", "base"),
      message("removed", "rewound secret", { parentId: "base" }),
    ]);
    expect((await search("rewound")).hits).toHaveLength(1);
    await append(session.storage, session.sessionKey, "before-reset", {
      type: "leaf",
      id: "rewind",
      parentId: "removed",
      targetId: "base",
      timestamp: new Date(11).toISOString(),
    });
    expect((await search("rewound")).hits).toEqual([]);
    {
      const database = { agentId, path: storePath };
      startSessionTranscriptIndexReconcile(database);
      expect(await readSessionTranscriptIndexStatus(database)).toBe(false);
      expect(isSessionTranscriptIndexReconcileRunning(database)).toBe(false);
      expect(await reconcileSessionTranscriptIndexes(database)).toEqual({ reconciledSessions: 0 });
      await waitForSessionTranscriptIndexReconcile(database);
    }
    await append(
      session.storage,
      session.sessionKey,
      "before-reset",
      message("fresh", "fresh content", { parentId: "base" }),
    );
    expect((await search("fresh")).hits.map((hit) => hit.messageId)).toEqual(["fresh"]);
    const storage = memoryStorage(session.storage);
    const expected = await storage.read("session.entry.read", {});
    await storage.commit("session.lifecycle.reset", {
      expected,
      nextEntry: { ...expected!, sessionId: "after-reset" },
    });
    expect((await search("fresh", { sessionId: "before-reset" })).hits).toHaveLength(1);
    expect((await search("fresh", { sessionId: "after-reset" })).hits).toEqual([]);
    // A current acquisition closes the previous window's handle; deletion removes every retained window.
    const current = (await acquireSessionActorStorage(
      { agentId, storePath, env, sessionKey: session.sessionKey },
      { authority, lifetime },
    ))!.actor;
    await memoryStorage(current.storage!).commit("session.lifecycle.delete", {});
    expect((await search("fresh")).hits).toEqual([]);
  });
});

describe("Memory export from the session actor", () => {
  const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
  const lifetime = { assertCurrent() {}, assertReadable() {} };
  const env = { OPENCLAW_STATE_DIR: "/synthetic/memory-corpus" };
  const scope = {
    agentId: "main",
    sessionId: "before-reset",
    sessionKey: "agent:main:dashboard:incognito-memory-corpus",
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
    env,
  };
  const owners: Array<{ agentId: string; path: string }> = [];
  afterEach(() => {
    for (const owner of owners.splice(0)) {
      memorySessionActorOwners.closeDatabase(owner);
    }
  });
  const message = (id: string, text: string) => ({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-10-11T00:00:00.000Z",
    message: { role: "user", content: text },
  });

  async function fixture(target = scope) {
    const { sessionId: _sessionId, ...acquisition } = target;
    owners.push({ agentId: target.agentId, path: target.storePath });
    const initial = await acquireSessionActorStorage(acquisition, {
      lifetime,
      authority,
      create: true,
    });
    if (!initial) {
      throw new Error("Memory creation did not select the actor");
    }
    const actor = initial.actor;
    await memoryStorage(actor.storage!).commit("session.entry.create", {
      entry: { sessionId: target.sessionId, updatedAt: 1 },
      transcriptEvents: [
        { type: "session", id: target.sessionId, version: 3, cwd: "/synthetic" },
        message("old", "Previous discussion"),
        { type: "reset", id: "reset", parentId: "old", firstKeptEntryId: "old" },
        message("new", "Current discussion"),
      ],
    });
    return { actor };
  }

  it("projects retained snapshots and reset cutoff through the host facade without native storage", async () => {
    const { actor } = await fixture();
    const storage = memoryStorage(actor.storage!);
    const expected = await storage.read("session.entry.read", {});
    await storage.commit("session.lifecycle.reset", {
      expected,
      nextEntry: { ...expected!, sessionId: "after-reset" },
    });
    expect(await loadMemorySessionMetadataAsync(scope)).toMatchObject({
      agentId: "main",
      sessionId: "before-reset",
      sessionKey: scope.sessionKey,
      resolution: "live",
    });
    expect(
      await loadMemorySessionMetadataBatchAsync({
        ...scope,
        sessions: [{ sessionId: "after-reset" }, { sessionId: "missing" }],
      }),
    ).toMatchObject([{ sessionId: "after-reset", sessionKey: scope.sessionKey }]);
    expect(() => loadMemorySessionMetadata(scope)).toThrow("loadMemorySessionMetadataAsync");
    const entry = await buildSessionEntry(scope.sessionKey, scope);
    expect(entry?.content).toBe("User: Previous discussion\nUser: Current discussion");
    expect(await readSessionResetRecallCutoff(scope)).toEqual({ state: "valid", cutoffLine: 2 });
    expect(await readSessionResetRecallCutoff({ ...scope, sessionId: "after-reset" })).toEqual({
      state: "absent",
    });
    expect(() => statSessionEntrySync(scope.sessionKey, scope)).toThrow(
      "statSessionEntrySync cannot access an incognito session synchronously. Await statSessionEntry instead.",
    );
  });

  it("reads another agent's memory inventory and leaves an absent explicit owner absent", async () => {
    const { actor } = await fixture();
    const other = {
      ...scope,
      agentId: "other",
      sessionId: "other-window",
      sessionKey: "agent:other:dashboard:incognito-other",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "other", env }),
    };
    await fixture(other);
    await runWithSessionActorStorage(
      { actor, authority, agentId: scope.agentId, path: scope.storePath },
      async () => {
        expect((await buildSessionEntry(other.sessionKey, other))?.content).toContain(
          "Current discussion",
        );
        const entries = await readSessionTranscriptCorpusInWorker(
          {
            cfg: {},
            env,
            normalizedAgentId: other.agentId,
            storePath: other.storePath,
            isSharedFixedStore: false,
            artifactDirs: [],
          },
          {},
          async () => {
            throw new Error("Memory inventory tried to read archive files");
          },
        );
        expect(entries).toMatchObject([{ agentId: "other", sessionId: "other-window" }]);
      },
    );
    const missing = {
      ...scope,
      agentId: "absent",
      sessionKey: "agent:absent:dashboard:incognito-absent",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "absent", env }),
    };
    expect(await buildSessionEntry(missing.sessionKey, missing)).toBeNull();
    expect(
      await resolveMemorySessionTargetsInWorker({
        agentId: missing.agentId,
        storePath: missing.storePath,
        sessionIds: [missing.sessionId],
      }),
    ).toMatchObject([{ resolution: "unresolved" }]);
    expect(
      memorySessionActorOwners.read({ agentId: missing.agentId, path: missing.storePath }),
    ).toBeUndefined();
  });

  it("blocks the next transcript disclosure when permission is revoked by a consumer callback", async () => {
    const { actor } = await fixture();
    let allowed = true;
    const selectedAuthority: SessionActorAuthority = {
      assertCurrent() {},
      authorize() {
        if (!allowed) {
          throw new Error("Memory disclosure was revoked");
        }
      },
    };
    const disclosed: unknown[] = [];
    await expect(
      runWithSessionActorStorage(
        { actor, authority: selectedAuthority, agentId: scope.agentId, path: scope.storePath },
        () =>
          buildSessionEntry(scope.sessionKey, {
            ...scope,
            onTranscriptMessage(value) {
              disclosed.push(value);
              allowed = false;
            },
          }),
      ),
    ).rejects.toThrow("Memory disclosure was revoked");
    expect(disclosed).toEqual([{ role: "user", content: "Previous discussion" }]);
  });
});
