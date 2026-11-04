import { mkdirSync, symlinkSync } from "node:fs";
import { StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
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
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
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

type Request = Parameters<typeof resolveSessionMutationAuthorizationAsync>[0];
async function withSharingState(
  run: (fixture: ReturnType<typeof sharingFixture>) => Promise<void>,
  foreground = false,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    ensureUserProfilesSchema({});
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    using resources = new DisposableStack();
    if (foreground) {
      resources.defer(retainSessionListForegroundWork());
    }
    using authorizations = new DisposableStack();
    using fixture = sharingFixture(state, authorizations);
    await run(fixture);
  });
}
function sharingFixture(state: OpenClawTestState, authorizations: DisposableStack) {
  const cfg = rolePolicyConfig();
  let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
  return {
    state,
    cfg,
    [Symbol.dispose]: () => projection?.dispose(),
    materialize: async (resident: boolean) => {
      projection = resident ? await createSessionRowProjection({ cfg }) : undefined;
      await projection?.ensureMaterialized();
    },
    refresh: () => projection?.ensureMaterialized(),
    seed: (sessionKey: string, sessionId: string, role: "view" | "write" = "view") => {
      const scope = { agentId: "main", sessionKey, storePath: cfg.session?.store };
      const shared = { sessionId, updatedAt: 1, visibility: "shared" as const };
      replaceSessionEntrySync(scope, shared);
      const client = roleClient(role, sessionId);
      const identityId = client.authenticatedUserProfile!.profileId;
      if (role === "view") {
        addSessionMember(scope, { identityId, addedBy: "test-owner" });
      }
      const context = bindSessionRowProjection(
        createDirectChatContext({ getRuntimeConfig: () => cfg }),
        () => projection,
      );
      return {
        scope,
        shared,
        identityId,
        capture: async (method = "chat.send", expectedTarget?: Request["expectedTarget"]) => {
          const result = await resolveSessionMutationAuthorizationAsync({
            client,
            context,
            method,
            requestParams: method === "chat.send" ? { sessionKey } : { key: sessionKey },
            expectedTarget,
          });
          authorizations.defer(() => result.authorization?.release?.());
          expect(result.error).toBeNull();
          expect(result.authorization).toBeDefined();
          return result.authorization!;
        },
      };
    },
  };
}

function expectCurrent(authorization: SessionMutationAuthorization, error?: string) {
  const current = expect(() => authorization.assertCurrent());
  if (error) {
    current.toThrow(error);
  } else {
    current.not.toThrow();
  }
}

