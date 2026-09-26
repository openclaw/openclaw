import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { setCanonicalSqliteSessionMainKey } from "../config/sessions/session-canonical-key.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { resolveSessionMutationAuthorization } from "./session-sharing.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

function inWriterTransaction(db: DatabaseSync, check: () => void) {
  db.exec("BEGIN IMMEDIATE");
  try {
    check();
  } finally {
    if (db.isOpen && db.isTransaction) {
      db.exec("ROLLBACK");
    }
  }
}

describe("committed session mutation authorization", () => {
  it("keeps committed guards independent of unrelated entries while observing access and session changes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = rolePolicyConfig();
      const client = roleClient("write", "committed-reader");
      const sessionKey = "agent:main:committed-authorization";
      const scope = { agentId: "main", sessionKey };
      const shared = { sessionId: "original", updatedAt: 1, visibility: "shared" as const };
      replaceSessionEntrySync(scope, shared);
      const unrelatedCount = 24;
      for (let index = 0; index < unrelatedCount; index += 1) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: `agent:main:unrelated-${index}` },
          {
            sessionId: `unrelated-committed-probe-${index}`,
            updatedAt: 1,
            skillsSnapshot: { prompt: "unrelated saved prompt".repeat(1024), skills: [] },
          },
        );
      }
      const result = resolveSessionMutationAuthorization({
        client,
        method: "chat.send",
        requestParams: { sessionKey },
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
      });
      expect(result.error).toBeNull();
      const authorization = result.authorization;
      expect(authorization).toBeDefined();
      if (!authorization) {
        throw new Error("Expected session mutation authorization");
      }
      const owner = openOpenClawAgentDatabase({ agentId: "main" });
      const parse = vi.spyOn(JSON, "parse");
      const unrelatedParses = () =>
        parse.mock.calls.filter(([value]) => value.includes("unrelated-committed-probe-")).length;
      inWriterTransaction(owner.db, () => {
        // The same writer's uncommitted edit cannot grant or revoke committed authority.
        owner.db
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run(JSON.stringify({ ...shared, visibility: "draft" }), sessionKey);
        expect(() => authorization.assertCurrent()).not.toThrow();
        expect(unrelatedParses()).toBe(0);
        for (let index = 0; index < 4; index += 1) {
          expect(() => authorization.assertCurrent()).not.toThrow();
        }
        expect(unrelatedParses()).toBe(0);
      });

      replaceSessionEntrySync(scope, { ...shared, visibility: "draft", updatedAt: 2 });
      inWriterTransaction(owner.db, () => {
        expect(() => authorization.assertCurrent()).toThrow("session is draft for this connection");
      });
      replaceSessionEntrySync(scope, { ...shared, updatedAt: 3 });
      inWriterTransaction(owner.db, () => {
        expect(() => authorization.assertCurrent()).not.toThrow();
      });
      replaceSessionEntrySync(scope, { ...shared, sessionId: "replacement", updatedAt: 4 });
      inWriterTransaction(owner.db, () => {
        expect(() => authorization.assertCurrent()).toThrow("session changed before chat.send");
      });
      expect(unrelatedParses()).toBe(0);
    });
  });

  it.each(["before", "after"] as const)(
    "revalidates a committed main-key change with a reader first opened %s the uncommitted setter",
    async (opened) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const cfg = rolePolicyConfig();
        const client = roleClient("write", "committed-main-key");
        const sessionKey = "agent:main:committed-authorization";
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          { sessionId: "target", updatedAt: 1, visibility: "shared" },
        );
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: "agent:main:main" },
          { sessionId: "main-session", updatedAt: 1, visibility: "shared" },
        );
        const result = resolveSessionMutationAuthorization({
          client,
          method: "chat.send",
          requestParams: { sessionKey },
          context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        });
        expect(result.error).toBeNull();
        const authorization = result.authorization;
        if (!authorization) {
          throw new Error("Expected session mutation authorization");
        }
        const owner = openOpenClawAgentDatabase({ agentId: "main" });
        inWriterTransaction(owner.db, () => {
          if (opened === "before") {
            expect(() => authorization.assertCurrent()).not.toThrow();
          }
          setCanonicalSqliteSessionMainKey(owner, "work");
          owner.db
            .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
            .run("agent:main:unrecorded-parent", "agent:main:main");
          expect(() => authorization.assertCurrent()).not.toThrow();
          expect(() => authorization.assertCurrent()).not.toThrow();
          owner.db.exec("COMMIT");
        });

        // A policy change never makes this valid target depend on an invalid sibling.
        inWriterTransaction(owner.db, () => {
          expect(() => authorization.assertCurrent()).not.toThrow();
        });
        owner.db
          .prepare("UPDATE session_nodes SET parent_session_key = NULL WHERE session_key = ?")
          .run("agent:main:main");
        inWriterTransaction(owner.db, () => {
          expect(() => authorization.assertCurrent()).not.toThrow();
        });
      });
    },
  );
});
