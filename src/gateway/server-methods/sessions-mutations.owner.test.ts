import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsPatchManyParams } from "../../../packages/gateway-protocol/src/index.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { createDashboardTool } from "../../agents/tools/dashboard-tool.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { callInProcessGatewayTool } from "../../agents/tools/in-process-gateway.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerInternalHook, unregisterInternalHook } from "../../hooks/internal-hooks.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { dispatchGatewayMethodInProcess } from "../server-plugins.js";
import { isSessionPermissionChangePending } from "../session-permission-change.js";
import {
  createSessionListEntryFilter,
  resolveSessionMutationAuthorization,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
} from "../session-sharing.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import { registerSessionSandboxMutationTests } from "./sessions-mutations.sandbox.test-support.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  RespondFn,
} from "./types.js";

afterEach(async () => {
  await flushPendingSessionsChangedEvents();
  closeOpenClawAgentDatabasesForTest();
  vi.restoreAllMocks();
});

function client(profileId?: string): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.write"],
    },
    ...(profileId
      ? {
          authenticatedUserId: `${profileId}@example.com`,
          authenticatedUserProfile: {
            profileId,
            displayName: profileId,
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  };
}

function context(cfg: OpenClawConfig) {
  return {
    trackExecution: trackAsyncWork,
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set(["observer"]),
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
  } as unknown as GatewayRequestContext;
}

async function invoke(params: {
  cfg: OpenClawConfig;
  client: GatewayClient;
  request: Record<string, unknown>;
}) {
  const requestContext = context(params.cfg);
  const authorization = resolveSessionMutationAuthorization({
    client: params.client,
    method: "sessions.assignOwner",
    requestParams: params.request,
    context: requestContext,
  });
  const responses: Parameters<RespondFn>[] = [];
  if (!authorization.error) {
    await sessionMutationHandlers["sessions.assignOwner"]?.({
      params: params.request,
      client: params.client,
      context: requestContext,
      sessionMutationAuthorization: authorization.authorization,
      respond: (...response: Parameters<RespondFn>) => responses.push(response),
    } as never);
  }
  return { authorization, requestContext, responses };
}

registerSessionSandboxMutationTests({ client, context });

describe("sessions.patch", () => {
  it("saves and reads dashboard defaults through the agent tool without connected clients", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey,
          operationalRunInstance: { instanceId: "dashboard-instance", runId: "dashboard-run" },
          receiptAuthority: () => true,
          gatewayContextResolver: () => requestContext,
        },
        async () => {
          const initial = await tool.execute("initial", { action: "read" });
          expect(initial.details).toMatchObject({ defaultPresentation: "split" });
          expect(loadSessionEntry(scope)).not.toHaveProperty("boardPresentation");

          const saved = await tool.execute("save", {
            action: "set_default_presentation",
            presentation: "expanded",
          });
          expect(saved.details).toEqual({ ok: true, sessionKey, defaultPresentation: "expanded" });
          const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
          expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
          expect(loadSessionEntry(scope)).toMatchObject({
            boardFace: "chat",
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
        },
      );
    });
  });

  it("rechecks dashboard tool authority inside the actual session write transaction", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:dashboard-authority";
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, {
        sessionId: "dashboard-authority",
        updatedAt: 1,
        boardPresentation: "split",
      });
      const before = loadSessionEntry(scope);
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const requestContext = context({});
      let revoked = false;
      let rejectedInsideTransaction = false;
      const tool = createDashboardTool({ agentSessionKey: sessionKey, agentId: "main" });
      await expect(
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey,
            operationalRunInstance: { instanceId: "dashboard-instance", runId: "dashboard-run" },
            gatewayContextResolver: () => requestContext,
            receiptAuthority: () => {
              if (database.db.isTransaction) {
                rejectedInsideTransaction = true;
                revoked = true;
              }
              return !revoked;
            },
          },
          () =>
            tool.execute("save", { action: "set_default_presentation", presentation: "expanded" }),
        ),
      ).rejects.toThrow(/authority.*no longer active/i);
      expect(rejectedInsideTransaction).toBe(true);
      expect(loadSessionEntry(scope)).toEqual(before);
      expect(requestContext.broadcastToConnIds).not.toHaveBeenCalled();
    });
  });

  it.each(["thinking", "context", "both"] as const)(
    "persists %s preference clears with an agent model rollback marker",
    async (field) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
        const respond = vi.fn();
        await sessionMutationHandlers["sessions.patch"]!({
          params: {
            key: sessionKey,
            ...(field !== "context" ? { thinkingLevel: null } : {}),
            ...(field !== "thinking" ? { contextWindow: null } : {}),
          },
          client: client(),
          context: context({}),
          respond,
        } as never);
        expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
        const entry = loadSessionEntry(scope);
        expect(entry?.thinkingLevel).toBe(field === "context" ? "high" : undefined);
        expect(entry?.contextWindow).toBe(field === "thinking" ? "extended" : undefined);
        expect(entry?.modelFallback).toMatchObject({
          prevProvider: "openai",
          prevModel: "gpt-5.4",
          ts: 1,
          source: "agent-patch",
        });
        expect(entry?.modelFallback?.prevThinkingLevel).toBe(
          field === "context" ? "high" : undefined,
        );
        expect(entry?.modelFallback?.prevContextWindow).toBe(
          field === "thinking" ? "extended" : undefined,
        );
      });
    },
  );

  it("publishes saved settings when applying permissions to the active run fails", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:failed-permission-update";
      const sessionId = "failed-permission-update";
      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        { sessionId, updatedAt: 1, permissionMode: "guarded" },
      );
      const abort = vi.fn();
      const handle = {
        ...createEmbeddedRunHandle({ abort }),
        applyPermissionMode: async () => {
          throw new Error("Runtime update failed");
        },
      };
      const patched = vi.fn(async () => {});
      registerInternalHook("session:patch", patched);
      setActiveEmbeddedRun(sessionId, handle, sessionKey);
      const respond = vi.fn();
      try {
        await sessionMutationHandlers["sessions.patch"]!({
          params: { key: sessionKey, permissionMode: "read-only", label: "Updated session" },
          client: client(),
          context: context({}),
          respond,
        } as never);
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ message: expect.stringContaining("Permissions were saved") }),
        );
        expect(abort).toHaveBeenCalledOnce();
        expect(loadSessionEntry({ agentId: "main", env: state.env, sessionKey })).toMatchObject({
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
        expect(isSessionPermissionChangePending(sessionId)).toBe(false);
      } finally {
        unregisterInternalHook("session:patch", patched);
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      }
    });
  });

  it.each([false, true])(
    "serializes permission changes through live-runtime acknowledgement (catalog preparation=%s)",
    async (prepareCatalog) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const sessionKey = "agent:main:permission-update";
        const sessionId = "session-permission-update";
        const cfg: OpenClawConfig = {};
        const requestContext = context(cfg);
        const requestClient = client();
        requestClient.connect.scopes = ["operator.admin"];
        await upsertSessionEntryCore(
          { agentId: "main", env: state.env, sessionKey },
          { sessionId, updatedAt: 1, permissionMode: "guarded" },
        );
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const catalogEntered = createDeferredCore();
        type CatalogSnapshot = Awaited<
          ReturnType<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>
        >;
        const catalogRelease = createDeferredCore<CatalogSnapshot>();
        const snapshot: CatalogSnapshot = {
          agentId: "main",
          agentDir: state.agentDir("main"),
          workspaceDir: state.workspaceDir,
          config: cfg,
          catalogComplete: true,
          entries: [],
          routeVariants: [],
        };
        const loadGatewayModelCatalogSnapshot = vi.fn<
          GatewayRequestContext["loadGatewayModelCatalogSnapshot"]
        >(async () => {
          catalogEntered.resolve();
          return catalogRelease.promise;
        });
        requestContext.loadGatewayModelCatalogSnapshot = loadGatewayModelCatalogSnapshot;
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
        const responses = [vi.fn(), vi.fn()];
        const patch = (permissionMode: "full" | "read-only", index: number) =>
          sessionMutationHandlers["sessions.patch"]!({
            params: {
              key: sessionKey,
              permissionMode,
              ...(prepareCatalog && index === 0 ? { thinkingLevel: "low" } : {}),
            },
            client: requestClient,
            context: requestContext,
            respond: responses[index]!,
          } as never);
        const first = patch("full", 0);
        let second: ReturnType<typeof patch> | undefined;
        try {
          if (prepareCatalog) {
            await Promise.race([catalogEntered.promise, first]);
            expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledOnce();
            expect(applyPermissionMode).not.toHaveBeenCalled();
            expect(patched).not.toHaveBeenCalled();
            expect(isSessionPermissionChangePending(sessionId)).toBe(false);
            expect(responses[0]).not.toHaveBeenCalled();
            expect(
              loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.permissionMode,
            ).toBe("guarded");
          }
          catalogRelease.resolve(snapshot);
          await Promise.race([entered.promise, first]);
          expect(applyPermissionMode).toHaveBeenCalledTimes(1);
          expect(responses[0]).not.toHaveBeenCalled();
          expect(isSessionPermissionChangePending(sessionId)).toBe(true);
          expect(
            loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.permissionMode,
          ).toBe("full");
          second = patch("read-only", 1);
          await Promise.resolve();
          expect(applyPermissionMode).toHaveBeenCalledTimes(1);
          release.resolve();
          await Promise.all([first, second]);
          expect(applyPermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
            "full",
            "read-only",
          ]);
          expect(responses[0]).toHaveBeenCalledWith(true, expect.any(Object), undefined);
          expect(responses[1]).toHaveBeenCalledWith(true, expect.any(Object), undefined);
          expect(patched).toHaveBeenCalledTimes(2);
          expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledTimes(prepareCatalog ? 1 : 0);
          expect(isSessionPermissionChangePending(sessionId)).toBe(false);
          expect(
            loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.permissionMode,
          ).toBe("read-only");
          if (prepareCatalog) {
            expect(
              loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.thinkingLevel,
            ).toBe("low");
          }
        } finally {
          catalogRelease.resolve(snapshot);
          release.resolve();
          await Promise.allSettled([first, second]);
          unregisterInternalHook("session:patch", patched);
          clearActiveEmbeddedRun(sessionId, handle, sessionKey);
        }
      });
    },
  );

  it.each([
    { restore: false, revokeFirst: false },
    { restore: false, revokeFirst: true },
    { restore: true, revokeFirst: true },
  ])(
    "releases provisional batch permissions while a later target prepares its catalog (restore=$restore, revoked=$revokeFirst)",
    async ({ restore, revokeFirst }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const keys = ["agent:main:batch-permission-first", "agent:main:batch-permission-second"];
        const scope = (sessionKey: string) => ({ agentId: "main", env: state.env, sessionKey });
        for (const [index, sessionKey] of keys.entries()) {
          await upsertSessionEntryCore(scope(sessionKey), {
            sessionId: sessionKey,
            updatedAt: 1,
            permissionMode: "guarded",
            ...(restore ? { archivedAt: 1 } : {}),
            ...(index === 1 ? { thinkingLevel: "off" } : {}),
          });
        }
        const cfg: OpenClawConfig = {};
        const requestContext = context(cfg);
        const catalogEntered = createDeferredCore();
        const catalogRelease = createDeferredCore();
        requestContext.loadGatewayModelCatalogSnapshot = vi.fn(async () => {
          catalogEntered.resolve();
          await catalogRelease.promise;
          return {
            agentId: "main",
            agentDir: state.agentDir("main"),
            workspaceDir: state.workspaceDir,
            config: cfg,
            catalogComplete: true,
            entries: [],
            routeVariants: [],
          };
        });
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
        const lifecycleWrite = catalogEntered.promise.then(async () => {
          await patchSessionEntryCore(scope(keys[1]!), () => ({
            status: "running",
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
        const request: GatewayRequestHandlerOptions = {
          req: {
            type: "req",
            id: "batch-permission-catalog",
            method: "sessions.patchMany",
            params,
          },
          params,
          client: client(),
          context: requestContext,
          isWebchatConnect: () => true,
          sessionMutationAuthorization: {
            assertCurrent: () => {},
            assertTargetCurrent: ({ sessionKey }) => {
              if (revoked && sessionKey === keys[0]) {
                throw new Error("First target authority was revoked");
              }
            },
          },
          respond,
        };
        const pending = sessionMutationHandlers["sessions.patchMany"]!(request);
        try {
          await Promise.race([catalogEntered.promise, pending]);
          expect(requestContext.loadGatewayModelCatalogSnapshot).toHaveBeenCalledOnce();
          for (const key of keys) {
            expect(isSessionPermissionChangePending(key)).toBe(false);
            expect(loadSessionEntry(scope(key))?.permissionMode).toBe("guarded");
          }
          await lifecycleWrite;
          expect(loadSessionEntry(scope(keys[1]!))).toMatchObject({
            status: "running",
            lifecycleRunId: "batch-catalog-run",
          });
          catalogRelease.resolve();
          await pending;
          expect(respond).toHaveBeenCalledWith(
            true,
            {
              outcomes: [
                revokeFirst
                  ? { key: keys[0], ok: false, error: expect.any(Object) }
                  : { key: keys[0], ok: true },
                { key: keys[1], ok: true },
              ],
            },
            undefined,
          );
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
            status: "running",
            lifecycleRunId: "batch-catalog-run",
          });
        } finally {
          catalogRelease.resolve();
          await Promise.allSettled([pending, lifecycleWrite]);
          keys.forEach((key, index) => clearActiveEmbeddedRun(key, handles[index]!, key));
        }
      });
    },
  );

  it("refuses unsupported live permission changes before saving a misleading mode", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:unsupported-permissions";
      const sessionId = "unsupported-permissions";
      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        { sessionId, updatedAt: 1, permissionMode: "guarded" },
      );
      const handle = createEmbeddedRunHandle();
      setActiveEmbeddedRun(sessionId, handle, sessionKey);
      const respond = vi.fn();
      try {
        await sessionMutationHandlers["sessions.patch"]!({
          params: { key: sessionKey, permissionMode: "read-only" },
          client: client(),
          context: context({}),
          respond,
        } as never);
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ message: expect.stringContaining("Stop the run") }),
        );
        expect(
          loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.permissionMode,
        ).toBe("guarded");
        expect(isSessionPermissionChangePending(sessionId)).toBe(false);
      } finally {
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      }
    });
  });

  it("keeps a newly created session visible to its identified non-admin creator", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profileId = ensureProfileForEmail("patch-creator@example.test").id;
      const sessionKey = "agent:main:patch-created";
      const requestClient = client(profileId);
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "member",
            definitions: {
              member: {
                sessions: { others: "none" },
                agents: "*",
                scopes: ["operator.write"],
              },
            },
          },
        },
      };
      const requestContext = context(cfg);
      const patch = async (pinned: boolean) => {
        const request = { key: sessionKey, pinned };
        const authorization = resolveSessionMutationAuthorization({
          client: requestClient,
          method: "sessions.patch",
          requestParams: request,
          context: requestContext,
        });
        expect(authorization.error).toBeNull();
        const respond = vi.fn();
        await sessionMutationHandlers["sessions.patch"]?.({
          params: request,
          client: requestClient,
          context: requestContext,
          sessionMutationAuthorization: authorization.authorization,
          respond,
        } as never);
        expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
      };

      await patch(true);
      const entry = loadSessionEntry({ agentId: "main", env: state.env, sessionKey });
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
      expect(
        loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.pinnedAt,
      ).toBeUndefined();
    });
  });
});