async function withoutSql<T>(
  run: () => Promise<T>,
  observe: () => { queries: string[]; restore: () => void } = observeHostDataSql,
) {
  const sql = observe();
  using _ = { [Symbol.dispose]: sql.restore };
  const result = await run();
  expect(sql.queries).toEqual([]);
  return result;
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

it.each(["resident", "fixed", "alias"] as const)(
  "revokes %s worker grants after committed membership changes without main-thread reads",
  (mode) =>
    withSharingState(async ({ state, cfg, seed, materialize }) => {
      if (mode === "fixed") {
        cfg.session = { store: state.statePath("legacy", "sessions.json") };
      } else if (mode === "alias") {
        const directory = state.statePath("physical");
        const alias = state.statePath("selected");
        mkdirSync(directory);
        symlinkSync(directory, alias, "junction");
        cfg.session = { store: `${alias}/sessions.json` };
      }
      const sessionKey = "agent:main:worker-grant";
      const sessionId = "worker-grant-session";
      const { scope, identityId, capture } = seed(sessionKey, sessionId);
      await materialize(mode === "resident");
      const captured = await capture("sessions.move");
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
      using _ = { [Symbol.dispose]: () => captured.release?.() };
      const grant = await withoutSql(async () => {
        const messages = vi.spyOn(Worker.prototype, "postMessage");
        using resources = new DisposableStack();
        resources.defer(() => messages.mockRestore());
        const prepared = await authorization.prepareWorkerGrant!();
        if (mode === "resident") {
          expect(messages).not.toHaveBeenCalled();
        }
        return prepared;
      });
      await using grantCleanup = new AsyncDisposableStack();
      grantCleanup.defer(() => grant.release());
      captured.release?.();
      const database = openOpenClawStateDatabase();
      const placements = createWorkerSessionPlacementStore({ database });
      const {
        generation,
        environmentId,
        activeOwnerEpoch: ownerEpoch,
      } = await advancePlacementFixtureToActive(placements, database, {
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
      const operationId = await withoutSql(async () => {
        const begun = await placements.beginPlacementMove(
          {
            sessionId,
            source: { generation, environmentId, ownerEpoch },
            target: { kind: "gateway" },
          },
          { assertCurrent: authorize },
        );
        return begun.intent.operationId;
      });
      expect(() => grant!.assertCurrent()).not.toThrow();
      connected = false;
      expect(() => grant!.assertCurrent()).toThrow("Placement request connection closed");
      connected = true;
      expect(() => grant!.assertCurrent()).not.toThrow();
      removeSessionMember(scope, identityId);
      await expect(
        placements.cancelPlacementMove({ operationId, sessionId }, { assertCurrent: authorize }),
      ).rejects.toThrow();
      expect(await placements.getPlacementMoveAsync(sessionId)).toMatchObject({ operationId });
    }, true),
);

it.each([false, true])(
  "keeps committed guards current without unrelated entries (resident: %s)",
  (resident) =>
    withSharingState(async ({ seed, materialize, refresh }) => {
      const sessionKey = "agent:main:committed-authorization";
      const { scope, shared, identityId, capture } = seed(sessionKey, "original");
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
      await materialize(resident);
      const warm = await capture();
      {
        const messages = vi.spyOn(Worker.prototype, "postMessage");
        using resources = new DisposableStack();
        resources.defer(() => messages.mockRestore());
        await withoutSql(
          async () => {
            for (let turn = 0; turn < 50; turn += 1) {
              await Promise.resolve();
              warm.assertCurrent();
            }
            expect(messages).not.toHaveBeenCalled();
            if (resident) {
              await expect(warm.withCurrent!(() => Promise.resolve())).rejects.toThrow(
                "Sharing authorization consumers must remain synchronous",
              );
            }
          },
          () => observeSqliteReadSql(StatementSync.prototype),
        );
      }
      const prepared = await capture("chat.send", {
        ...scope,
        storePath: resolveDefaultSessionStorePath("main"),
        sessionId: shared.sessionId,
      });
      const authorization = await capture();
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
      await refresh();
      const parse = vi.spyOn(JSON, "parse");
      const unrelatedParses = () =>
        parse.mock.calls.filter(([value]) => value.includes("unrelated-committed-probe-")).length;
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
      });

      replaceSessionEntrySync(scope, { ...shared, visibility: "draft", updatedAt: 2 });
      inWriterTransaction(owner.db, () =>
        expectCurrent(authorization, "session is draft for this connection"),
      );
      replaceSessionEntrySync(scope, { ...shared, updatedAt: 3 });
      inWriterTransaction(owner.db, () => expectCurrent(authorization));
      replaceSessionEntrySync(scope, { ...shared, sessionId: "replacement", updatedAt: 4 });
      inWriterTransaction(owner.db, () => {
        expectCurrent(authorization, "session changed before chat.send");
        expectCurrent(prepared, "session changed before chat.send");
      });
      expect(unrelatedParses()).toBe(0);
    }),
);

it.each(["before", "after"] as const)(
  "revalidates a committed main-key change with a reader first opened %s the uncommitted setter",
  (opened) =>
    withSharingState(async ({ seed }) => {
      const sessionKey = "agent:main:committed-authorization";
      const { capture } = seed(sessionKey, "target", "write");
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:main" },
        { sessionId: "main-session", updatedAt: 1, visibility: "shared" },
      );
      const authorization = await capture();
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
        },
        { agentId: "main" },
      );

      // A policy change never makes this valid target depend on an invalid sibling.
      inWriterTransaction(owner.db, () => expectCurrent(authorization));
      owner.db
        .prepare("UPDATE session_nodes SET parent_session_key = NULL WHERE session_key = ?")
        .run("agent:main:main");
      inWriterTransaction(owner.db, () => expectCurrent(authorization));
    }),
);
