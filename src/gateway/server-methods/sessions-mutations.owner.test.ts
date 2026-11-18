import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsPatchManyParams } from "../../../packages/gateway-protocol/src/index.js";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { createDashboardTool } from "../../agents/tools/dashboard-tool.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { callInProcessGatewayTool } from "../../agents/tools/in-process-gateway.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { readSessionMembersInWorker } from "../../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerInternalHook, unregisterInternalHook } from "../../hooks/internal-hooks.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  captureSessionTarget,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { dispatchGatewayMethodInProcess } from "../server-plugins.js";
import { isSessionPermissionChangePending } from "../session-permission-change.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import {
  createSessionListEntryFilter,
  resolveSessionSharingRole,
  resolveSessionSharingTargetAsync,
} from "../session-sharing.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import {
  createSessionMutationTestClient as client,
  createSessionMutationTestContext as context,
} from "./sessions-mutations.owner.test-support.js";
import { registerSessionSandboxMutationTests } from "./sessions-mutations.sandbox.test-support.js";
import { setupSessionMutationState } from "./sessions-mutations.state.test-support.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  RespondFn,
  SessionMutationAuthorization,
} from "./types.js";

function expectSuccess(respond: RespondFn, result: unknown) {
  expect(respond).toHaveBeenCalledWith(true, result, undefined);
}

async function mutate(
  method: string,
  params: Record<string, unknown>,
  options: Partial<GatewayRequestHandlerOptions> = {},
) {
  const respond = options.respond ?? vi.fn();
  await sessionMutationHandlers[method]!({
    req: { type: "req", id: method, method, params },
    client: options.client ?? client(),
    context: options.context ?? context({}),
    isWebchatConnect: () => true,
    params,
    ...options,
    respond,
  });
  return respond;
}

function readEntry(env: NodeJS.ProcessEnv, sessionKey: string) {
  return loadSessionEntry({ agentId: "main", env, sessionKey });
}

function seedEntry(
  env: NodeJS.ProcessEnv,
  sessionKey: string,
  entry: Parameters<typeof upsertSessionEntryCore>[1],
) {
  return upsertSessionEntryCore({ agentId: "main", env, sessionKey }, { updatedAt: 1, ...entry });
}

function handoffConfig(): OpenClawConfig {
  return { agents: { entries: { main: {}, research: { identity: { name: "Research" } } } } };
}

const mainAgent = () => ({ type: "agent", id: "main" }) as const;
const researchAgent = () => ({ type: "agent", id: "research" }) as const;
const creator = { type: "human", source: "profile", id: "profile-creator" } as const;
const viewer = { type: "human", id: "profile-viewer" } as const;
const toolCaller = { agentId: "main", sessionKey: "agent:main:discord:direct:colin" };
type MutationState = Parameters<Parameters<ReturnType<typeof setupSessionMutationState>>[0]>[0];
type CatalogSnapshot = Awaited<
  ReturnType<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>
>;

function pauseCatalog(state: MutationState, requestContext: GatewayRequestContext) {
  const snapshot: CatalogSnapshot = {
    agentId: "main",
    agentDir: state.agentDir("main"),
    workspaceDir: state.workspaceDir,
    config: requestContext.getRuntimeConfig(),
    catalogComplete: true,
    entries: [],
    routeVariants: [],
  };
  const entered = createDeferredCore();
  const release = createDeferredCore<CatalogSnapshot>();
  const load = vi.fn(async () => {
    entered.resolve();
    return release.promise;
  });
  requestContext.loadGatewayModelCatalogSnapshot = load;
  return {
    entered: entered.promise,
    load,
    release: () => release.resolve(snapshot),
  };
}

function dashboardCaller(sessionKey: string, requestContext: GatewayRequestContext) {
  return {
    agentId: "main",
    sessionKey,
    operationalRunInstance: { instanceId: "dashboard-instance", runId: "dashboard-run" },
    receiptAuthority: () => true,
    gatewayContextResolver: () => requestContext,
  };
}

