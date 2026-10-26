import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { initSessionState } from "../auto-reply/reply/session.js";
import { prepareQualifiedSessionEntryTarget } from "../config/sessions/session-accessor.entry.js";
import {
  listSessionPendingInputs,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "../config/sessions/session-accessor.pending-inputs.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { removeSessionMember as removeSessionMemberSync } from "../config/sessions/session-sharing-store.native.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { targetDiscoveryLane } from "../config/sessions/session-transcript-worker-resources.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import {
  beginSessionEffect,
  captureSessionTarget,
  runSessionMutation,
} from "../sessions/session-controller.lifecycle.js";
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
import { registerChatAbortController } from "./chat-abort.js";
import {
  assertChatSendWorkAdmissionCurrent,
  createChatSendPendingInputAdmission,
  createChatSendWorkAdmission,
} from "./server-methods/chat-send-work-admission.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
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
  sessionScope?: Parameters<typeof resolveSessionMutationAuthorizationAsync>[0]["sessionScope"],
) {
  const result = await resolveSessionMutationAuthorizationAsync({
    client,
    method: "chat.send",
    requestParams: scope,
    sessionScope,
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
                      { ...prepared, sessionKey: `agent:other:${kind}`, members: [] },
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

it("does not replay an authorization consumer after its own effect changes the row", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    let cfg = rolePolicyConfig();
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
    cfg = { ...cfg, logging: { level: "debug" } };
    const effect = vi.fn();
    await authorization.withCurrent!(() => {
      effect();
      replaceSessionEntrySync(scope, { ...entry, updatedAt: effect.mock.calls.length + 1 });
      authorization.assertCurrent();
    });
    expect(effect).toHaveBeenCalledOnce();
  }));

it.each([
  { scopeName: "operator.write", change: "none" },
  { scopeName: "operator.sessions.write", change: "none" },
  { scopeName: "operator.sessions.write", change: "revoke-at-commit" },
  { scopeName: "operator.sessions.write", change: "foreign-reset" },
  { scopeName: "operator.sessions.write", change: "replacement" },
] as const)(
  "checks $scopeName idle-rollover input at the pending-input write ($change)",
  ({ scopeName, change }) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        ...rolePolicyConfig(),
        agents: { defaults: { workspace: state.workspaceDir } },
        session: { reset: { mode: "idle" as const, idleMinutes: 1 } },
      };
      const client = roleClient("write", "idle-rollover-owner");
      client.connect.scopes = [scopeName];
      const scope = { agentId: "main", sessionKey: "agent:main:idle-rollover" };
      const entry = {
        sessionId: "idle-rollover-session",
        lifecycleRevision: "before-idle-rollover",
        updatedAt: Date.now(),
        lastInteractionAt: 1,
        createdActor: createdActor(client.authenticatedUserProfile!.profileId),
      };
      replaceSessionEntrySync(scope, entry);
      const authorization = await authorize(
        client,
        scope,
        () => cfg,
        scopeName === "operator.sessions.write" ? scopeName : undefined,
      );
      using _ = { [Symbol.dispose]: () => authorization.release?.() };
      const target = captureSessionTarget({
        ...scope,
        storeScope: resolveSessionStorePathForScope(scope, cfg),
        incarnation: entry.sessionId,
      });
      const runId = `idle-rollover-${change}`;
      const registration = registerChatAbortController({
        ...scope,
        sessionId: entry.sessionId,
        target,
        runId,
        timeoutMs: 60_000,
      });
      const sourceRef = registration.entry!;
      const effect = await beginSessionEffect({
        target,
        sourceInput: sourceRef.input,
        assertAllowed: () => authorization.assertCurrent(),
        onInterrupt: () => work.release(),
      });
      const work = createChatSendWorkAdmission({
        admission: effect,
        logGateway: { warn: vi.fn() },
      });
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const admission = createChatSendPendingInputAdmission({
        runId,
        sessionMutationAuthorization: authorization,
        assertCustodyLifetimeCurrent: () =>
          assertChatSendWorkAdmissionCurrent({
            retainedWork: work,
            admission: effect,
            lifecycleGeneration,
            controller: registration.controller,
            sourceRef,
          }),
      });
      const initialize = (body: string) =>
        initSessionState({
          cfg,
          commandAuthorized: true,
          expectedExistingSessionId: entry.sessionId,
          ctx: finalizeInboundContext({
            Body: body,
            SessionKey: scope.sessionKey,
            From: "idle-rollover-owner",
            To: "assistant",
            Provider: "webchat",
            Surface: "webchat",
            ChatType: "direct",
          }),
        });
      let receipt: SessionPendingInputReceipt | undefined;
      let commitChecks = 0;
      const commit = sqliteWorkerOwnerProbe.admission(workerAdmission, (request, grant, check) => {
        let publication = asOptionalRecord(asOptionalRecord(request.facts)?.publication);
        if (publication?.kind === "session-actor-admission") {
          publication = asOptionalRecord(publication.publication);
        }
        const staged = asOptionalRecord(publication?.receipt);
        if (
          request.stage === "commit" &&
          publication?.kind === "pending-input-settlement-custody" &&
          staged?.operation === "stage" &&
          staged.runId === runId
        ) {
          commitChecks += 1;
          if (change === "revoke-at-commit") {
            client.connect.scopes = [];
          }
        }
        check(request, grant);
      });
      try {
        const reset = await effect.run(() => initialize("Continue after the idle interval."));
        expect(reset.isNewSession).toBe(true);
        expect(reset.resetTriggered).toBe(false);
        expect(reset.sessionId).toBe(entry.sessionId);
        expect(reset.sessionEntry.lifecycleRevision).not.toBe(entry.lifecycleRevision);
        expect(effect.isActive()).toBe(true);
        expect(() => authorization.assertCurrent()).toThrow("session changed before chat.send");

        if (change === "foreign-reset") {
          const foreign = await initialize("/new");
          expect(foreign.sessionId).toBe(entry.sessionId);
          expect(foreign.sessionEntry.lifecycleRevision).not.toBe(
            reset.sessionEntry.lifecycleRevision,
          );
        } else if (change === "replacement") {
          await runSessionMutation({
            target,
            kind: "reset",
            policy: "preempt",
            preempt: { activeRun: "abort", waitingInputs: "cancel" },
            run: async () => {
              replaceSessionEntrySync(scope, { ...reset.sessionEntry, sessionId: "replacement" });
            },
          });
          expect(() => authorization.assertAdmittedInputCurrent!()).toThrow("session changed");
        }
        const pending = stageSessionPendingInput(
          { ...scope, sessionId: entry.sessionId },
          {
            ...admission,
            message: {
              role: "user",
              content: "Continue after the idle interval.",
              timestamp: 1,
              idempotencyKey: `${runId}:user`,
            },
          },
        );
        if (change === "none") {
          receipt = await pending;
          expect(receipt).toBeDefined();
          expect(commitChecks).toBe(1);
          expect(
            await listSessionPendingInputs({ ...scope, sessionId: entry.sessionId }),
          ).toMatchObject({
            total: 1,
            items: [{ runId, message: { content: "Continue after the idle interval." } }],
          });
        } else {
          await expect(pending).rejects.toThrow(
            change === "revoke-at-commit"
              ? "Session-scoped writes require your own session."
              : "Chat admission ended or was cancelled",
          );
          expect(commitChecks).toBe(change === "revoke-at-commit" ? 1 : 0);
          expect(await listSessionPendingInputs({ ...scope, sessionId: entry.sessionId })).toEqual({
            items: [],
            total: 0,
          });
        }
      } finally {
        commit.mockRestore();
        receipt?.finish("interrupted");
        await receipt?.settled?.();
        work.release();
        registration.cleanup();
        await effect.released;
        await sourceRef.input.settlement.promise;
      }
    }),
);

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
    const authorization = await authorize(client, scope, () => cfg);
    await authorization.admittedInputAuthority!.withCurrent((facts, assertCurrent) => {
      expect(facts).toMatchObject({
        entry: { sessionId: "sharing-current" },
        members: [{ identityId: client.authenticatedUserProfile!.profileId }],
      });
      assertCurrent();
      authorization.assertCurrent();
    });
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
      const authorization = await authorize(client, scope, () => cfg);
      await authorization.withCurrent!(() => authorization.assertCurrent());
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