describe("sessions.assignOwner", () => {
  it("assigns an agent-created session to a human without changing its provenance", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:handoff";
      const ownerProfile = ensureProfileForEmail("requester@example.test");
      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        {
          sessionId: "session-handoff",
          updatedAt: 1,
          visibility: "shared",
          createdVia: "spawn",
          createdActor: { type: "agent", id: "main" },
          createdAt: 1,
          parentSessionKey: "agent:main:main",
        },
      );
      const cfg = {
        agents: {
          list: [
            { id: "main", default: true },
            { id: "research", identity: { name: "Research" } },
          ],
        },
      } as OpenClawConfig;
      const requestContext = context(cfg);
      await expect(
        dispatchGatewayMethodInProcess(
          "sessions.assignOwner",
          { key: sessionKey, owner: { type: "human", id: ownerProfile.id } },
          {
            forceSyntheticClient: true,
            agentToolCaller: {
              agentId: "main",
              sessionKey: "agent:main:discord:direct:colin",
            },
            syntheticScopes: ["operator.write"],
            resolveGatewayContext: () => requestContext,
          },
        ),
      ).resolves.toMatchObject({
        ok: true,
        key: sessionKey,
        owner: {
          actor: { type: "human", id: ownerProfile.id },
          assignedBy: { type: "agent", id: "main" },
        },
      });

      expect(
        loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.owner,
      ).toMatchObject({
        actor: { type: "human", id: ownerProfile.id },
        assignedBy: { type: "agent", id: "main" },
      });
      expect(loadSessionEntry({ agentId: "main", env: state.env, sessionKey })).toMatchObject({
        createdVia: "spawn",
        createdActor: { type: "agent", id: "main" },
        createdAt: 1,
        parentSessionKey: "agent:main:main",
        visibility: "shared",
      });
    });
  });

  it("lets a write-scoped viewer assign a shared session without changing sharing authority", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:handoff";
      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        {
          sessionId: "session-handoff",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: "profile-creator" },
        },
      );
      const cfg = {
        agents: {
          list: [
            { id: "main", default: true },
            { id: "research", identity: { name: "Research" } },
          ],
        },
      } as OpenClawConfig;
      vi.spyOn(Date, "now").mockReturnValue(4242);

      const result = await invoke({
        cfg,
        client: client("profile-viewer"),
        request: { key: sessionKey, owner: { type: "agent", id: "research" } },
      });

      expect(result.authorization.error).toBeNull();
      expect(result.responses).toMatchObject([
        [
          true,
          {
            ok: true,
            key: sessionKey,
            owner: {
              actor: { type: "agent", id: "research", label: "Research" },
              assignedBy: { type: "human", id: "profile-viewer" },
              assignedAt: 4242,
            },
          },
          undefined,
        ],
      ]);
      expect(loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.owner).toEqual({
        actor: { type: "agent", id: "research" },
        assignedBy: { type: "human", id: "profile-viewer" },
        assignedAt: 4242,
      });
      const durableOwner = ensureProfileForEmail("next-owner@example.test");
      const reassigned = await invoke({
        cfg,
        client: client("profile-viewer"),
        request: {
          key: sessionKey,
          owner: { type: "human", id: durableOwner.id },
        },
      });
      expect(reassigned.responses).toMatchObject([
        [
          true,
          {
            owner: {
              actor: { type: "human", id: durableOwner.id },
              assignedBy: { type: "human", id: "profile-viewer" },
            },
          },
          undefined,
        ],
      ]);
      expect(
        loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.owner?.actor,
      ).toEqual({ type: "human", id: durableOwner.id });

      const target = resolveSessionSharingTarget({ cfg, sessionKey, agentId: "main" });
      if (!target) {
        throw new Error("expected assigned session target");
      }
      expect(resolveSessionSharingRole({ client: client("profile-creator"), target })).toBe(
        "owner",
      );
      expect(resolveSessionSharingRole({ client: client("research"), target })).toBe("viewer");
    });
  });

  it("rejects hidden viewers, unidentified callers, and unknown owner targets", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:private-handoff";
      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        {
          sessionId: "session-private-handoff",
          updatedAt: 1,
          visibility: "draft",
          createdActor: { type: "human", source: "profile", id: "profile-creator" },
        },
      );
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "research" }] },
      } as OpenClawConfig;
      const request = { key: sessionKey, owner: { type: "agent", id: "research" } };
      const hidden = await invoke({ cfg, client: client("profile-viewer"), request });
      expect(hidden.responses[0]?.[2]).toMatchObject({
        code: "FORBIDDEN",
        message: "session is not visible to this connection",
      });

      const unidentified = await invoke({
        cfg,
        client: client(),
        request: {
          key: sessionKey,
          owner: { type: "human", id: "profile-next" },
        },
      });
      expect(unidentified.responses[0]?.[2]).toMatchObject({
        code: "FORBIDDEN",
        message: "sessions.assignOwner requires an identified caller",
      });

      const nonSyntheticInternal = await invoke({
        cfg,
        client: {
          ...client(),
          internal: {
            agentToolCaller: {
              agentId: "main",
              sessionKey: "agent:main:discord:direct:colin",
            },
          },
        },
        request,
      });
      expect(nonSyntheticInternal.responses[0]?.[2]).toMatchObject({
        code: "FORBIDDEN",
        message: "sessions.assignOwner requires an identified caller",
      });

      const smuggled = await invoke({
        cfg,
        client: client(),
        request: {
          key: sessionKey,
          owner: { type: "human", id: "profile-next" },
          agentToolCaller: {
            agentId: "main",
            sessionKey: "agent:main:discord:direct:colin",
          },
        },
      });
      expect(smuggled.responses[0]?.[2]).toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("unexpected property 'agentToolCaller'"),
      });

      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        {
          sessionId: "session-private-handoff",
          updatedAt: 2,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: "profile-creator" },
        },
      );
      for (const owner of [
        { type: "human" as const, id: "unknown-profile" },
        { type: "human" as const, id: "discord:channel:123" },
        { type: "agent" as const, id: "missing" },
      ]) {
        const unknown = await invoke({
          cfg,
          client: client("profile-viewer"),
          request: { key: sessionKey, owner },
        });
        expect(unknown.responses[0]?.[2]).toMatchObject({
          code: "INVALID_REQUEST",
          message: `unknown session owner "${owner.id}"`,
        });
      }
      expect(
        loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.owner,
      ).toBeUndefined();
    });
  });
});
