import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { prepareQualifiedSessionEntryTarget } from "../config/sessions/session-accessor.entry.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { removeSessionMember as removeSessionMemberSync } from "../config/sessions/session-sharing-store.native.js";
import { targetDiscoveryLane } from "../config/sessions/session-transcript-worker-resources.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  SessionMutationAuthorization,
} from "./server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { prepareSessionSharingSource } from "./session-sharing-source.js";
import { roleClient, rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { withQualifiedGatewaySessionEntry } from "./session-utils-store.js";

type PolicyConfig = ReturnType<typeof rolePolicyConfig>;
const createdActor = (id: string) => ({ type: "human" as const, source: "profile" as const, id });
async function authorize(
  client: GatewayClient,
  scope: { agentId: string; sessionKey: string },
  getRuntimeConfig: () => PolicyConfig,
) {
  const result = await resolveSessionMutationAuthorizationAsync({
    client,
    method: "chat.send",
    requestParams: scope,
    context: { getRuntimeConfig } as GatewayRequestContext,
  });
  expect(result.error).toBeNull();
  expect(result.authorization).toBeDefined();
  return result.authorization!;
}
async function memberSession(client: GatewayClient, sessionKey: string, sessionId: string) {
  const scope = { agentId: "main", sessionKey };
  replaceSessionEntrySync(scope, {
    sessionId,
    updatedAt: 1,
    visibility: "read-only",
    createdActor: createdActor("another-profile"),
  });
  await addSessionMember(scope, {
    identityId: client.authenticatedUserProfile!.profileId,
    addedBy: "another-profile",
  });
  return scope;
}
function restrictView(
  cfg: PolicyConfig,
  restriction: { agents: string[] } | { sandbox: "required" },
) {
  const roles = { ...cfg.gateway!.roles! };
  roles.definitions = {
    ...roles.definitions,
    view: { ...roles.definitions.view!, ...restriction },
  };
  return { ...cfg, gateway: { ...cfg.gateway, roles } };
}

it.each([
  { phase: "before", listing: "available" },
  { phase: "after", listing: "denied" },
] as const)(
  "refuses a sharing locator retargeted $phase source preparation (listing=$listing)",
  ({ phase, listing }) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:sharing-locator";
      const original = state.statePath("original", "store.main.sqlite");
      const replacement = state.statePath("replacement", "store.main.sqlite");
      for (const storePath of [original, replacement]) {
        replaceSessionEntrySync(
          { agentId: "main", storePath, sessionKey },
          { sessionId: "identical", updatedAt: 1, visibility: "shared" },
        );
      }
      const database = openOpenClawAgentDatabase({ agentId: "main", path: original });
      const identity = readOpenClawAgentDatabaseIdentity(database);
      const alias = state.statePath("selected");
      fs.symlinkSync(state.statePath("original"), alias, "junction");
      const retarget = () => {
        fs.unlinkSync(alias);
        fs.symlinkSync(state.statePath("replacement"), alias, "junction");
      };
      const target = {
        agentId: "main",
        canonicalKey: sessionKey,
        storeKey: sessionKey,
        storePath: state.statePath("selected", "store.json"),
        readSource: {
          agentId: "main",
          path: database.path,
          databaseIdentity: identity.identity,
          databaseBirthtime: identity.birthtime,
        },
      };
      const readDirectory = fs.readdirSync;
      let listingDenied = false;
      const directoryRead =
        listing === "denied"
          ? vi.spyOn(fs, "readdirSync").mockImplementation((...args) => {
              if (String(args[0]) === alias) {
                listingDenied = true;
                throw Object.assign(new Error("Synthetic directory listing denied"), {
                  code: "EACCES",
                });
              }
              return readDirectory(...args);
            })
          : undefined;
      if (directoryRead) {
        syncBuiltinESMExports();
      }
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(() => {
        directoryRead?.mockRestore();
        if (directoryRead) {
          syncBuiltinESMExports();
        }
      });
      if (phase === "before") {
        retarget();
        // Join any unexpectedly accepted reader so the negative control cannot leak custody.
        await expect(
          prepareSessionSharingSource(target, () => {}).then((prepared) => prepared.release()),
        ).rejects.toThrow("Session sharing source changed");
        return;
      }
      const prepared = await prepareSessionSharingSource(target, () => {});
      cleanup.defer(() => prepared.release());
      expect(prepared.target?.entry.sessionId).toBe("identical");
      if (listing === "denied") {
        expect(listingDenied).toBe(true);
      }
      retarget();
      expect(() => prepared.assertCurrent()).toThrow("Session sharing source changed");
    }),
);