function expectOwnerResponse(responses: Parameters<RespondFn>[], owner: unknown, extra = {}) {
  expect(responses).toMatchObject([[true, { owner, ...extra }, undefined]]);
}

const withSessionMutationState = setupSessionMutationState();
let caseNumber = 0;
beforeEach(() => {
  caseNumber += 1;
});

async function invoke(
  request: Record<string, unknown>,
  requestClient: GatewayClient = client("profile-viewer"),
  cfg: OpenClawConfig = handoffConfig(),
  authorizationOverride?: SessionMutationAuthorization,
) {
  const requestContext = context(cfg);
  const authorization = await resolveSessionMutationAuthorizationAsync({
    client: requestClient,
    method: "sessions.assignOwner",
    requestParams: request,
    context: requestContext,
  });
  using _ = { [Symbol.dispose]: () => authorization.authorization?.release?.() };
  const responses: Parameters<RespondFn>[] = [];
  if (!authorization.error) {
    await mutate("sessions.assignOwner", request, {
      client: requestClient,
      context: requestContext,
      sessionMutationAuthorization: authorizationOverride ?? authorization.authorization,
      respond: (...response: Parameters<RespondFn>) => responses.push(response),
    });
  }
  return { authorization, requestContext, responses };
}

registerSessionSandboxMutationTests({ client, context, withState: withSessionMutationState });

