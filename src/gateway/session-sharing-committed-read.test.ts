import { mkdirSync, symlinkSync } from "node:fs";
import { StatementSync } from "node:sqlite";
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
import type { EngineConnection } from "../infra/sql-connection.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureUserProfilesSchema } from "../state/user-profiles-schema.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { withSessionMutationCommitGuard } from "./server-methods/session-mutation-guards.js";
import type { SessionMutationAuthorization } from "./server-methods/types.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { composePlacementAuthorization } from "./worker-environments/placement-authorization.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { advancePlacementFixtureToActive } from "./worker-environments/placement-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());

async function captureAuthorization(
  stack: DisposableStack,
  params: Parameters<typeof resolveSessionMutationAuthorizationAsync>[0],
) {
  const result = await resolveSessionMutationAuthorizationAsync(params);
  stack.defer(() => result.authorization?.release?.());
  expect(result.error).toBeNull();
  expect(result.authorization).toBeDefined();
  return result.authorization!;
}

function expectCurrent(authorization: SessionMutationAuthorization, error?: string) {
  const current = expect(() => authorization.assertCurrent());
  if (error) {
    current.toThrow(error);
  } else {
    current.not.toThrow();
  }
}

async function projectedContext(cfg: ReturnType<typeof rolePolicyConfig>, resident: boolean) {
  const projection = resident ? await createSessionRowProjection({ cfg }) : undefined;
  await projection?.ensureMaterialized();
  return {
    projection,
    context: bindSessionRowProjection(
      createDirectChatContext({ getRuntimeConfig: () => cfg }),
      () => projection,
    ),
  };
}