it.each([
  { kind: "alias", agentId: "main" },
  { kind: "global", agentId: "work" },
  { kind: "unknown", agentId: "main" },
])(
  "admits missing $agentId $kind session authority without caller-thread SQL",
  ({ kind, agentId }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      let cfg = rolePolicyConfig();
      if (kind === "global") {
        cfg = {
          ...cfg,
          agents: { ownership: "explicit", entries: { main: {}, work: {} } },
          session: { ...cfg.session, scope: "global" },
        };
      }
      const client = roleClient("write", "new-session-owner");
      const scope = {
        agentId,
        sessionKey: kind === "unknown" ? "unknown" : "global",
      };
      const route = await resolveGatewaySessionStoreTargetInWorker({
        cfg,
        key: kind === "alias" ? "agent:main:main" : scope.sessionKey,
        agentId: scope.agentId,
        projection: "list",
        exactRead: true,
        readOnly: false,
      });
      const qualified = await prepareQualifiedSessionEntryTarget({
        ...route,
        requestedKey: kind === "alias" ? route.canonicalKey : scope.sessionKey,
        storeKey: route.canonicalKey,
        readSource: route.capturedReadSource,
      });
      const effect = vi.fn();
      const host = observeHostDataSql();
      try {
        const authorization = await authorize(client, scope, () => cfg);
        await withQualifiedGatewaySessionEntry({
          cfg,
          target: qualified,
          logicalStorePath: route.storePath,
          includeMembership: true,
          assertConfigCurrent: () => {},
          consume: (latest, membership, assertSourceCurrent) => {
            expect(latest.legacyKey ?? latest.canonicalKey).toBe(route.canonicalKey);
            const prepared = {
              agentId: latest.agentId,
              storePath: latest.storePath,
              sessionKey: latest.canonicalKey,
              entry: latest.entry,
              readSource: latest.capturedReadSource,
              members: membership.get(latest.legacyKey ?? latest.canonicalKey) ?? [],
            };
            return authorization.withPreparedCurrent!(
              prepared,
              () => {
                if (kind === "global" || kind === "unknown") {
                  const wrongOwnerEffect = vi.fn();
                  expect(() =>
                    authorization.withPreparedCurrent!(
                      {
                        ...prepared,
                        sessionKey: `agent:other:${kind}`,
                        members: [],
                      },
                      wrongOwnerEffect,
                      assertSourceCurrent,
                    ),
                  ).toThrow("session changed");
                  expect(wrongOwnerEffect).not.toHaveBeenCalled();
                }
                cfg = { ...cfg, logging: { level: "debug" } };
                authorization.assertCurrent();
                authorization.assertTargetCurrent(scope);
                effect();
              },
              assertSourceCurrent,
            );
          },
        });
        await authorization.admittedInputAuthority!.withCurrent((facts, assertCurrent) => {
          expect(facts).toMatchObject({
            sessionKey: route.canonicalKey,
            entry: undefined,
            members: [],
          });
          assertCurrent();
          authorization.assertCurrent();
        });
        expect(effect).toHaveBeenCalledOnce();
        expect(host.queries).toEqual([]);
      } finally {
        host.restore();
      }
    }),
);

// Warm entry receipts answer repeat reads in memory; these cases need the worker read.
function invalidateSessionReadFacts(scope: { agentId: string; sessionKey: string }) {
  sessionChanges.invalidate({
    ...scope,
    storePath: resolveOpenClawAgentSqlitePath(scope),
    factsInvalidated: true,
  });
}