describe("sessions.patch", () => {
  it("saves and reads dashboard defaults through the agent tool without connected clients", () =>
    withSessionMutationState(async (state) => {
      const sessionKey = "agent:main:dashboard-default";
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, {
        sessionId: "dashboard-default",
        updatedAt: 1,
        boardFace: "chat",
      });
      const requestContext = context({});
      await initializeSessionReadContext(requestContext);
      requestContext.getClientConnIds = () => new Set();
      requestContext.resolveGatewayContext = () => requestContext;
      const tool = createDashboardTool({ agentSessionKey: sessionKey, agentId: "main" });
      await withGatewayToolCallerIdentity(dashboardCaller(sessionKey, requestContext), async () => {
        const initial = await tool.execute("initial", { action: "read" });
        expect(initial.details).toMatchObject({ defaultPresentation: "split" });
        expect(loadSessionEntry(scope)).not.toHaveProperty("boardPresentation");

        const saved = await tool.execute("save", {
          action: "set_default_presentation",
          presentation: "expanded",
        });
        expect(saved.details).toEqual({ ok: true, sessionKey, defaultPresentation: "expanded" });
        // Finish the saved row's publication before the durability probe closes storage.
        await flushPendingSessionsChangedEvents(requestContext);
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        expect(await closeOpenClawAgentDatabaseByPathAsync(database.path)).toBe(true);
        expect(loadSessionEntry(scope)).toMatchObject({
          boardFace: "dashboard",
          boardPresentation: "expanded",
        });
        const reopened = await tool.execute("reopened", { action: "read" });
        expect(reopened.details).toMatchObject({ defaultPresentation: "expanded" });

        await tool.execute("split", {
          action: "set_default_presentation",
          presentation: "split",
        });
        expect(loadSessionEntry(scope)?.boardPresentation).toBe("split");
        await callInProcessGatewayTool("sessions.patch", {
          key: sessionKey,
          boardPresentation: null,
        });
        const cleared = await tool.execute("cleared", { action: "read" });
        expect(cleared.details).toMatchObject({ defaultPresentation: "split" });
        expect(loadSessionEntry(scope)).not.toHaveProperty("boardPresentation");
        expect(requestContext.broadcastToConnIds).not.toHaveBeenCalledWith(
          "board.command",
          expect.anything(),
          expect.anything(),
        );
      });
    }));

  it("rechecks dashboard tool authority at the actual session commit admission", () =>
    withSessionMutationState(async (state) => {
      const sessionKey = "agent:main:dashboard-authority";
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, {
        sessionId: "dashboard-authority",
        updatedAt: 1,
        boardPresentation: "split",
      });
      const before = loadSessionEntry(scope);
      const requestContext = context({});
      let revoked = false;
      let reachedCommitAdmission = false;
      probe.admission(workerAdmission, (request, grant, admit) => {
        if (
          request.stage === "commit" &&
          isRecord(request.facts) &&
          isRecord(request.facts.publication) &&
          request.facts.publication.kind === "session-entry-replacements"
        ) {
          reachedCommitAdmission = true;
          revoked = true;
        }
        admit(request, grant);
      });
      const tool = createDashboardTool({ agentSessionKey: sessionKey, agentId: "main" });
      await expect(
        withGatewayToolCallerIdentity(
          {
            ...dashboardCaller(sessionKey, requestContext),
            receiptAuthority: () => !revoked,
          },
          () =>
            tool.execute("save", { action: "set_default_presentation", presentation: "expanded" }),
        ),
      ).rejects.toThrow(/authority.*no longer active/i);
      expect(reachedCommitAdmission).toBe(true);
      expect(loadSessionEntry(scope)).toEqual(before);
      expect(requestContext.broadcastToConnIds).not.toHaveBeenCalled();
    }));

  it("persists preference clears with an agent model rollback marker", () =>
    withSessionMutationState(async (state) => {
      const sessionKey = "agent:main:rollback-preferences";
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, {
        sessionId: "rollback-preferences",
        updatedAt: 1,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
        thinkingLevel: "high",
        contextWindow: "extended",
        modelFallback: {
          prevProvider: "openai",
          prevModel: "gpt-5.4",
          prevThinkingLevel: "high",
          prevContextWindow: "extended",
          ts: 1,
          source: "agent-patch",
        },
      });
      const respond = await mutate("sessions.patch", {
        key: sessionKey,
        thinkingLevel: null,
        contextWindow: null,
      });
      expectSuccess(respond, expect.any(Object));
      const entry = loadSessionEntry(scope);
      expect(entry?.thinkingLevel).toBeUndefined();
      expect(entry?.contextWindow).toBeUndefined();
      expect(entry?.modelFallback).toMatchObject({
        prevProvider: "openai",
        prevModel: "gpt-5.4",
        ts: 1,
        source: "agent-patch",
      });
      expect(entry?.modelFallback?.prevThinkingLevel).toBeUndefined();
      expect(entry?.modelFallback?.prevContextWindow).toBeUndefined();
    }));

  it.each([true, false])(
    "keeps live permission changes in the selected physical store (selected active=%s)",
    (selectedActive) =>
      withSessionMutationState(async (state) => {
        const sessionKey = "agent:main:physical-permission-update";
        const sessionId = "shared-permission-session";
        await seedEntry(state.env, sessionKey, { sessionId, permissionMode: "guarded" });
        const storePath = resolveSessionStorePathCore(undefined, {
          agentId: "main",
          env: state.env,
        });
        const permissionHandle = () => ({
          ...createEmbeddedRunHandle({ abort: vi.fn() }),
          applyPermissionMode: vi.fn(async () => true),
        });
        const handles = [permissionHandle(), permissionHandle()];
        const active = handles.flatMap((handle, index) => {
          if (index === 0 && !selectedActive) {
            return [];
          }
          const operation = createReplyOperation({
            sessionId,
            sessionKey,
            agentId: "main",
            resetTriggered: false,
            target: captureSessionTarget({
              storeScope: index === 0 ? storePath : `${storePath}.other`,
              sessionKey,
              agentId: "main",
              incarnation: sessionId,
            }),
          });
          attachActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, "main", operation);
          return [{ handle, operation }];
        });
        try {
          const respond = await mutate("sessions.patch", {
            key: sessionKey,
            permissionMode: "read-only",
          });
          expectSuccess(respond, expect.any(Object));
          expect(readEntry(state.env, sessionKey)?.permissionMode).toBe("read-only");
          expect(handles[0]!.applyPermissionMode).toHaveBeenCalledTimes(selectedActive ? 1 : 0);
          expect(handles[1]!.applyPermissionMode).not.toHaveBeenCalled();
          for (const handle of handles) {
            expect(handle.abort).not.toHaveBeenCalled();
          }
        } finally {
          for (const { handle, operation } of active) {
            detachActiveEmbeddedRun(sessionId, handle, sessionKey);
            operation.complete();
          }
        }
      }),
  );

  it.each([
    { kind: "failed", message: "Permissions were saved" },
    { kind: "unsupported", message: "Stop the run" },
  ] as const)(
    "preserves the correct saved mode after a $kind live permission update",
    ({ kind, message }) =>
      withSessionMutationState(async (state) => {
        const failed = kind === "failed";
        const sessionId = failed ? "failed-permission-update" : "unsupported-permissions";
        const sessionKey = `agent:main:${sessionId}`;
        await seedEntry(state.env, sessionKey, { sessionId, permissionMode: "guarded" });
        const abort = vi.fn();
        const handle = failed
          ? {
              ...createEmbeddedRunHandle({ abort }),
              applyPermissionMode: async () => {
                throw new Error("Runtime update failed");
              },
            }
          : createEmbeddedRunHandle();
        const patched = vi.fn(async () => {});
        if (failed) {
          registerInternalHook("session:patch", patched);
        }
        setActiveEmbeddedRun(sessionId, handle, sessionKey);
        try {
          const respond = await mutate("sessions.patch", {
            key: sessionKey,
            permissionMode: "read-only",
            ...(failed ? { label: "Updated session" } : {}),
          });
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ message: expect.stringContaining(message) }),
          );
          if (failed) {
            expect(abort).toHaveBeenCalledOnce();
            expect(readEntry(state.env, sessionKey)).toMatchObject({
              permissionMode: "read-only",
              label: "Updated session",
            });
            expect(patched).toHaveBeenCalledWith(
              expect.objectContaining({
                sessionKey,
                context: expect.objectContaining({
                  sessionEntry: expect.objectContaining({ permissionMode: "read-only" }),
                }),
              }),
            );
          } else {
            expect(readEntry(state.env, sessionKey)?.permissionMode).toBe("guarded");
          }
          expect(isSessionPermissionChangePending(sessionId)).toBe(false);
        } finally {
          if (failed) {
            unregisterInternalHook("session:patch", patched);
          }
          clearActiveEmbeddedRun(sessionId, handle, sessionKey);
        }
      }),
  );

  it.each([false, true])(
    "serializes permission changes through live-runtime acknowledgement (catalog preparation=%s)",
    (prepareCatalog) =>
      withSessionMutationState(async (state) => {
        const sessionKey = "agent:main:permission-update";
        const sessionId = "session-permission-update";
        const cfg: OpenClawConfig = {};
        const requestContext = context(cfg);
        const requestClient = client();
        requestClient.connect.scopes = ["operator.admin"];
        await seedEntry(state.env, sessionKey, { sessionId, permissionMode: "guarded" });
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const catalog = pauseCatalog(state, requestContext);
        const applyPermissionMode = vi.fn(async (_mode: string | null, revoke: () => void) => {
          revoke();
          entered.resolve();
          await release.promise;
          return true;
        });
        const handle = { ...createEmbeddedRunHandle(), applyPermissionMode };
        const patched = vi.fn(async () => {});
        registerInternalHook("session:patch", patched);
        setActiveEmbeddedRun(sessionId, handle, sessionKey);
        const responses = [vi.fn(), vi.fn()] as const;
        const patch = (permissionMode: "full" | "read-only", index: number) =>
          mutate(
            "sessions.patch",
            {
              key: sessionKey,
              permissionMode,
              ...(prepareCatalog && index === 0 ? { thinkingLevel: "low" } : {}),
            },
            { client: requestClient, context: requestContext, respond: responses[index]! },
          );
        const first = patch("full", 0);
        let second: ReturnType<typeof patch> | undefined;
        try {
          if (prepareCatalog) {
            await Promise.race([catalog.entered, first]);
            expect(catalog.load).toHaveBeenCalledOnce();
            expect(applyPermissionMode).not.toHaveBeenCalled();
            expect(patched).not.toHaveBeenCalled();
            expect(isSessionPermissionChangePending(sessionId)).toBe(false);
            expect(responses[0]).not.toHaveBeenCalled();
            expect(readEntry(state.env, sessionKey)?.permissionMode).toBe("guarded");
          }
          catalog.release();
          await Promise.race([entered.promise, first]);
          expect(applyPermissionMode).toHaveBeenCalledTimes(1);
          expect(responses[0]).not.toHaveBeenCalled();
          expect(isSessionPermissionChangePending(sessionId)).toBe(true);
          expect(readEntry(state.env, sessionKey)?.permissionMode).toBe("full");
          second = patch("read-only", 1);
          await Promise.resolve();
          expect(applyPermissionMode).toHaveBeenCalledTimes(1);
          release.resolve();
          await Promise.all([first, second]);
          expect(applyPermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
            "full",
            "read-only",
          ]);
          expectSuccess(responses[0], expect.any(Object));
          expectSuccess(responses[1], expect.any(Object));
          expect(patched).toHaveBeenCalledTimes(2);
          expect(catalog.load).toHaveBeenCalledTimes(prepareCatalog ? 1 : 0);
          expect(isSessionPermissionChangePending(sessionId)).toBe(false);
          expect(readEntry(state.env, sessionKey)?.permissionMode).toBe("read-only");
          if (prepareCatalog) {
            expect(readEntry(state.env, sessionKey)?.thinkingLevel).toBe("low");
          }
        } finally {
          catalog.release();
          release.resolve();
          await Promise.allSettled([first, second]);
          unregisterInternalHook("session:patch", patched);
          clearActiveEmbeddedRun(sessionId, handle, sessionKey);
        }
      }),
  );

  it.each([
    { restore: false, revokeFirst: false },
    { restore: false, revokeFirst: true },
    { restore: true, revokeFirst: true },
  ])(
    "releases provisional batch permissions while a later target prepares its catalog (restore=$restore, revoked=$revokeFirst)",
    ({ restore, revokeFirst }) =>
      withSessionMutationState(async (state) => {
        const keys = ["agent:main:batch-permission-first", "agent:main:batch-permission-second"];
        const scope = (sessionKey: string) => ({ agentId: "main", env: state.env, sessionKey });
        for (const [index, sessionKey] of keys.entries()) {
          await upsertSessionEntryCore(scope(sessionKey), {
            sessionId: sessionKey,
            updatedAt: 1,
            permissionMode: "guarded",
            ...(restore ? { archivedAt: 1 } : {}),
            ...(index === 1 ? { contextWindow: "extended" } : {}),
          });
        }
        const cfg: OpenClawConfig = {};
        const requestContext = context(cfg);
        const catalog = pauseCatalog(state, requestContext);
        const handles = keys.map(() => ({
          ...createEmbeddedRunHandle(),
          applyPermissionMode: vi.fn(async (_mode: string | null, revoke: () => void) => {
            revoke();
            return true;
          }),
        }));
        keys.forEach((key, index) => setActiveEmbeddedRun(key, handles[index]!, key));
        let revoked = false;
        const respond = vi.fn();
        // This continuation belongs to an independent lifecycle writer, outside
        // the handler's reentrant writer context.
        const lifecycleWrite = catalog.entered.then(async () => {
          await patchSessionEntryCore(scope(keys[1]!), () => ({
            startedAt: 2,
            lifecycleRunId: "batch-catalog-run",
          }));
          revoked = revokeFirst;
        });
        const params = {
          targets: keys.map((key) => ({ key, expectedSessionId: key })),
          patch: {
            model: null,
            permissionMode: "read-only",
            ...(restore ? { archived: false } : {}),
          },
        } satisfies SessionsPatchManyParams;
        const pending = mutate("sessions.patchMany", params, {
          context: requestContext,
          sessionMutationAuthorization: {
            assertCurrent: () => {},
            assertTargetCurrent: ({ sessionKey }) => {
              if (revoked && sessionKey === keys[0]) {
                throw new Error("First target authority was revoked");
              }
            },
          },
          respond,
        });
        try {
          await Promise.race([catalog.entered, pending]);
          expect(catalog.load).toHaveBeenCalledOnce();
          for (const key of keys) {
            expect(isSessionPermissionChangePending(key)).toBe(false);
            expect(loadSessionEntry(scope(key))?.permissionMode).toBe("guarded");
          }
          await lifecycleWrite;
          expect(loadSessionEntry(scope(keys[1]!))).toMatchObject({
            startedAt: 2,
            lifecycleRunId: "batch-catalog-run",
          });
          catalog.release();
          await pending;
          expectSuccess(respond, {
            outcomes: [
              revokeFirst
                ? { key: keys[0], ok: false, error: expect.any(Object) }
                : { key: keys[0], ok: true },
              { key: keys[1], ok: true },
            ],
          });
          for (const [index, key] of keys.entries()) {
            const applied = index === 1 || !revokeFirst;
            expect(loadSessionEntry(scope(key))?.permissionMode).toBe(
              applied ? "read-only" : "guarded",
            );
            expect(handles[index]!.applyPermissionMode).toHaveBeenCalledTimes(applied ? 1 : 0);
            expect(isSessionPermissionChangePending(key)).toBe(false);
          }
          if (restore) {
            expect(loadSessionEntry(scope(keys[0]!))?.archivedAt).toBe(1);
            expect(loadSessionEntry(scope(keys[1]!))?.archivedAt).toBeUndefined();
          }
          expect(loadSessionEntry(scope(keys[1]!))).toMatchObject({
            startedAt: 2,
            lifecycleRunId: "batch-catalog-run",
          });
        } finally {
          catalog.release();
          await Promise.allSettled([pending, lifecycleWrite]);
          keys.forEach((key, index) => clearActiveEmbeddedRun(key, handles[index]!, key));
        }
      }),
  );

  it("keeps a newly created session visible to its identified non-admin creator", () =>
    withSessionMutationState(async (state) => {
      const profileId = ensureProfileForEmail(`patch-creator-${caseNumber}@example.test`).id;
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const sessionKey = "agent:main:patch-created";
      const requestClient = client(profileId);
      const member = {
        sessions: { others: "none" as const },
        agents: "*" as const,
        scopes: ["operator.write" as const],
      };
      const cfg: OpenClawConfig = {
        gateway: { roles: { default: "member", definitions: { member } } },
      };
      const requestContext = context(cfg);
      const patch = async (pinned: boolean) => {
        const request = { key: sessionKey, pinned };
        const resolved = await resolveSessionMutationAuthorizationAsync({
          client: requestClient,
          method: "sessions.patch",
          requestParams: request,
          context: requestContext,
        });
        using authorization = Object.assign(resolved, {
          [Symbol.dispose]: () => resolved.authorization?.release?.(),
        });
        expect(authorization.error).toBeNull();
        const respond = await mutate("sessions.patch", request, {
          client: requestClient,
          context: requestContext,
          sessionMutationAuthorization: authorization.authorization,
        });
        expectSuccess(respond, expect.any(Object));
      };

      await patch(true);
      const entry = readEntry(state.env, sessionKey);
      expect(entry).toMatchObject({
        createdVia: "operator",
        createdActor: { type: "human", source: "profile", id: profileId },
        createdAt: expect.any(Number),
      });
      if (!entry) {
        throw new Error("expected patch-created session entry");
      }
      expect(
        createSessionListEntryFilter({ client: requestClient, cfg })?.(sessionKey, entry),
      ).toBe(true);

      await patch(false);
      expect(readEntry(state.env, sessionKey)?.pinnedAt).toBeUndefined();
    }));
});

