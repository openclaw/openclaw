import "./session-actor-memory-native-guards.test-support.js";
import { describe, expect, it } from "vitest";
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
import type { SessionActorAuthority } from "./session-actor-contract.js";
import {
  appendMemoryMessage,
  authority,
  lifetime,
  memoryBinding,
  messageEvent,
  expectEqual,
  expectMatch,
} from "./session-actor-memory-fixture.test-support.js";
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

describe("actor-owned transcript search", () => {
  const agentId = "main";
  const env = { OPENCLAW_STATE_DIR: "/synthetic/incognito-search" };
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });

  function message(
    id: string,
    content: string,
    options: { role?: "user" | "assistant"; parentId?: string | null; timestamp?: number } = {},
  ) {
    return messageEvent(
      id,
      options.parentId ?? null,
      { role: options.role ?? "user", content, timestamp: options.timestamp ?? 10 },
      new Date(options.timestamp ?? 10).toISOString(),
    );
  }

  const create = async (id: string, events: unknown[] | string) => {
    const sessionKey = `agent:main:dashboard:incognito-${id}`;
    const scope = { agentId, storePath, sessionKey, sessionId: id, env };
    const f = await memoryBinding(scope);
    await f.commit("session.entry.create", {
      entry: { sessionId: id, updatedAt: 1 },
      cwd: "/synthetic",
      transcriptEvents: typeof events === "string" ? [message(id, events)] : events,
    });
    return { ...f, sessionKey, scope };
  };
  const search = (query: string, options: Partial<SessionTranscriptSearchParams> = {}) =>
    searchSessionTranscripts({ agentId, storePath, env, query, ...options });

  async function append(
    session: Awaited<ReturnType<typeof create>>,
    event: ReturnType<typeof message> | SessionLeafControl,
  ) {
    if (event.type === "message") {
      return appendMemoryMessage(session.storage, session.scope, event);
    }
    await session.commit("session.metadata.append", {
      scope: session.scope,
      event: JSON.stringify(event),
      options: {},
    });
  }

  it("returns empty results without allocating a memory owner for an absent namespace", async () => {
    await expectEqual(searchSessionTranscripts({ agentId, storePath, env, query: "missing" }), {
      hits: [],
      indexing: false,
      truncated: false,
    });
    expect(memorySessionActorOwners.list()).toEqual([]);
  });
  it("preserves literal phrases, AND terms, final prefix, accents and result bounds through the search adapter", async () => {
    await create("complete", "Per-session communication controls in Café UI");
    await create("earlier-prefix", "Periodic sessions communication controls in UI");
    await create("literal", 'A literal "OR" keyword in the message');
    await create("greek", "ΟΣ ος");
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
    expect(bounded).toMatchObject({ hits: [expect.any(Object)], truncated: true });
  });

  it("uses corpus BM25 before scope filtering and preserves recent ordering and snippets", async () => {
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
    expect(scoped.hits).toMatchObject([
      {
        messageId: "a",
        snippet: "saffron",
        score: all.hits.find((hit) => hit.messageId === "a")!.score,
      },
    ]);
    expect(scoped.hits[0]!.score).toBeCloseTo(0.000001375, 14);
    expect((await search("saffron", { order: "recent" })).hits.map((hit) => hit.messageId)).toEqual(
      ["b", "a"],
    );
    await create("snippet", `${"before ".repeat(60)}saffron ${"after ".repeat(60)}`);
    const snippet = (await search("saffron", { sessionId: "snippet" })).hits[0]!.snippet;
    expect(snippet).toMatch(/^ … .*saffron.* … $/u);
    expect(snippet.split(/\s+/u).filter((token) => token !== "…" && token)).toHaveLength(48);
    await create("huge", `saffron ${"𐐀".repeat(400)}`);
    const huge = (await search("saffron", { sessionId: "huge" })).hits[0]!.snippet;
    expect(huge.length).toBeLessThanOrEqual(501);
    expect(huge.isWellFormed()).toBe(true);
  });

  it("reads append, rewind, reset and deletion from the committed owner without stale indexes", async () => {
    const session = await create("before-reset", [
      message("base", "base"),
      message("removed", "rewound secret", { parentId: "base" }),
    ]);
    expect((await search("rewound")).hits).toHaveLength(1);
    await append(session, {
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
      await expectEqual(reconcileSessionTranscriptIndexes(database), { reconciledSessions: 0 });
      await waitForSessionTranscriptIndexReconcile(database);
    }
    await append(session, message("fresh", "fresh content", { parentId: "base" }));
    expect((await search("fresh")).hits.map((hit) => hit.messageId)).toEqual(["fresh"]);
    const expected = await session.read("session.entry.read", {});
    await session.commit("session.lifecycle.reset", {
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
  const env = { OPENCLAW_STATE_DIR: "/synthetic/memory-corpus" };
  const scope = {
    agentId: "main",
    sessionId: "before-reset",
    sessionKey: "agent:main:dashboard:incognito-memory-corpus",
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
    env,
  };
  const message = (id: string, content: string) =>
    messageEvent(id, null, { role: "user", content });
  const scopeFor = (agentId: string, sessionId = scope.sessionId) => ({
    ...scope,
    agentId,
    sessionId,
    sessionKey: `agent:${agentId}:dashboard:incognito-${agentId}`,
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId, env }),
  });

  async function fixture(target = scope) {
    const f = await memoryBinding(target);
    await f.commit("session.entry.create", {
      entry: { sessionId: target.sessionId, updatedAt: 1 },
      transcriptEvents: [
        { type: "session", id: target.sessionId, version: 3, cwd: "/synthetic" },
        message("old", "Previous discussion"),
        { type: "reset", id: "reset", parentId: "old", firstKeptEntryId: "old" },
        message("new", "Current discussion"),
      ],
    });
    return f;
  }

  it("projects retained snapshots and reset cutoff through the host facade without native storage", async () => {
    const { actor } = await fixture();
    const storage = memoryStorage(actor.storage!);
    const expected = await storage.read("session.entry.read", {});
    await storage.commit("session.lifecycle.reset", {
      expected,
      nextEntry: { ...expected!, sessionId: "after-reset" },
    });
    await expectMatch(loadMemorySessionMetadataAsync(scope), {
      agentId: "main",
      sessionId: "before-reset",
      sessionKey: scope.sessionKey,
      resolution: "live",
    });
    await expectMatch(
      loadMemorySessionMetadataBatchAsync({
        ...scope,
        sessions: [{ sessionId: "after-reset" }, { sessionId: "missing" }],
      }),
      [{ sessionId: "after-reset", sessionKey: scope.sessionKey }],
    );
    expect(() => loadMemorySessionMetadata(scope)).toThrow("loadMemorySessionMetadataAsync");
    const entry = await buildSessionEntry(scope.sessionKey, scope);
    expect(entry?.content).toBe("User: Previous discussion\nUser: Current discussion");
    await expectEqual(readSessionResetRecallCutoff(scope), { state: "valid", cutoffLine: 2 });
    await expectEqual(readSessionResetRecallCutoff({ ...scope, sessionId: "after-reset" }), {
      state: "absent",
    });
    expect(() => statSessionEntrySync(scope.sessionKey, scope)).toThrow(
      "statSessionEntrySync cannot access an incognito session synchronously. Await statSessionEntry instead.",
    );
  });

  it("reads another agent's memory inventory and leaves an absent explicit owner absent", async () => {
    const { actor } = await fixture();
    const other = scopeFor("other", "other-window");
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
    const missing = scopeFor("absent");
    expect(await buildSessionEntry(missing.sessionKey, missing)).toBeNull();
    await expectMatch(
      resolveMemorySessionTargetsInWorker({
        agentId: missing.agentId,
        storePath: missing.storePath,
        sessionIds: [missing.sessionId],
      }),
      [{ resolution: "unresolved" }],
    );
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
