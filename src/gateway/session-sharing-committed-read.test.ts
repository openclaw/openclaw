import { renameSync } from "node:fs";
import { backup, type DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { setCanonicalSqliteSessionMainKey } from "../config/sessions/session-canonical-key.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
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
  it.each([false, true])(
    "keeps committed guards current without unrelated entries (resident: %s)",
    async (resident) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const cfg = rolePolicyConfig();
        const client = roleClient("view", "committed-reader");
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
        const identityId = client.authenticatedUserProfile!.profileId;
        addSessionMember(scope, { identityId, addedBy: "test-owner" });
        const projection = resident ? await createSessionRowProjection({ cfg }) : undefined;
        await projection?.ensureMaterialized();
        const context = bindSessionRowProjection(
          createDirectChatContext({ getRuntimeConfig: () => cfg }),
          () => projection,
        );
        const capture = () =>
          resolveSessionMutationAuthorization({
            client,
            method: "chat.send",
            requestParams: { sessionKey },
            context,
          });
        try {
          const warm = capture();
          expect(warm.error).toBeNull();
          warm.authorization!.assertCurrent();
          const queries = observeSqliteReadSql(StatementSync.prototype);
          try {
            for (let turn = 0; turn < 50; turn += 1) {
              const admitted = capture();
              expect(admitted.error).toBeNull();
              expect(admitted.authorization).toBeDefined();
              await Promise.resolve();
              admitted.authorization!.assertCurrent();
            }
            if (resident) {
              expect(queries.queries).toHaveLength(0);
            } else {
              expect(queries.queries.length).toBeGreaterThan(0);
            }
          } finally {
            queries.restore();
          }
          const prepared = resolveSessionMutationAuthorization({
            client,
            method: "chat.send",
            requestParams: { sessionKey },
            context,
            expectedTarget: {
              ...scope,
              storePath: resolveDefaultSessionStorePath("main"),
              sessionId: shared.sessionId,
            },
          });
          expect(prepared.error).toBeNull();
          expect(prepared.authorization).toBeDefined();
          prepared.authorization!.assertCurrent();
          const result = capture();
          expect(result.error).toBeNull();
          const authorization = result.authorization;
          expect(authorization).toBeDefined();
          if (!authorization) {
            throw new Error("Expected session mutation authorization");
          }
          const owner = openOpenClawAgentDatabase({ agentId: "main" });
          registerOpenClawAgentDatabase({ agentId: "main", path: owner.path });
          expect(() => authorization.assertCurrent()).not.toThrow();
          removeSessionMember(scope, identityId);
          expect(() => authorization.assertCurrent()).toThrow(
            "session is shared for this connection",
          );
          addSessionMember(scope, { identityId, addedBy: "test-owner" });
          expect(() => authorization.assertCurrent()).not.toThrow();
          await projection?.ensureMaterialized();
          const parse = vi.spyOn(JSON, "parse");
          const unrelatedParses = () =>
            parse.mock.calls.filter(([value]) => value.includes("unrelated-committed-probe-"))
              .length;
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
            expect(() => authorization.assertCurrent()).toThrow(
              "session is draft for this connection",
            );
          });
          replaceSessionEntrySync(scope, { ...shared, updatedAt: 3 });
          inWriterTransaction(owner.db, () => {
            expect(() => authorization.assertCurrent()).not.toThrow();
          });
          removeSessionMember(scope, identityId);
          expect(() => authorization.assertCurrent()).toThrow(
            "session is shared for this connection",
          );
          addSessionMember(scope, { identityId, addedBy: "test-owner" });
          expect(() => authorization.assertCurrent()).not.toThrow();
          if (projection) {
            bindSessionRowProjection(context, () => undefined);
            expect(() => authorization.assertCurrent()).toThrow("session changed before chat.send");
            bindSessionRowProjection(context, () => projection);
            expect(() => authorization.assertCurrent()).not.toThrow();
            await projection.ensureMaterialized();
            const copyPath = `${owner.path}.replacement`;
            const originalPath = `${owner.path}.original`;
            await backup(owner.db, copyPath);
            renameSync(owner.path, originalPath);
            try {
              renameSync(copyPath, owner.path);
              expect(() => authorization.assertCurrent()).toThrow(
                "SQLite database file identity changed",
              );
            } finally {
              renameSync(originalPath, owner.path);
            }
          }
          replaceSessionEntrySync(scope, { ...shared, sessionId: "replacement", updatedAt: 4 });
          inWriterTransaction(owner.db, () => {
            expect(() => authorization.assertCurrent()).toThrow("session changed before chat.send");
            expect(() => prepared.authorization!.assertCurrent()).toThrow(
              "session changed before chat.send",
            );
          });
          expect(unrelatedParses()).toBe(0);
        } finally {
          projection?.dispose();
        }
      });
    },
  );

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
