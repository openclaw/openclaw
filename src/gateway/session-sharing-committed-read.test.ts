import { DatabaseSync, StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { setCanonicalSqliteSessionMainKey } from "../config/sessions/session-canonical-key.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureUserProfilesSchema } from "../state/user-profiles-schema.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { withSessionMutationCommitGuard } from "./server-methods/session-mutation-guards.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { composePlacementAuthorization } from "./worker-environments/placement-authorization.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { advancePlacementFixtureToActive } from "./worker-environments/placement-test-fixtures.js";

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
  it.each(["resident", "fixed"] as const)(
    "revokes %s worker grants after committed membership changes without main-thread reads",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        ensureUserProfilesSchema({});
        const profileCatalog = await prepareUserProfileCatalog();
        const releaseForeground = retainSessionListForegroundWork();
        using _ = {
          [Symbol.dispose]() {
            releaseForeground();
            profileCatalog.release();
          },
        };
        using authorizations = new DisposableStack();
        const cfg = rolePolicyConfig();
        if (mode === "fixed") {
          cfg.session = { store: state.statePath("legacy", "sessions.json") };
        }
        const client = roleClient("view", `worker-grant-${mode}`);
        const sessionKey = "agent:main:worker-grant";
        const sessionId = "worker-grant-session";
        const scope = { agentId: "main", sessionKey, storePath: cfg.session?.store };
        replaceSessionEntrySync(scope, { sessionId, updatedAt: 1, visibility: "shared" });
        const identityId = client.authenticatedUserProfile!.profileId;
        addSessionMember(scope, { identityId, addedBy: "test-owner" });
        const projection =
          mode === "resident" ? await createSessionRowProjection({ cfg }) : undefined;
        await projection?.ensureMaterialized();
        const context = bindSessionRowProjection(
          createDirectChatContext({ getRuntimeConfig: () => cfg }),
          () => projection,
        );
        const result = await resolveSessionMutationAuthorizationAsync({
          client,
          context,
          method: "sessions.move",
          requestParams: { key: sessionKey },
        });
        authorizations.defer(() => result.authorization?.release?.());
        expect(result.error).toBeNull();
        let connected = true;
        const authorization = withSessionMutationCommitGuard(
          result.authorization,
          () => {
            if (!connected) {
              throw new Error("Placement request connection closed");
            }
          },
          undefined,
        )!;
        let grant:
          | Awaited<ReturnType<NonNullable<typeof authorization.prepareWorkerGrant>>>
          | undefined;
        try {
          const messages = vi.spyOn(Worker.prototype, "postMessage");
          const preparationSql = observeHostDataSql();
          try {
            grant = await authorization.prepareWorkerGrant!();
            expect(preparationSql.queries).toEqual([]);
            if (mode === "resident") {
              // Display backfill runs independently of the admission's worker reads.
              expect(
                messages.mock.calls.filter(
                  ([message]) => message.input?.kind !== "session-row-backfill",
                ),
              ).toEqual([]);
            }
          } finally {
            preparationSql.restore();
            messages.mockRestore();
          }
          result.authorization?.release?.();
          const database = openOpenClawStateDatabase();
          const placements = createWorkerSessionPlacementStore({ database });
          const active = await advancePlacementFixtureToActive(placements, database, {
            agentId: "main",
            sessionKey,
            sessionId,
          });
          const authorize = composePlacementAuthorization(
            Object.assign(() => authorization.assertCurrent(), {
              assertWorkerGrant: grant.assertCurrent,
              assertWorkerLifetime: grant.assertLifetimeCurrent,
            }),
            () => {},
          );
          const sql = observeHostDataSql();
          let operationId: string;
          try {
            const begun = await placements.beginPlacementMove(
              {
                sessionId,
                source: {
                  generation: active.generation,
                  environmentId: active.environmentId,
                  ownerEpoch: active.activeOwnerEpoch,
                },
                target: { kind: "gateway" },
              },
              { assertCurrent: authorize },
            );
            operationId = begun.intent.operationId;
            expect(sql.queries).toEqual([]);
          } finally {
            sql.restore();
          }
          expect(() => grant!.assertCurrent()).not.toThrow();
          connected = false;
          expect(() => grant!.assertCurrent()).toThrow("Placement request connection closed");
          connected = true;
          expect(() => grant!.assertCurrent()).not.toThrow();
          removeSessionMember(scope, identityId);
          await expect(
            placements.cancelPlacementMove(
              { operationId, sessionId },
              { assertCurrent: authorize },
            ),
          ).rejects.toThrow();
          expect(await placements.getPlacementMoveAsync(sessionId)).toMatchObject({ operationId });
        } finally {
          await grant?.release();
          result.authorization?.release?.();
          projection?.dispose();
        }
      });
    },
  );

  it.each([false, true])(
    "keeps committed guards current without unrelated entries (resident: %s)",
    async (resident) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        ensureUserProfilesSchema({});
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        using authorizations = new DisposableStack();
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
          resolveSessionMutationAuthorizationAsync({
            client,
            method: "chat.send",
            requestParams: { sessionKey },
            context,
          });
        try {
          const warm = await capture();
          authorizations.defer(() => warm.authorization?.release?.());
          expect(warm.error).toBeNull();
          warm.authorization!.assertCurrent();
          const queries = observeSqliteReadSql(StatementSync.prototype);
          const messages = vi.spyOn(Worker.prototype, "postMessage");
          try {
            for (let turn = 0; turn < 50; turn += 1) {
              await Promise.resolve();
              warm.authorization!.assertCurrent();
            }
            expect(queries.queries).toHaveLength(0);
            // Display backfill runs independently of the admission's worker reads.
            expect(
              messages.mock.calls.filter(
                ([message]) => message.input?.kind !== "session-row-backfill",
              ),
            ).toEqual([]);
            if (resident) {
              await expect(
                warm.authorization!.withCurrent!(() => Promise.resolve()),
              ).rejects.toThrow("Sharing authorization consumers must remain synchronous");
            }
          } finally {
            queries.restore();
            messages.mockRestore();
          }
          const prepared = await resolveSessionMutationAuthorizationAsync({
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
          authorizations.defer(() => prepared.authorization?.release?.());
          expect(prepared.error).toBeNull();
          expect(prepared.authorization).toBeDefined();
          prepared.authorization!.assertCurrent();
          const result = await capture();
          authorizations.defer(() => result.authorization?.release?.());
          expect(result.error).toBeNull();
          const authorization = result.authorization;
          expect(authorization).toBeDefined();
          if (!authorization) {
            throw new Error("Expected session mutation authorization");
          }
          await authorization.admittedInputAuthority!.withCurrent((facts) => {
            expect(facts.members).toContainEqual(
              expect.objectContaining({ identityId, addedBy: "test-owner" }),
            );
          });
          const owner = openOpenClawAgentDatabase({ agentId: "main" });
          registerOpenClawAgentDatabase({ agentId: "main", path: owner.path });
          expect(() => authorization.assertCurrent()).not.toThrow();
          removeSessionMember(scope, identityId);
          await Promise.resolve();
          const effect = vi.fn();
          await expect(authorization.withCurrent!(effect)).rejects.toThrow(
            "session is shared for this connection",
          );
          expect(effect).not.toHaveBeenCalled();
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
        ensureUserProfilesSchema({});
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        using authorizations = new DisposableStack();
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
        const result = await resolveSessionMutationAuthorizationAsync({
          client,
          method: "chat.send",
          requestParams: { sessionKey },
          context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        });
        authorizations.defer(() => result.authorization?.release?.());
        expect(result.error).toBeNull();
        const authorization = result.authorization;
        if (!authorization) {
          throw new Error("Expected session mutation authorization");
        }
        const owner = openOpenClawAgentDatabase({ agentId: "main" });
        runOpenClawAgentWriteTransaction(
          () => {
            if (opened === "before") {
              expect(() => authorization.assertCurrent()).not.toThrow();
            }
            setCanonicalSqliteSessionMainKey(owner, "work");
            owner.db
              .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
              .run("agent:main:unrecorded-parent", "agent:main:main");
            expect(() => authorization.assertCurrent()).not.toThrow();
            expect(() => authorization.assertCurrent()).not.toThrow();
          },
          { agentId: "main" },
        );

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
