import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import type { SessionMcpRuntime } from "../../agents/agent-bundle-mcp-types.js";
import { fetchMcpAppView, getMcpAppViewLease } from "../../agents/mcp-ui-resource.js";
import { testing as mcpUiResourceTesting } from "../../agents/mcp-ui-resource.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { ensureCanonicalGatewayOwnerProfile } from "../../state/user-profile-writes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureGatewayAuthPolicy } from "../auth-policy.js";
import { boardStore } from "../board-store.js";
import {
  executeMcpAppOperation,
  requireMcpAppInteraction,
  resolveMcpAppActiveView,
  resolveMcpAppAllowedToolNames,
  type McpAppActiveView,
} from "../mcp-app-operations.js";
import { makeClient } from "../server-broadcast.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createBoardHarness } from "./board.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

const profileState = { scenario: "minimal", prepareProfileCatalog: true } as const;
const scopes = ["operator.read", "operator.write", "operator.approvals"] as const;

afterEach(() => {
  mcpUiResourceTesting.clearViewStore();
  vi.restoreAllMocks();
});

it.for([
  "keep",
  "revoke",
  "cancel",
  "retire",
  "sharing",
  "foreign-requester",
  "shared-secret",
] as const)(
  "preserves source authority through board pins (%s)",
  (outcome, { signal: testSignal }) =>
    withOpenClawTestState(profileState, async ({ workspaceDir }) => {
      const revoke = outcome === "revoke";
      const cancel = outcome === "cancel";
      const retire = outcome === "retire";
      const sharing = outcome === "sharing";
      const foreignRequester = outcome === "foreign-requester";
      const sharedSecret = outcome === "shared-secret";
      const target = { agentId: "main", sessionKey: "agent:main:mcp-admission" };
      const cfg: OpenClawConfig = {
        ...rolePolicyConfig(),
        agents: { entries: { main: {} } },
        mcp: { apps: { enabled: true } },
        tools: { exec: { mode: "full" } },
      };
      cfg.gateway!.roles!.definitions!.view!.scopes = [...scopes];
      setRuntimeConfigSnapshot(cfg, cfg);
      const client: GatewayClient = sharedSecret
        ? makeClient("shared-secret-peer", "operator", ["operator.admin"]).client
        : {
            ...roleClient("view", "mcp-admission-owner"),
            connId: "mcp-admission-owner",
          };
      if (sharedSecret) {
        await ensureCanonicalGatewayOwnerProfile("Synthetic owner");
        cfg.gateway!.auth = { mode: "token", token: "synthetic-fixture-token" };
        client.connect.client = {
          id: "gateway-client",
          version: "test",
          platform: "test",
          mode: "backend",
        };
        client.internal = { authenticatedOperator: true, operatorRoleActor: { kind: "system" } };
        client.authPolicy = captureGatewayAuthPolicy(cfg, {
          role: "operator",
          authMethod: "token",
        });
        client.usesSharedGatewayAuth = true;
        client.sharedGatewaySessionGeneration = "synthetic-shared-generation";
        expect(client.authenticatedUserProfile).toBeUndefined();
      } else {
        client.connect.scopes = [...scopes];
      }
      const clientProfileId = sharedSecret
        ? GATEWAY_OWNER_PROFILE_ID
        : client.authenticatedUserProfile!.profileId;
      const creatorId = sharing
        ? roleClient("view", "mcp-admission-other").authenticatedUserProfile!.profileId
        : clientProfileId;
      await upsertSessionEntryCore(target, {
        sessionId: "mcp-admission-session",
        updatedAt: 1,
        visibility: sharing || foreignRequester ? ("shared" as const) : ("draft" as const),
        createdActor: {
          type: "human" as const,
          source: "profile" as const,
          id: creatorId,
        },
      });
      if (sharing) {
        addSessionMember(target, {
          identityId: clientProfileId,
          addedBy: creatorId,
          addedAt: 1,
        });
      }
      const descriptor = {
        serverName: "server",
        toolName: "refresh",
        uiResourceUri: "ui://server/app",
        toolCallId: "source-call",
      };
      const source = await boardStore.putWidget({
        ...target,
        name: "source",
        content: { kind: "mcp-app", descriptor, interactive: true },
        declared: { tools: ["refresh"] },
      });
      const sourceWidget = source.widgets[0]!;
      await boardStore.grant(
        target,
        "source",
        "granted",
        sourceWidget.revision,
        sourceWidget.instanceId,
      );
      const callTool = vi.fn<SessionMcpRuntime["callTool"]>(async () => ({ content: [] }));
      const runtime: SessionMcpRuntime = {
        sessionId: "mcp-admission-session",
        sessionKey: target.sessionKey,
        workspaceDir,
        configFingerprint: "synthetic",
        createdAt: 0,
        lastUsedAt: 0,
        mcpAppsEnabled: true,
        markUsed: () => {},
        peekCatalog: () => null,
        dispose: async () => {},
        callTool,
        getCatalog: async () => ({
          version: 1,
          generatedAt: 0,
          servers: {},
          tools: [
            {
              serverName: "server",
              safeServerName: "server",
              toolName: "refresh",
              inputSchema: Type.Object({}),
              fallbackDescription: "synthetic refresh",
            },
          ],
        }),
        readResource: async () => ({
          contents: [
            {
              uri: descriptor.uiResourceUri,
              mimeType: "text/html;profile=mcp-app",
              text: "<p>synthetic app</p>",
            },
          ],
        }),
      };
      const views: McpAppActiveView[] = [];
      const board = createBoardHarness(
        undefined,
        {
          resolveActiveView: resolveMcpAppActiveView,
          resolveAllowedToolNames: resolveMcpAppAllowedToolNames,
          mintFromTranscript: async ({ descriptor: sourceDescriptor, readOnly, ...options }) => {
            const fetched = await fetchMcpAppView({
              ...options,
              runtime,
              ...sourceDescriptor,
              requesterId: clientProfileId,
              toolInput: {},
              toolResult: { content: [] },
              ...(readOnly ? { readOnly: true } : {}),
            });
            const view = fetched && getMcpAppViewLease(fetched.viewId, runtime);
            if (!view) {
              return undefined;
            }
            const active = { runtime, view };
            views.push(active);
            return active;
          },
        },
        boardStore,
        { getRuntimeConfig: () => cfg },
      );
      const invoke = async (
        method: string,
        input: Record<string, unknown>,
        signal?: AbortSignal,
        requester = client,
      ) => {
        const respond = vi.fn<RespondFn>();
        await handleGatewayRequest({
          req: { type: "req", id: "mcp-admission", method, params: { ...target, ...input } },
          client: requester,
          context: board.context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: board.handlers,
          signal,
        });
        return respond;
      };
      const appView = async (name: string, { revision, instanceId }: typeof sourceWidget) => {
        const response = await invoke("board.widget.appView", { name, revision, instanceId });
        expect(response.mock.calls[0]?.[0]).toBe(true);
      };
      await appView("source", sourceWidget);
      const sourceView = views[0]!;
      if (sharedSecret) {
        const pinned = await invoke("board.widget.put", {
          name: "destination",
          content: { kind: "mcp-app", viewId: sourceView.view.viewId },
        });
        expect(pinned.mock.calls[0]?.[2]).toBeUndefined();
        expect(pinned.mock.calls[0]?.[0]).toBe(true);
        expect(await boardStore.readWidgetMcpApp(target, "destination")).toBeDefined();
        return;
      }
      if (foreignRequester) {
        const bob = { ...roleClient("write", "mcp-admission-bob"), connId: "mcp-admission-bob" };
        const control = await invoke(
          "board.widget.put",
          { name: "bob-control", content: { kind: "html", html: "<p>Bob can write</p>" } },
          undefined,
          bob,
        );
        expect(control.mock.calls[0]?.[0]).toBe(true);
        const before = await boardStore.getSnapshot(target);
        board.broadcast.mockClear();
        const rejected = await invoke(
          "board.widget.put",
          { name: "destination", content: { kind: "mcp-app", viewId: sourceView.view.viewId } },
          undefined,
          bob,
        );
        expect(rejected.mock.calls[0]?.[0]).toBe(false);
        expect(rejected.mock.calls[0]?.[2]?.message).toContain("expired or is not authorized");
        expect(await boardStore.getSnapshot(target)).toEqual(before);
        expect(await boardStore.readWidgetMcpApp(target, "destination")).toBeUndefined();
        expect(board.broadcast).not.toHaveBeenCalled();
        expect(callTool).not.toHaveBeenCalled();
        return;
      }
      await requireMcpAppInteraction(sourceView.view);
      const authorizeSource = sourceView.view.authorizeAppInteraction!;
      const policyEntered = createDeferredCore();
      const releasePolicy = createDeferredCore();
      const waitForPinGate = (gate: Promise<void>, message: string) =>
        withinTest(awaitGateBeforeSettlement(gate, pin!, message), testSignal);
      let pausePolicy = false;
      sourceView.view.authorizeAppInteraction = async () => {
        if (pausePolicy) {
          policyEntered.resolve();
          await releasePolicy.promise;
        }
        return await authorizeSource();
      };
      const controller = new AbortController();
      board.broadcast.mockClear();
      const database = openOpenClawAgentDatabase({ agentId: target.agentId });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const putEntered = createDeferredCore();
      const resumePut = createDeferredCore();
      const putQueued = createDeferredCore();
      const putWidget = boardStore.putWidget.bind(boardStore);
      const put = vi.spyOn(boardStore, "putWidget").mockImplementation(async (...args) => {
        putEntered.resolve();
        await resumePut.promise;
        // The real store method reserves synchronously before its first await.
        const pending = putWidget(...args);
        putQueued.resolve();
        return pending;
      });
      let reservation: Promise<void> | undefined;
      let pin: ReturnType<typeof invoke> | undefined;
      let destinationBefore: ReturnType<typeof boardStore.readWidgetMcpApp> | undefined;
      try {
        pin = invoke(
          "board.widget.put",
          {
            name: "destination",
            content: { kind: "mcp-app", viewId: sourceView.view.viewId },
          },
          controller.signal,
        );
        await waitForPinGate(putEntered.promise, "pin skipped source preflight");
        expect(put).toHaveBeenCalledOnce();
        if (revoke) {
          // Revoke after source preflight, before the pin reaches its write.
          const revocation = await invoke("board.update", {
            ops: [{ kind: "widget_remove", name: "source" }],
          });
          expect(revocation.mock.calls[0]?.[0]).toBe(true);
        }
        // Source preflight reads share the writer queue; finish them before holding it.
        reservation = runOpenClawAgentWorkerWrite(database, async () => {
          entered.resolve();
          await release.promise;
        });
        await withinTest(entered.promise, testSignal);
        destinationBefore = boardStore.readWidgetMcpApp(target, "destination");
        void destinationBefore.catch(() => {});
        resumePut.resolve();
        await waitForPinGate(putQueued.promise, "pin did not queue");
        pausePolicy = cancel || retire || sharing;
      } finally {
        resumePut.resolve();
        release.resolve();
        await reservation;
        try {
          if (pausePolicy) {
            await waitForPinGate(
              policyEntered.promise,
              "pin finished without awaiting its admitted source policy",
            );
            if (cancel) {
              controller.abort(new Error("request closed during source policy"));
            } else if (sharing) {
              expect(removeSessionMember(target, clientProfileId)).not.toBeNull();
            } else {
              expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
              expect(database.db.isOpen).toBe(false);
            }
          }
        } finally {
          releasePolicy.resolve();
        }
        await Promise.allSettled([pin, destinationBefore]);
        await pin;
      }
      await expect(destinationBefore).resolves.toBeUndefined();
      if (cancel || retire || sharing) {
        expect((await pin)!.mock.calls.some(([ok]) => ok)).toBe(false);
        if (retire) {
          await closeOpenClawAgentDatabaseByPathAsync(database.path);
        }
        expect(await boardStore.readWidgetMcpApp(target, "destination")).toBeUndefined();
        expect(board.broadcast).not.toHaveBeenCalled();
        expect(callTool).not.toHaveBeenCalled();
        if (retire) {
          expect(getOpenClawAgentDatabaseIfOpen(database)).toBeUndefined();
        }
        return;
      }
      expect((await pin)!.mock.calls[0]?.[0]).toBe(true);
      if (revoke) {
        expect(await boardStore.readWidgetMcpApp(target, "source")).toBeUndefined();
        await expect(requireMcpAppInteraction(sourceView.view)).rejects.toThrow(
          "grant is no longer active",
        );
      }
      const destination = (await boardStore.getSnapshot(target)).widgets.find(
        (widget) => widget.name === "destination",
      )!;
      const document = await boardStore.readWidgetMcpApp(target, "destination");
      await appView("destination", destination);
      const destinationView = views[1]!;
      const effect = await executeMcpAppOperation(destinationView, {
        method: "tools/call",
        params: { name: "refresh", arguments: {} },
      }).then(
        () => "called",
        () => "refused",
      );
      expect(document).toMatchObject({
        interactive: !revoke,
        declaredTools: revoke ? [] : ["refresh"],
        grantState: revoke ? "none" : "granted",
      });
      expect({ effect, calls: callTool.mock.calls }).toEqual({
        effect: revoke ? "refused" : "called",
        calls: revoke ? [] : [["server", "refresh", {}]],
      });
    }),
);
