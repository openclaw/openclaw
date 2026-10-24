import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { loadSessionEntry, upsertSessionEntryCore } from "./session-accessor.js";
import {
  addSessionSuggestionInWorker as addSessionSuggestion,
  claimSessionSuggestionDispatchInWorker as claimSessionSuggestionDispatch,
  finalizeSessionSuggestionClaimInWorker as finalizeSessionSuggestionClaim,
  releaseSessionSuggestionDispatchInWorker as releaseSessionSuggestionDispatch,
} from "./session-metadata-write.async.js";
import { SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS } from "./session-suggestion-policy.js";
import { listSessionSuggestions } from "./session-suggestion-store.read.js";
import { SESSION_WORK_START_INVALIDATED_ERROR_CODE } from "./work-start-error.js";

const MAX_PENDING_SESSION_SUGGESTIONS_PER_AUTHOR = 20;
const MAX_RETAINED_RESOLVED_SESSION_SUGGESTIONS = 200;

type Scope = Awaited<ReturnType<typeof createSession>>;
async function resolvePendingSuggestion(scope: Scope, id: string, state: "accepted" | "dismissed") {
  const expectedEntry = loadSessionEntry(scope)!;
  const identity = { id, expectedSessionId: "session-a", expectedEntry };
  const claim = await claimSessionSuggestionDispatch(scope, {
    ...identity,
    resolution: state === "accepted" ? "edit" : "dismiss",
  });
  return claim?.kind === "claimed"
    ? await finalizeSessionSuggestionClaim(scope, {
        ...identity,
        token: claim.token,
        state,
      })
    : null;
}

afterAll(clearRuntimeConfigSnapshot);
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-suggestions-");

async function createSession() {
  const env = { ...process.env, OPENCLAW_STATE_DIR: sessionDirs.make() };
  const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
  await upsertSessionEntryCore(scope, { sessionId: "session-a", updatedAt: 1 });
  return scope;
}

type SuggestionInput = Parameters<typeof addSessionSuggestion>[1];
function add(
  scope: Scope,
  params: Omit<SuggestionInput, "authorId" | "text"> &
    Partial<Pick<SuggestionInput, "authorId" | "text">>,
) {
  return addSessionSuggestion(scope, {
    authorId: "alice",
    text: "idea",
    expectedSessionId: "session-a",
    ...params,
  });
}

beforeEach(() => {
  setRuntimeConfigSnapshot({});
});

