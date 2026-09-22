import { setImmediate } from "node:timers/promises";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMcpRuntime } from "../../agents/agent-bundle-mcp-types.js";
import { fetchMcpAppView, getMcpAppViewLease } from "../../agents/mcp-ui-resource.js";
import { testing as mcpUiResourceTesting } from "../../agents/mcp-ui-resource.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { boardStore } from "../board-store.js";
import {
  executeMcpAppOperation,
  requireMcpAppInteraction,
  resolveMcpAppActiveView,
  resolveMcpAppAllowedToolNames,
  type McpAppActiveView,
} from "../mcp-app-operations.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createBoardHarness } from "./board.test-support.js";
import type { RespondFn } from "./types.js";

afterEach(() => {
  mcpUiResourceTesting.clearViewStore();
  vi.restoreAllMocks();
});

describe("MCP App source authority at board write admission", () => {
  it.each([
    { revoke: false, cancel: false, retire: false },
    { revoke: true, cancel: false, retire: false },
    { revoke: false, cancel: true, retire: false },
    { revoke: false, cancel: false, retire: true },
  ])(
    "retains only current source tool authority after queueing (revoke=$revoke, cancel=$cancel, retire=$retire)",
    async ({ revoke, cancel, retire }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async ({ workspaceDir }) => {
        const target = { agentId: "main", sessionKey: "agent:main:mcp-admission" };
        const cfg: OpenClawConfig = {
          ...rolePolicyConfig(),
          agents: { entries: { main: {} } },
          mcp: { apps: { enabled: true } },
          tools: { exec: { mode: "full" } },
        };
        cfg.gateway!.roles!.definitions!.view!.scopes = [
          "operator.read",
          "operator.write",
          "operator.approvals",
        ];
        setRuntimeConfigSnapshot(cfg, cfg);
        const client = {
          ...roleClient("view", "mcp-admission-owner"),
          connId: "mcp-admission-owner",
        };
        client.connect.scopes = ["operator.read", "operator.write", "operator.approvals"];
        await upsertSessionEntryCore(target, {
          sessionId: "mcp-admission-session",
          updatedAt: 1,
          visibility: "draft",
          createdActor: {
            type: "human",
            source: "profile",
            id: client.authenticatedUserProfile!.profileId,
          },
        });
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
        const callTool = vi.fn<SessionMcpRuntime["callTool"]>(async () => ({
          content: [{ type: "text", text: "synthetic tool effect" }],
        }));
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
            mintFromTranscript: async ({
              descriptor: sourceDescriptor,
              allowedAppToolNames,
              authorizeAppInteraction,
              readOnly,
            }) => {
              const fetched = await fetchMcpAppView({
                runtime,
                agentId: target.agentId,
                ...sourceDescriptor,
                toolInput: {},
                toolResult: { content: [] },
                allowedAppToolNames,
                authorizeAppInteraction,
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
        ) => {
          const respond = vi.fn<RespondFn>();
          await handleGatewayRequest({
            req: { type: "req", id: "mcp-admission", method, params: { ...target, ...input } },
            client,
            context: board.context,
            respond,
            isWebchatConnect: () => false,
            extraHandlers: board.handlers,
            signal,
          });
          return respond;
        };
        expect(
          (
            await invoke("board.widget.appView", {
              name: "source",
              revision: sourceWidget.revision,
              instanceId: sourceWidget.instanceId,
            })
          ).mock.calls[0]?.[0],
        ).toBe(true);
        const sourceView = views[0]!;
        await requireMcpAppInteraction(sourceView.view);
        const authorizeSource = sourceView.view.authorizeAppInteraction!;
        const policyEntered = createDeferredCore();
        const releasePolicy = createDeferredCore();
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
        const reservation = runOpenClawAgentWorkerWrite(database, async () => {
          entered.resolve();
          await release.promise;
        });
        await entered.promise;
        const remove = vi.spyOn(boardStore, "applyOps");
        const put = vi.spyOn(boardStore, "putWidget");
        let revocation: ReturnType<typeof invoke> | undefined;
        let pin: ReturnType<typeof invoke> | undefined;
        try {
          if (revoke) {
            revocation = invoke("board.update", {
              ops: [{ kind: "widget_remove", name: "source" }],
            });
            await setImmediate();
            expect(remove).toHaveBeenCalledOnce();
          }
          pin = invoke(
            "board.widget.put",
            {
              name: "destination",
              content: { kind: "mcp-app", viewId: sourceView.view.viewId },
            },
            controller.signal,
          );
          await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());
          expect(await boardStore.readWidgetMcpApp(target, "destination")).toBeUndefined();
          pausePolicy = cancel || retire;
        } finally {
          release.resolve();
          await reservation;
          try {
            if (pausePolicy) {
              await Promise.race([
                policyEntered.promise,
                pin!.then(() => {
                  throw new Error("pin finished without awaiting its admitted source policy");
                }),
              ]);
              if (cancel) {
                controller.abort(new Error("request closed during source policy"));
              } else {
                expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
                expect(database.db.isOpen).toBe(false);
              }
            }
          } finally {
            releasePolicy.resolve();
          }
          await revocation;
          await pin;
        }
        if (cancel || retire) {
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
          expect((await revocation)!.mock.calls[0]?.[0]).toBe(true);
          expect(await boardStore.readWidgetMcpApp(target, "source")).toBeUndefined();
          await expect(requireMcpAppInteraction(sourceView.view)).rejects.toThrow(
            "grant is no longer active",
          );
        }
        const destination = (await boardStore.getSnapshot(target)).widgets.find(
          (widget) => widget.name === "destination",
        )!;
        const document = await boardStore.readWidgetMcpApp(target, "destination");
        expect(
          (
            await invoke("board.widget.appView", {
              name: "destination",
              revision: destination.revision,
              instanceId: destination.instanceId,
            })
          ).mock.calls[0]?.[0],
        ).toBe(true);
        const destinationView = views[1]!;
        const effect = await executeMcpAppOperation(destinationView, {
          method: "tools/call",
          params: { name: "refresh", arguments: {} },
        }).then(
          () => "called",
          () => "refused",
        );
        expect({
          interactive: document?.interactive,
          tools: document?.declaredTools,
          grant: document?.grantState,
          effect,
          calls: callTool.mock.calls,
        }).toEqual({
          interactive: !revoke,
          tools: revoke ? [] : ["refresh"],
          grant: revoke ? "none" : "granted",
          effect: revoke ? "refused" : "called",
          calls: revoke ? [] : [["server", "refresh", {}]],
        });
      });
    },
  );
});