it("allows unrelated config reloads after session authority is prepared", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    let cfg = rolePolicyConfig();
    const client = roleClient("write", "reload-owner");
    const scope = { agentId: "main", sessionKey: "agent:main:reload-sharing" };
    replaceSessionEntrySync(scope, {
      sessionId: "reload-current",
      updatedAt: 1,
      createdActor: createdActor(client.authenticatedUserProfile!.profileId),
    });
    const authorization = await authorize(client, scope, () => cfg);
    using _ = { [Symbol.dispose]: () => authorization.release?.() };
    cfg = { ...cfg, logging: { level: "debug" } };
    const effect = vi.fn(() => authorization.assertCurrent());
    await authorization.withCurrent!(effect);
    expect(effect).toHaveBeenCalledOnce();
  }));

it("does not replay an authorization consumer after its own effect changes the row", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = rolePolicyConfig();
    const client = roleClient("write", "consumer-owner");
    const scope = { agentId: "main", sessionKey: "agent:main:consumer-settlement" };
    const entry = {
      sessionId: "consumer-session",
      updatedAt: 1,
      createdActor: createdActor(client.authenticatedUserProfile!.profileId),
    };
    replaceSessionEntrySync(scope, entry);
    const authorization = await authorize(client, scope, () => cfg);
    using _ = { [Symbol.dispose]: () => authorization.release?.() };
    const effect = vi.fn();
    await authorization.withCurrent!(() => {
      effect();
      replaceSessionEntrySync(scope, { ...entry, updatedAt: effect.mock.calls.length + 1 });
      authorization.assertCurrent();
    });
    expect(effect).toHaveBeenCalledOnce();
  }));

it.for([false, true])(
  "checks committed chat authority while an unrelated writer is held (revoked=%s)",
  (revoked, { signal }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = rolePolicyConfig();
      const client = roleClient("view", "contended-member");
      const scope = await memberSession(
        client,
        "agent:main:contended-sharing",
        "contended-session",
      );
      const identityId = client.authenticatedUserProfile!.profileId;
      const authorization = await authorize(client, scope, () => cfg);
      if (revoked) {
        await removeSessionMember(scope, identityId);
      }
      const entered = createDeferred();
      const release = createDeferred();
      const writer = runOpenClawAgentWriteAdmission(scope, async () => {
        entered.resolve();
        await release.promise;
      });
      const effect = vi.fn(() => "accepted");
      try {
        await withinTest(entered.promise, signal);
        const checked = authorization.withCurrent!(effect);
        if (revoked) {
          await expect(withinTest(checked, signal)).rejects.toThrow(
            "session is read-only for this connection",
          );
          expect(effect).not.toHaveBeenCalled();
        } else {
          expect(await withinTest(checked, signal)).toBe("accepted");
          expect(effect).toHaveBeenCalledOnce();
        }
      } finally {
        release.resolve();
        await writer;
        authorization.release?.();
      }
    }),
);

