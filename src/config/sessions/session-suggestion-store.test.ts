import { afterAll, describe, expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { SessionWorkStartInvalidatedError } from "./lifecycle.js";
import { loadSessionEntry, upsertSessionEntryCore } from "./session-accessor.js";
import {
  addSessionSuggestionInWorker as addSessionSuggestion,
  claimSessionSuggestionDispatchInWorker as claimSessionSuggestionDispatch,
  finalizeSessionSuggestionClaimInWorker as finalizeSessionSuggestionClaim,
  releaseSessionSuggestionDispatchInWorker as releaseSessionSuggestionDispatch,
} from "./session-metadata-write.async.js";
import { SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS } from "./session-suggestion-policy.js";
import { listSessionSuggestions } from "./session-suggestion-store.read.js";

const MAX_PENDING_SESSION_SUGGESTIONS_PER_AUTHOR = 20;
const MAX_RETAINED_RESOLVED_SESSION_SUGGESTIONS = 200;

async function resolvePendingSuggestion(params: {
  scope: { agentId: string; env: NodeJS.ProcessEnv; sessionKey: string };
  id: string;
  state: "accepted" | "dismissed";
  expectedSessionId: string;
}) {
  const expectedEntry = loadSessionEntry(params.scope)!;
  const claim = await claimSessionSuggestionDispatch(params.scope, {
    id: params.id,
    resolution: params.state === "accepted" ? "edit" : "dismiss",
    expectedSessionId: params.expectedSessionId,
    expectedEntry,
  });
  return claim?.kind === "claimed"
    ? await finalizeSessionSuggestionClaim(params.scope, {
        id: params.id,
        token: claim.token,
        state: params.state,
        expectedSessionId: params.expectedSessionId,
        expectedEntry,
      })
    : null;
}

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-suggestions-");

describe("session suggestion store", () => {
  it("keeps deterministic rows and resolves only pending suggestions", async () => {
    const dir = sessionDirs.make();
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
    await upsertSessionEntryCore(scope, { sessionId: "session-a", updatedAt: 1 });

    expect(await listSessionSuggestions(scope)).toEqual([]);
    await addSessionSuggestion(scope, {
      id: "b",
      authorId: "bob",
      text: "second",
      createdAt: 3,
      expectedSessionId: "session-a",
    });
    await addSessionSuggestion(scope, {
      id: "a",
      authorId: "alice",
      authorLabel: "Alice",
      text: "  first\n",
      createdAt: 2,
      expectedSessionId: "session-a",
    });

    expect((await listSessionSuggestions(scope)).map((item) => item.id)).toEqual(["a", "b"]);
    expect(
      (
        await listSessionSuggestions({
          sessionKey: "main",
          storePath: openOpenClawAgentDatabase(scope).path,
          env,
        })
      ).map((item) => item.id),
    ).toEqual(["a", "b"]);
    expect(await listSessionSuggestions(scope, { authorId: "alice" })).toEqual([
      expect.objectContaining({ text: "  first\n" }),
    ]);
    expect(
      (
        await resolvePendingSuggestion({
          scope,
          id: "a",
          state: "accepted",
          expectedSessionId: "session-a",
        })
      )?.state,
    ).toBe("accepted");
    expect(
      await resolvePendingSuggestion({
        scope,
        id: "a",
        state: "dismissed",
        expectedSessionId: "session-a",
      }),
    ).toBeNull();
    expect(
      (await listSessionSuggestions(scope, { pendingOnly: true })).map((item) => item.id),
    ).toEqual(["b"]);
  });

  it("does not recreate a missing canonical suggestions table", async () => {
    const dir = sessionDirs.make();
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
    await upsertSessionEntryCore(scope, { sessionId: "session-a", updatedAt: 1 });
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db.exec("DROP TABLE session_suggestions;");

    await expect(listSessionSuggestions(scope)).rejects.toThrow(
      "Session metadata unavailable (table-missing: session_suggestions)",
    );
    expect(
      database.db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_suggestions'",
        )
        .get(),
    ).toBeUndefined();
  });

  it("binds writes to the session instance and clears rows on replacement", async () => {
    const dir = sessionDirs.make();
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
    await upsertSessionEntryCore(scope, { sessionId: "session-a", updatedAt: 1 });
    const expectedEntry = loadSessionEntry(scope)!;
    await addSessionSuggestion(scope, {
      id: "suggestion",
      authorId: "alice",
      text: "do this",
      expectedSessionId: "session-a",
      expectedEntry,
    });
    await expect(
      addSessionSuggestion(scope, {
        authorId: "alice",
        text: "stale",
        expectedSessionId: "session-b",
      }),
    ).rejects.toThrow(/session changed/);

    await expect(
      addSessionSuggestion(scope, {
        authorId: "alice",
        text: "conflicting expected instance",
        expectedSessionId: "session-b",
        expectedEntry,
      }),
    ).rejects.toThrow(/session changed/);
    await upsertSessionEntryCore(scope, {
      sessionId: "session-a",
      visibility: "suggest",
      updatedAt: 2,
    });
    await expect(
      addSessionSuggestion(scope, {
        authorId: "alice",
        text: "stale sharing authority",
        expectedSessionId: "session-a",
        expectedEntry,
      }),
    ).rejects.toThrow(/session changed/);
    expect((await listSessionSuggestions(scope)).map((item) => item.id)).toEqual(["suggestion"]);

    await upsertSessionEntryCore(scope, { sessionId: "session-b", updatedAt: 2 });
    expect(await listSessionSuggestions(scope)).toEqual([]);
  });

  it("skips suggestion identity checks only when the expected instance is omitted", async () => {
    const dir = sessionDirs.make();
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
    await upsertSessionEntryCore(scope, { sessionId: "session-a", updatedAt: 1 });
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
      .run("{", scope.sessionKey);
    const mutations = [
      (expectedSessionId?: string) =>
        addSessionSuggestion(scope, {
          id: "suggestion",
          authorId: "author",
          text: "idea",
          expectedSessionId,
        }),
      (expectedSessionId?: string) =>
        claimSessionSuggestionDispatch(scope, {
          id: "suggestion",
          resolution: "edit",
          expectedSessionId,
        }),
      (expectedSessionId?: string) =>
        releaseSessionSuggestionDispatch(scope, {
          id: "suggestion",
          token: "other-token",
          expectedSessionId,
        }),
      (expectedSessionId?: string) =>
        finalizeSessionSuggestionClaim(scope, {
          id: "suggestion",
          token: "other-token",
          state: "accepted",
          expectedSessionId,
        }),
    ];
    for (const mutate of mutations) {
      for (const expectedSessionId of ["session-a", ""]) {
        await expect(mutate(expectedSessionId)).rejects.toThrow(SessionWorkStartInvalidatedError);
        await expect(mutate(expectedSessionId)).rejects.toThrow(
          "session changed before suggestion mutation",
        );
      }
      await expect(mutate()).resolves.toBeDefined();
    }
  });

  it("checks the session cap before the author cap and frees admission after resolution", async () => {
    const dir = sessionDirs.make();
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
    await upsertSessionEntryCore(scope, { sessionId: "session-a", updatedAt: 1 });
    for (let index = 0; index < 100; index += 1) {
      await addSessionSuggestion(scope, {
        id: `suggestion-${index}`,
        authorId: `author-${Math.floor(index / MAX_PENDING_SESSION_SUGGESTIONS_PER_AUTHOR)}`,
        text: "idea",
        expectedSessionId: "session-a",
      });
    }
    const add = (authorId: string) =>
      addSessionSuggestion(scope, { authorId, text: "next", expectedSessionId: "session-a" });
    await expect(add("author-0")).rejects.toThrow("session pending suggestion limit reached");
    await resolvePendingSuggestion({
      scope,
      id: "suggestion-20",
      state: "dismissed",
      expectedSessionId: "session-a",
    });
    await expect(add("author-0")).rejects.toThrow("author pending suggestion limit reached");
    await expect(add("author-1")).resolves.toMatchObject({ authorId: "author-1" });
    expect(await listSessionSuggestions(scope, { pendingOnly: true })).toHaveLength(100);
  });

  it("prunes old resolved suggestions on subsequent writes", async () => {
    const dir = sessionDirs.make();
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
    await upsertSessionEntryCore(scope, { sessionId: "session-a", updatedAt: 1 });
    for (let index = 0; index <= MAX_RETAINED_RESOLVED_SESSION_SUGGESTIONS; index += 1) {
      const id = index === 0 ? "z-oldest" : index === 1 ? "a-oldest" : `resolved-${index}`;
      await addSessionSuggestion(scope, {
        id,
        authorId: "alice",
        text: `resolved ${index}`,
        createdAt: index < 2 ? 1 : index + 1,
        expectedSessionId: "session-a",
      });
      await resolvePendingSuggestion({
        scope,
        id,
        state: index % 2 === 0 ? "accepted" : "dismissed",
        expectedSessionId: "session-a",
      });
    }
    const rows = await listSessionSuggestions(scope);
    expect(rows.filter((row) => row.state !== "pending")).toHaveLength(
      MAX_RETAINED_RESOLVED_SESSION_SUGGESTIONS,
    );
    expect(rows.some((row) => row.id === "a-oldest")).toBe(false);
    expect(rows.some((row) => row.id === "z-oldest")).toBe(true);
  });

  it("durably claims dispatch and permits only same-action stale recovery", async () => {
    const dir = sessionDirs.make();
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
    await upsertSessionEntryCore(scope, { sessionId: "session-a", updatedAt: 1 });
    const suggestion = await addSessionSuggestion(scope, {
      id: "claimed",
      authorId: "alice",
      text: "dispatch me",
      expectedSessionId: "session-a",
    });

    const first = await claimSessionSuggestionDispatch(scope, {
      id: "claimed",
      resolution: "send",
      expectedSessionId: "session-a",
      now: 1_000,
    });
    expect(first?.kind).toBe("claimed");
    expect(
      await claimSessionSuggestionDispatch(scope, {
        id: "claimed",
        resolution: "send",
        expectedSessionId: "session-a",
        now: 1_001,
      }),
    ).toEqual({ kind: "busy" });
    expect(
      await resolvePendingSuggestion({
        scope,
        id: "claimed",
        state: "dismissed",
        expectedSessionId: "session-a",
      }),
    ).toBeNull();

    expect(
      await claimSessionSuggestionDispatch(scope, {
        id: "claimed",
        resolution: "queue",
        expectedSessionId: "session-a",
        now: 1_000 + SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
      }),
    ).toEqual({ kind: "mismatch", resolution: "send" });
    const recovered = await claimSessionSuggestionDispatch(scope, {
      id: "claimed",
      resolution: "send",
      expectedSessionId: "session-a",
      now: 1_000 + SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
    });
    expect(recovered?.kind).toBe("claimed");
    if (recovered?.kind !== "claimed") {
      throw new Error("expected recovered claim");
    }
    expect(
      first?.kind === "claimed"
        ? await finalizeSessionSuggestionClaim(scope, {
            id: "claimed",
            token: first.token,
            state: "accepted",
            expectedSessionId: "session-a",
          })
        : null,
    ).toBeNull();
    const resolved = await finalizeSessionSuggestionClaim(scope, {
      id: "claimed",
      token: recovered.token,
      state: "accepted",
      expectedSessionId: "session-a",
    });
    expect(resolved).toEqual({ ...suggestion, state: "accepted" });
    expect(await listSessionSuggestions(scope)).toEqual([resolved]);
    expect(await listSessionSuggestions(scope, { pendingOnly: true })).toEqual([]);
  });
});
