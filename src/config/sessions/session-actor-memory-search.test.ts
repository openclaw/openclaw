import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLeafControl } from "../../agents/sessions/session-manager-types.js";
import type { SessionActorAuthority, SessionActorStorage } from "./session-actor-contract.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import type { SessionActorStorageBinding } from "./session-actor-storage-binding.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
import type { SessionActorStorageOutcome } from "./session-actor-storage-contract.js";
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

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const agentId = "main";
const storePath = "/synthetic/incognito-search";
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

function committed<T>(outcome: SessionActorStorageOutcome<T>): T {
  if (outcome.kind !== "committed") {
    throw new Error(outcome.error.message);
  }
  return outcome.value;
}

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
  const owner = createMemorySessionActorOwner({ agentId, path: storePath });
  owners.push(owner);
  const create = async (id: string, events: unknown[]) => {
    const sessionKey = `agent:main:dashboard:incognito-${id}`;
    const actor = await owner.acquire({ database: owner.identity, sessionKey }, lifetime);
    const storage = actor.storage!;
    committed(
      await storage.mutate(
        {
          type: "session.entry.create",
          input: {
            entry: { sessionId: id, updatedAt: 1 },
            cwd: "/synthetic",
            transcriptEvents: events,
          },
        },
        authority,
      ),
    );
    const binding: SessionActorStorageBinding = { actor, authority, agentId, path: storePath };
    return { sessionKey, storage, binding };
  };
  const root = await create("root", []);
  const search = (query: string, options: Partial<SessionTranscriptSearchParams> = {}) =>
    runWithSessionActorStorage(root.binding, () =>
      searchSessionTranscripts({ agentId, storePath, query, ...options }),
    );
  return {
    create,
    search,
    run: <T>(operation: () => T) => runWithSessionActorStorage(root.binding, operation),
  };
}

async function append(
  storage: SessionActorStorage,
  sessionKey: string,
  sessionId: string,
  event: ReturnType<typeof message> | SessionLeafControl,
) {
  const prepared = event.type === "message" ? event : undefined;
  committed(
    await storage.mutate(
      {
        type: "session.metadata.append",
        input: {
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
        },
      },
      authority,
    ),
  );
}

describe("actor-owned transcript search", () => {
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
    const { create, search, run } = await fixture();
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
    await run(async () => {
      const database = { agentId, path: storePath };
      startSessionTranscriptIndexReconcile(database);
      expect(await readSessionTranscriptIndexStatus(database)).toBe(false);
      expect(isSessionTranscriptIndexReconcileRunning(database)).toBe(false);
      expect(await reconcileSessionTranscriptIndexes(database)).toEqual({ reconciledSessions: 0 });
      await waitForSessionTranscriptIndexReconcile(database);
    });
    await append(
      session.storage,
      session.sessionKey,
      "before-reset",
      message("fresh", "fresh content", { parentId: "base" }),
    );
    expect((await search("fresh")).hits.map((hit) => hit.messageId)).toEqual(["fresh"]);
    const expected = await session.storage.read(
      { type: "session.entry.read", input: {} },
      authority,
    );
    committed(
      await session.storage.mutate(
        {
          type: "session.lifecycle.reset",
          input: { expected, nextEntry: { ...expected!, sessionId: "after-reset" } },
        },
        authority,
      ),
    );
    expect((await search("fresh", { sessionId: "before-reset" })).hits).toHaveLength(1);
    expect((await search("fresh", { sessionId: "after-reset" })).hits).toEqual([]);
    // A current acquisition closes the previous window's handle; deletion removes every retained window.
    const current = await owners
      .at(-1)!
      .acquire({ database: owners.at(-1)!.identity, sessionKey: session.sessionKey }, lifetime);
    committed(
      await current.storage!.mutate({ type: "session.lifecycle.delete", input: {} }, authority),
    );
    expect((await search("fresh")).hits).toEqual([]);
  });
});