describe("sessions.assignOwner", () => {
  it.each([false, true])(
    "serializes assignment and checks queued requester authority (revoked=%s)",
    (revokeRequester) =>
      withSessionMutationState(async (state) => {
        const handoff = revokeRequester ? "revoked-handoff" : "lifecycle-handoff";
        const sessionKey = `agent:main:${handoff}`;
        const sessionId = `session-${handoff}`;
        await seedEntry(state.env, sessionKey, {
          sessionId,
          visibility: "shared",
          createdActor: creator,
        });
        const cfg = {
          agents: { ownership: "explicit", entries: { main: {}, research: {} } },
        } as OpenClawConfig;
        const target = await resolveSessionSharingTargetAsync({ cfg, sessionKey, agentId: "main" });
        if (!target) {
          throw new Error("expected lifecycle assignment target");
        }
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const lifecycle = runSessionMutation({
          scope: target.storePath,
          identities: [target.storeKey, sessionId],
          run: async () => {
            entered.resolve();
            await release.promise;
          },
        });
        await entered.promise;
        let requesterCurrent = true;
        const assignment = invoke(
          { key: sessionKey, owner: researchAgent() },
          client("profile-viewer"),
          cfg,
          revokeRequester
            ? {
                assertCurrent: () => {
                  if (!requesterCurrent) {
                    throw new Error("assignment requester authority ended");
                  }
                },
                assertTargetCurrent: () => {},
              }
            : undefined,
        );
        try {
          await expect(
            Promise.race([
              assignment.then(() => "settled" as const),
              new Promise<"blocked">((resolve) => {
                setImmediate(() => resolve("blocked"));
              }),
            ]),
          ).resolves.toBe("blocked");
          expect(readEntry(state.env, sessionKey)?.owner).toBeUndefined();
          if (revokeRequester) {
            requesterCurrent = false;
          }
        } finally {
          release.resolve();
          await lifecycle;
        }
        if (revokeRequester) {
          await expect(assignment).rejects.toThrow("assignment requester authority ended");
          expect(readEntry(state.env, sessionKey)?.owner).toBeUndefined();
        } else {
          await expect(assignment).resolves.toMatchObject({
            responses: [[true, { owner: { actor: researchAgent() } }, undefined]],
          });
        }
      }),
  );

  it("assigns an agent-created session to a human without changing its provenance", () =>
    withSessionMutationState(async (state) => {
      const sessionKey = "agent:main:handoff";
      const ownerProfile = ensureProfileForEmail("requester@example.test");
      const nextOwner = () => ({ type: "human", id: ownerProfile.id }) as const;
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog({ env: state.env })).release };
      await seedEntry(state.env, sessionKey, {
        sessionId: "session-handoff",
        visibility: "shared",
        createdVia: "spawn",
        createdActor: mainAgent(),
        createdAt: 1,
        parentSessionKey: "agent:main:main",
      });
      const cfg = handoffConfig();
      const requestContext = context(cfg);
      await expect(
        dispatchGatewayMethodInProcess(
          "sessions.assignOwner",
          { key: sessionKey, owner: nextOwner() },
          {
            forceSyntheticClient: true,
            agentToolCaller: toolCaller,
            syntheticScopes: ["operator.write"],
            resolveGatewayContext: () => requestContext,
          },
        ),
      ).resolves.toMatchObject({
        ok: true,
        key: sessionKey,
        owner: { actor: nextOwner(), assignedBy: mainAgent() },
      });

      expect(readEntry(state.env, sessionKey)).toMatchObject({
        owner: { actor: nextOwner(), assignedBy: mainAgent() },
        createdVia: "spawn",
        createdActor: mainAgent(),
        createdAt: 1,
        parentSessionKey: "agent:main:main",
        visibility: "shared",
      });
    }));

  it.each(["shared", "read-only", "suggest"] as const)(
    "lets a write-scoped viewer assign a %s session without changing sharing authority",
    (visibility) =>
      withSessionMutationState(async (state) => {
        const sessionKey = "agent:main:handoff";
        await seedEntry(state.env, sessionKey, {
          sessionId: "session-handoff",
          visibility,
          createdActor: creator,
        });
        const cfg = handoffConfig();
        vi.spyOn(Date, "now").mockReturnValue(4242);

        const result = await invoke({ key: sessionKey, owner: researchAgent() });

        expect(result.authorization.error).toBeNull();
        const assignedOwner = {
          actor: researchAgent(),
          assignedBy: viewer,
          assignedAt: 4242,
        };
        expectOwnerResponse(
          result.responses,
          {
            ...assignedOwner,
            actor: { ...researchAgent(), label: "Research" },
          },
          { ok: true, key: sessionKey },
        );
        expect(readEntry(state.env, sessionKey)?.owner).toEqual(assignedOwner);
        const durableOwner = ensureProfileForEmail(`next-owner-${caseNumber}@example.test`);
        using _ = {
          [Symbol.dispose]: (await prepareUserProfileCatalog({ env: state.env })).release,
        };
        const nextOwner = () => ({ type: "human", id: durableOwner.id }) as const;
        const reassigned = await invoke({ key: sessionKey, owner: nextOwner() });
        expectOwnerResponse(reassigned.responses, { actor: nextOwner(), assignedBy: viewer });
        expect(readEntry(state.env, sessionKey)?.owner?.actor).toEqual(nextOwner());

        const target = await resolveSessionSharingTargetAsync({ cfg, sessionKey, agentId: "main" });
        if (!target) {
          throw new Error("expected assigned session target");
        }
        expect(resolveSessionSharingRole({ client: client("profile-creator"), target })).toBe(
          "owner",
        );
        const { members } = await readSessionMembersInWorker({
          agentId: "main",
          env: state.env,
          sessionKey,
        });
        const isMember = members.some((member) => member.identityId === "research");
        expect(resolveSessionSharingRole({ client: client("research"), target, isMember })).toBe(
          "viewer",
        );
      }),
  );

  it("rejects hidden viewers, unidentified callers, and unknown owner targets", () =>
    withSessionMutationState(async (state) => {
      const sessionKey = "agent:main:private-handoff";
      const entry = {
        sessionId: "session-private-handoff",
        createdActor: creator,
      };
      await seedEntry(state.env, sessionKey, { ...entry, visibility: "draft" });
      const cfg: OpenClawConfig = { agents: { entries: { main: {}, research: {} } } };
      const request = { key: sessionKey, owner: researchAgent() };
      const humanRequest = { ...request, owner: { type: "human", id: "profile-next" } };
      const reject = async (
        requestClient: GatewayClient,
        params: Record<string, unknown>,
        message: unknown = "sessions.assignOwner requires an identified caller",
        code = "FORBIDDEN",
      ) => {
        const result = await invoke(params, requestClient, cfg);
        expect(result.responses[0]?.[2]).toMatchObject({ code, message });
      };
      await reject(client("profile-viewer"), request, "session is not visible to this connection");
      await reject(client(), humanRequest);
      await reject({ ...client(), internal: { agentToolCaller: toolCaller } }, request);
      await reject(
        client(),
        { ...humanRequest, agentToolCaller: toolCaller },
        expect.stringContaining("unexpected property 'agentToolCaller'"),
        "INVALID_REQUEST",
      );
      await seedEntry(state.env, sessionKey, { ...entry, updatedAt: 2, visibility: "shared" });
      for (const owner of [
        { type: "human" as const, id: "unknown-profile" },
        { type: "human" as const, id: "discord:channel:123" },
        { type: "agent" as const, id: "missing" },
      ]) {
        await reject(
          client("profile-viewer"),
          { key: sessionKey, owner },
          expect.stringContaining(`unknown session owner "${owner.id}"`),
          "INVALID_REQUEST",
        );
      }
      expect(readEntry(state.env, sessionKey)?.owner).toBeUndefined();
    }));
});