it.each([
  "worker-before-read",
  "reset-before-read",
  "native-before-consume",
  "owner-before-consume",
] as const)("rejects %s authority revocation before disclosure", (boundary) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = rolePolicyConfig();
    const client = roleClient("view", "worker-member");
    const scope = await memberSession(client, "agent:main:worker-sharing", "sharing-current");
    const database = openOpenClawAgentDatabase(scope);
    const host = observeHostDataSql();
    let authorization: SessionMutationAuthorization;
    try {
      authorization = await authorize(client, scope, () => cfg);
      await authorization.admittedInputAuthority!.withCurrent((facts, assertCurrent) => {
        expect(facts).toMatchObject({
          entry: { sessionId: "sharing-current" },
          members: [{ identityId: client.authenticatedUserProfile!.profileId }],
        });
        assertCurrent();
        authorization.assertCurrent();
      });
      expect(host.calls.flatMap((call) => call.mock.calls)).toEqual([]);
    } finally {
      host.restore();
    }
    const read = targetDiscoveryLane.pool.run.bind(targetDiscoveryLane.pool);
    let revoked = false;
    let inventories = 0;
    let closing: Promise<void> | undefined;
    const runExternalClose = AsyncLocalStorage.snapshot();
    const spy = vi.spyOn(targetDiscoveryLane.pool, "run").mockImplementation(async (...args) => {
      const reply = await read(...args);
      const kind =
        reply.ok && typeof reply.value === "object" && reply.value !== null && "kind" in reply.value
          ? reply.value.kind
          : undefined;
      if (kind === "session-target-inventory") {
        inventories += 1;
      }
      if (boundary.endsWith("before-consume") && !revoked && kind === "session-exact-entries") {
        revoked = true;
        if (boundary === "owner-before-consume") {
          closing = runExternalClose(closeOpenClawAgentDatabasesAsync);
        } else {
          // Raw SDK DML has no sessionChanges publication and cannot join the held writer FIFO.
          database.db
            .prepare("DELETE FROM session_members WHERE session_key = ? AND identity_id = ?")
            .run(scope.sessionKey, client.authenticatedUserProfile!.profileId);
        }
      }
      return reply;
    });
    const effect = vi.fn();
    try {
      if (boundary === "worker-before-read") {
        await removeSessionMember(scope, client.authenticatedUserProfile!.profileId);
      } else if (boundary === "reset-before-read") {
        replaceSessionEntrySync(scope, {
          sessionId: "sharing-successor",
          lifecycleRevision: "successor",
          updatedAt: 2,
          visibility: "read-only",
          createdActor: createdActor("another-profile"),
        });
      } else {
        invalidateSessionReadFacts(scope);
      }
      await expect(authorization.admittedInputAuthority!.withCurrent(effect)).rejects.toThrow();
      expect(effect).not.toHaveBeenCalled();
      expect(inventories).toBe(0);
      if (boundary.endsWith("before-consume")) {
        expect(revoked).toBe(true);
      }
    } finally {
      spy.mockRestore();
      await closing;
    }
  }),
);

it.each(["membership", "routing", "policy"] as const)(
  "rechecks %s changes within the consuming frame",
  (change) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      let cfg = rolePolicyConfig();
      const client = roleClient("view", "scoped-member");
      const scope = await memberSession(client, "agent:main:scoped-sharing", "scoped-current");
      const authorization = await authorize(client, scope, () => cfg);
      const effect = vi.fn(() => {
        authorization.assertCurrent();
        if (change === "membership") {
          removeSessionMemberSync(scope, client.authenticatedUserProfile!.profileId);
        } else if (change === "policy") {
          cfg = restrictView(cfg, { agents: [] });
        } else {
          cfg = { ...cfg, session: { store: "replacement/sessions.json" } };
        }
        expect(() => authorization.assertCurrent()).toThrow();
      });
      await authorization.withCurrent!(effect);
      expect(effect).toHaveBeenCalledOnce();
    }),
);

it.each(["role", "agent", "sandbox", "unprepared-role"] as const)(
  "rechecks prepared %s policy at the next worker admission",
  (change) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      let cfg = rolePolicyConfig();
      const client =
        change === "unprepared-role"
          ? sharingPolicyClient({
              user: ensureProfileForEmail("unprepared-member@example.test").id,
            })
          : roleClient("view", "policy-member");
      if (change === "unprepared-role") {
        setUserProfileRole(client.authenticatedUserProfile!.profileId, "view");
        expect(client.preparedSessionProfile).toBeUndefined();
      }
      const scope = await memberSession(client, "agent:main:policy-sharing", "policy-current");
      const host = observeHostDataSql();
      let authorization: SessionMutationAuthorization;
      try {
        authorization = await authorize(client, scope, () => cfg);
        await authorization.withCurrent!(() => authorization.assertCurrent());
        expect(host.queries).toEqual([]);
      } finally {
        host.restore();
      }
      if (change === "role" || change === "unprepared-role") {
        setUserProfileRole(client.authenticatedUserProfile!.profileId, "none");
      } else {
        cfg = restrictView(cfg, change === "agent" ? { agents: [] } : { sandbox: "required" });
      }
      const effect = vi.fn();
      await expect(authorization.withCurrent!(effect)).rejects.toThrow();
      expect(effect).not.toHaveBeenCalled();
      if (change === "unprepared-role") {
        expect(client.preparedSessionProfile).toBeUndefined();
      }
    }),
);