function inWriterTransaction(connection: EngineConnection, check: () => void) {
  const db = requireNativeSqliteDatabase(connection);
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
  it("retains a worker grant through a configured directory alias", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      ensureUserProfilesSchema({});
      const profileCatalog = await prepareUserProfileCatalog();
      using _ = { [Symbol.dispose]: () => profileCatalog.release() };
      const directory = state.statePath("physical");
      const alias = state.statePath("selected");
      mkdirSync(directory);
      symlinkSync(directory, alias, "junction");
      const cfg = rolePolicyConfig();
      cfg.session = { store: `${alias}/sessions.json` };
      const sessionKey = "agent:main:aliased-worker-grant";
      const scope = { agentId: "main", sessionKey, storePath: cfg.session.store };
      replaceSessionEntrySync(scope, {
        sessionId: "aliased-worker-grant",
        updatedAt: 1,
        visibility: "shared",
      });
      const client = roleClient("view", "aliased-worker-grant");
      const identityId = client.authenticatedUserProfile!.profileId;
      addSessionMember(scope, { identityId, addedBy: "test-owner" });
      const result = await resolveSessionMutationAuthorizationAsync({
        client,
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        method: "sessions.dispatch",
        requestParams: { key: sessionKey },
      });
      expect(result.error).toBeNull();
      const grant = await result.authorization!.prepareWorkerGrant!();
      try {
        expect(() => grant.assertCurrent()).not.toThrow();
      } finally {
        await grant.release();
      }
    });
  });
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
        const { projection, context } = await projectedContext(cfg, mode === "resident");
        const captured = await captureAuthorization(authorizations, {
          client,
          context,
          method: "sessions.move",
          requestParams: { key: sessionKey },
        });
        let connected = true;
        const authorization = withSessionMutationCommitGuard(
          captured,
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
              expect(messages).not.toHaveBeenCalled();
            }
          } finally {
            preparationSql.restore();
            messages.mockRestore();
          }
          captured.release?.();
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
          captured.release?.();
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
        const { projection, context } = await projectedContext(cfg, resident);
        const capture = (
          expectedTarget?: Parameters<
            typeof resolveSessionMutationAuthorizationAsync
          >[0]["expectedTarget"],
        ) =>
          captureAuthorization(authorizations, {
            client,
            method: "chat.send",
            requestParams: { sessionKey },
            context,
            expectedTarget,
          });
        try {
          const warm = await capture();
          warm.assertCurrent();
          const queries = observeSqliteReadSql(StatementSync.prototype);
          const messages = vi.spyOn(Worker.prototype, "postMessage");
          try {
            for (let turn = 0; turn < 50; turn += 1) {
              await Promise.resolve();
              warm.assertCurrent();
            }
            expect(queries.queries).toHaveLength(0);
            expect(messages).not.toHaveBeenCalled();
            if (resident) {
              await expect(warm.withCurrent!(() => Promise.resolve())).rejects.toThrow(
                "Sharing authorization consumers must remain synchronous",
              );
            }
          } finally {
            queries.restore();
            messages.mockRestore();
          }
          const prepared = await capture({
            ...scope,
            storePath: resolveDefaultSessionStorePath("main"),
            sessionId: shared.sessionId,
          });
          prepared.assertCurrent();
          const authorization = await capture();
          await authorization.admittedInputAuthority!.withCurrent((facts) => {
            expect(facts.members).toContainEqual(
              expect.objectContaining({ identityId, addedBy: "test-owner" }),
            );
          });
          const owner = openOpenClawAgentDatabase({ agentId: "main" });
          registerOpenClawAgentDatabase({ agentId: "main", path: owner.path });
          expectCurrent(authorization);
          removeSessionMember(scope, identityId);
          await Promise.resolve();
          const effect = vi.fn();
          await expect(authorization.withCurrent!(effect)).rejects.toThrow(
            "session is shared for this connection",
          );
          expect(effect).not.toHaveBeenCalled();
          expectCurrent(authorization, "session is shared for this connection");
          addSessionMember(scope, { identityId, addedBy: "test-owner" });
          expectCurrent(authorization);
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
            expectCurrent(authorization);
            expect(unrelatedParses()).toBe(0);
            for (let index = 0; index < 4; index += 1) {
              expectCurrent(authorization);
            }
            expect(unrelatedParses()).toBe(0);
          });

          replaceSessionEntrySync(scope, { ...shared, visibility: "draft", updatedAt: 2 });
          inWriterTransaction(owner.db, () =>
            expectCurrent(authorization, "session is draft for this connection"),
          );
          replaceSessionEntrySync(scope, { ...shared, updatedAt: 3 });
          inWriterTransaction(owner.db, () => expectCurrent(authorization));
          removeSessionMember(scope, identityId);
          expectCurrent(authorization, "session is shared for this connection");
          addSessionMember(scope, { identityId, addedBy: "test-owner" });
          expectCurrent(authorization);
          replaceSessionEntrySync(scope, { ...shared, sessionId: "replacement", updatedAt: 4 });
          inWriterTransaction(owner.db, () => {
            expectCurrent(authorization, "session changed before chat.send");
            expectCurrent(prepared, "session changed before chat.send");
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
        const authorization = await captureAuthorization(authorizations, {
          client,
          method: "chat.send",
          requestParams: { sessionKey },
          context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        });
        const owner = openOpenClawAgentDatabase({ agentId: "main" });
        runOpenClawAgentWriteTransaction(
          () => {
            if (opened === "before") {
              expectCurrent(authorization);
            }
            setCanonicalSqliteSessionMainKey(owner, "work");
            owner.db
              .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
              .run("agent:main:unrecorded-parent", "agent:main:main");
            expectCurrent(authorization);
            expectCurrent(authorization);
          },
          { agentId: "main" },
        );

        // A policy change never makes this valid target depend on an invalid sibling.
        inWriterTransaction(owner.db, () => expectCurrent(authorization));
        owner.db
          .prepare("UPDATE session_nodes SET parent_session_key = NULL WHERE session_key = ?")
          .run("agent:main:main");
        inWriterTransaction(owner.db, () => expectCurrent(authorization));
      });
    },
  );
});