describe("session suggestion store", () => {
  it("keeps deterministic rows and resolves only pending suggestions", async () => {
    const scope = await createSession();

    expect(await listSessionSuggestions(scope)).toEqual([]);
    await add(scope, { id: "b", authorId: "bob", text: "second", createdAt: 3 });
    await add(scope, {
      id: "a",
      authorLabel: "Alice",
      text: "  first\n",
      createdAt: 2,
    });

    expect((await listSessionSuggestions(scope)).map((item) => item.id)).toEqual(["a", "b"]);
    expect(
      (
        await listSessionSuggestions({
          sessionKey: "main",
          storePath: openOpenClawAgentDatabase(scope).path,
          env: scope.env,
        })
      ).map((item) => item.id),
    ).toEqual(["a", "b"]);
    expect(await listSessionSuggestions(scope, { authorId: "alice" })).toEqual([
      expect.objectContaining({ text: "  first\n" }),
    ]);
    expect((await resolvePendingSuggestion(scope, "a", "accepted"))?.state).toBe("accepted");
    expect(await resolvePendingSuggestion(scope, "a", "dismissed")).toBeNull();
    expect(
      (await listSessionSuggestions(scope, { pendingOnly: true })).map((item) => item.id),
    ).toEqual(["b"]);
  });

  it("does not recreate a missing canonical suggestions table", async () => {
    // Keep deliberate schema damage isolated from automatic maintenance admission.
    setRuntimeConfigSnapshot({ session: { maintenance: { mode: "warn" } } });
    const scope = await createSession();
    const database = openOpenClawAgentDatabase(scope);
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
    const scope = await createSession();
    const expectedEntry = loadSessionEntry(scope)!;
    await add(scope, { id: "suggestion", text: "do this", expectedEntry });
    await expect(add(scope, { text: "stale", expectedSessionId: "session-b" })).rejects.toThrow(
      /session changed/,
    );

    await expect(
      add(scope, {
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
    await expect(add(scope, { text: "stale sharing authority", expectedEntry })).rejects.toThrow(
      /session changed/,
    );
    expect((await listSessionSuggestions(scope)).map((item) => item.id)).toEqual(["suggestion"]);

    await upsertSessionEntryCore(scope, { sessionId: "session-b", updatedAt: 2 });
    expect(await listSessionSuggestions(scope)).toEqual([]);
  });

  it("skips suggestion identity checks only when the expected instance is omitted", async () => {
    const scope = await createSession();
    const database = openOpenClawAgentDatabase(scope);
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
        await expect(mutate(expectedSessionId)).rejects.toMatchObject({
          name: "SessionWorkStartInvalidatedError",
          code: SESSION_WORK_START_INVALIDATED_ERROR_CODE,
          message: "session changed before suggestion mutation",
        });
      }
      await expect(mutate()).resolves.toBeDefined();
    }
  });

  it("checks the session cap before the author cap and frees admission after resolution", async () => {
    const scope = await createSession();
    for (let index = 0; index < 100; index += 1) {
      await add(scope, {
        id: `suggestion-${index}`,
        authorId: `author-${Math.floor(index / MAX_PENDING_SESSION_SUGGESTIONS_PER_AUTHOR)}`,
      });
    }
    const addNext = (authorId: string) => add(scope, { authorId, text: "next" });
    await expect(addNext("author-0")).rejects.toThrow("session pending suggestion limit reached");
    await resolvePendingSuggestion(scope, "suggestion-20", "dismissed");
    await expect(addNext("author-0")).rejects.toThrow("author pending suggestion limit reached");
    await expect(addNext("author-1")).resolves.toMatchObject({ authorId: "author-1" });
    expect(await listSessionSuggestions(scope, { pendingOnly: true })).toHaveLength(100);
  });

  it("prunes old resolved suggestions on subsequent writes", async () => {
    const scope = await createSession();
    for (let index = 0; index <= MAX_RETAINED_RESOLVED_SESSION_SUGGESTIONS; index += 1) {
      const id = index === 0 ? "z-oldest" : index === 1 ? "a-oldest" : `resolved-${index}`;
      await add(scope, {
        id,
        text: `resolved ${index}`,
        createdAt: index < 2 ? 1 : index + 1,
      });
      await resolvePendingSuggestion(scope, id, index % 2 === 0 ? "accepted" : "dismissed");
    }
    const rows = await listSessionSuggestions(scope);
    expect(rows.filter((row) => row.state !== "pending")).toHaveLength(
      MAX_RETAINED_RESOLVED_SESSION_SUGGESTIONS,
    );
    expect(rows.some((row) => row.id === "a-oldest")).toBe(false);
    expect(rows.some((row) => row.id === "z-oldest")).toBe(true);
  });

  it("durably claims dispatch and permits only same-action stale recovery", async () => {
    const scope = await createSession();
    const suggestion = await add(scope, { id: "claimed", text: "dispatch me" });
    const claim = (resolution: "send" | "queue", now: number) =>
      claimSessionSuggestionDispatch(scope, {
        id: "claimed",
        resolution,
        expectedSessionId: "session-a",
        now,
      });
    const finalize = (token: string) =>
      finalizeSessionSuggestionClaim(scope, {
        id: "claimed",
        token,
        state: "accepted",
        expectedSessionId: "session-a",
      });
    const staleAt = 1_000 + SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS;
    const first = await claim("send", 1_000);
    expect(first?.kind).toBe("claimed");
    expect(await claim("send", 1_001)).toEqual({ kind: "busy" });
    expect(await resolvePendingSuggestion(scope, "claimed", "dismissed")).toBeNull();

    expect(await claim("queue", staleAt)).toEqual({ kind: "mismatch", resolution: "send" });
    const recovered = await claim("send", staleAt);
    expect(recovered?.kind).toBe("claimed");
    if (recovered?.kind !== "claimed") {
      throw new Error("expected recovered claim");
    }
    expect(first?.kind === "claimed" ? await finalize(first.token) : null).toBeNull();
    const resolved = await finalize(recovered.token);
    expect(resolved).toEqual({ ...suggestion, state: "accepted" });
    expect(await listSessionSuggestions(scope)).toEqual([resolved]);
    expect(await listSessionSuggestions(scope, { pendingOnly: true })).toEqual([]);
  });
});
