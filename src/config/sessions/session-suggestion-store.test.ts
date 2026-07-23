import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { upsertSessionEntry } from "./session-accessor.js";
import {
  addSessionSuggestion,
  listSessionSuggestions,
  MAX_PENDING_SESSION_SUGGESTIONS_PER_AUTHOR,
  MAX_RETAINED_RESOLVED_SESSION_SUGGESTIONS,
  resolveSessionSuggestion,
} from "./session-suggestion-store.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("session suggestion store", () => {
  it("lazily ensures deterministic rows and resolves only pending suggestions", async () => {
    await withTempDir({ prefix: "openclaw-session-suggestions-" }, async (dir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntry(scope, { sessionId: "session-a", updatedAt: 1 });
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      database.db.exec("DROP TABLE session_suggestions;");

      expect(listSessionSuggestions(scope)).toEqual([]);
      addSessionSuggestion(scope, {
        id: "b",
        authorId: "bob",
        text: "second",
        createdAt: 3,
        expectedSessionId: "session-a",
      });
      addSessionSuggestion(scope, {
        id: "a",
        authorId: "alice",
        authorLabel: "Alice",
        text: "first",
        createdAt: 2,
        expectedSessionId: "session-a",
      });

      expect(listSessionSuggestions(scope).map((item) => item.id)).toEqual(["a", "b"]);
      expect(listSessionSuggestions(scope, { authorId: "alice" })).toHaveLength(1);
      expect(
        resolveSessionSuggestion(scope, {
          id: "a",
          state: "accepted",
          expectedSessionId: "session-a",
        })?.state,
      ).toBe("accepted");
      expect(
        resolveSessionSuggestion(scope, {
          id: "a",
          state: "dismissed",
          expectedSessionId: "session-a",
        }),
      ).toBeNull();
      expect(listSessionSuggestions(scope, { pendingOnly: true }).map((item) => item.id)).toEqual([
        "b",
      ]);
    });
  });

  it("binds writes to the session instance and clears rows on replacement", async () => {
    await withTempDir({ prefix: "openclaw-session-suggestions-reset-" }, async (dir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntry(scope, { sessionId: "session-a", updatedAt: 1 });
      addSessionSuggestion(scope, {
        id: "suggestion",
        authorId: "alice",
        text: "do this",
        expectedSessionId: "session-a",
      });
      expect(() =>
        addSessionSuggestion(scope, {
          authorId: "alice",
          text: "stale",
          expectedSessionId: "session-b",
        }),
      ).toThrow(/session changed/);

      await upsertSessionEntry(scope, { sessionId: "session-b", updatedAt: 2 });
      expect(listSessionSuggestions(scope)).toEqual([]);
    });
  });

  it("bounds pending suggestions per author", async () => {
    await withTempDir({ prefix: "openclaw-session-suggestions-limit-" }, async (dir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntry(scope, { sessionId: "session-a", updatedAt: 1 });
      for (let index = 0; index < MAX_PENDING_SESSION_SUGGESTIONS_PER_AUTHOR; index += 1) {
        addSessionSuggestion(scope, {
          id: `suggestion-${index}`,
          authorId: "alice",
          text: `idea ${index}`,
          expectedSessionId: "session-a",
        });
      }
      expect(() =>
        addSessionSuggestion(scope, {
          authorId: "alice",
          text: "one too many",
          expectedSessionId: "session-a",
        }),
      ).toThrow(/author pending suggestion limit/);

      resolveSessionSuggestion(scope, {
        id: "suggestion-0",
        state: "dismissed",
        expectedSessionId: "session-a",
      });
      expect(() =>
        addSessionSuggestion(scope, {
          authorId: "alice",
          text: "replacement",
          expectedSessionId: "session-a",
        }),
      ).not.toThrow();
    });
  });

  it("prunes old resolved suggestions on subsequent writes", async () => {
    await withTempDir({ prefix: "openclaw-session-suggestions-retention-" }, async (dir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntry(scope, { sessionId: "session-a", updatedAt: 1 });
      for (let index = 0; index <= MAX_RETAINED_RESOLVED_SESSION_SUGGESTIONS; index += 1) {
        const id = `resolved-${index}`;
        addSessionSuggestion(scope, {
          id,
          authorId: "alice",
          text: `resolved ${index}`,
          createdAt: index + 1,
          expectedSessionId: "session-a",
        });
        resolveSessionSuggestion(scope, {
          id,
          state: "dismissed",
          expectedSessionId: "session-a",
        });
      }
      addSessionSuggestion(scope, {
        id: "pending",
        authorId: "alice",
        text: "pending",
        createdAt: 10_000,
        expectedSessionId: "session-a",
      });
      const rows = listSessionSuggestions(scope);
      expect(rows.filter((row) => row.state !== "pending")).toHaveLength(
        MAX_RETAINED_RESOLVED_SESSION_SUGGESTIONS,
      );
      expect(rows.some((row) => row.id === "resolved-0")).toBe(false);
      expect(rows.at(-1)?.id).toBe("pending");
    });
  });
});
