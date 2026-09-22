import {
  type BoardSnapshot,
  type BoardWidgetMaterializedPutParams,
  validateBoardActionParams,
  validateBoardDataReadParams,
  validateBoardEventParams,
  validateBoardGetParams,
  validateBoardPromptAuthorizeParams,
  validateBoardUpdateParams,
  validateBoardWidgetContent,
  validateBoardWidgetAppViewParams,
  validateBoardWidgetGrantParams,
  validateBoardWidgetPutParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  boardWidgetHasGrantedTool,
  normalizeBoardWidgetDeclared,
} from "../../boards/board-capabilities.js";
import { BoardValidationError } from "../../boards/board-layout.js";
import { appendBoardEventNotice } from "../../boards/board-notices.js";
import type { BoardSessionTarget, BoardStore } from "../../boards/board-store.js";
import { GITHUB_ACTIONS_GRANT_PREFIX } from "../../boards/github-actions-capability.js";
import { readCanvasDocumentHtmlSource } from "../../canvas/documents.js";
import { buildWidgetDocument } from "../../canvas/wrap.js";
import {
  resolveBoardWidgetContentKind,
  resolveBoardWidgetContentKindByPluginKind,
  resolveBoardWidgetContentKindResourceUrls,
} from "../../plugins/board-widget-content-kinds.js";
import {
  boardDataBindingCapability,
  captureBoardCapabilityAuthority,
  assertBoardCapabilityParamsSize,
  captureBoardRequestAuthority,
  readBoardDataBinding,
  respondBoardError,
  runBoardActionVerb,
  triggerBoardCronJob,
} from "../board-host-tools.js";
import { buildBoardWidgetSandboxPath } from "../board-sandbox.js";
import { boardStore } from "../board-store.js";
import {
  BOARD_VIEW_TICKET_TTL_MS,
  buildBoardWidgetFrameUrl,
  createBoardViewTicket,
} from "../board-view-ticket.js";
import { resolveBoardWidgetApproval } from "../board-widget-approval.js";
import { withAuthorizedBoardWidgetView } from "../board-widget-view.js";
import {
  requireMcpAppInteraction,
  resolveMcpAppActiveView,
  resolveMcpAppAllowedToolNames,
} from "../mcp-app-operations.js";
import { mintMcpAppViewFromTranscript } from "../mcp-app-reconstruction.js";
import { sessionObserverScopeKey } from "../session-observer-model.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveSessionStoreKey } from "../session-store-key.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams, defineValidatedGatewayMethod } from "./validation.js";

type CanvasDocumentReader = typeof readCanvasDocumentHtmlSource;
type McpAppDependencies = {
  resolveActiveView: typeof resolveMcpAppActiveView;
  resolveAllowedToolNames: typeof resolveMcpAppAllowedToolNames;
  mintFromTranscript: typeof mintMcpAppViewFromTranscript;
};
type BoardHandlerDependencies = Partial<McpAppDependencies>;

function resolveBoardSession(
  params: { sessionKey: string; agentId?: string | undefined },
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
): Required<BoardSessionTarget> | undefined {
  const cfg = context.getRuntimeConfig();
  const requested = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
  if (!requested.ok) {
    respond(false, undefined, requested.error);
    return undefined;
  }
  const canonicalKey = resolveSessionStoreKey({
    cfg,
    sessionKey: params.sessionKey,
    storeAgentId: requested.agentId,
  });
  return { sessionKey: canonicalKey, agentId: requested.agentId };
}

function projectBoardSnapshot<T extends BoardSnapshot>(snapshot: T, agentId: string): T {
  // Observer identities distinguish global boards on the wire, never in stored rows.
  return { ...snapshot, sessionKey: sessionObserverScopeKey(snapshot.sessionKey, agentId) };
}

export function createBoardHandlers(
  store: BoardStore,
  readCanvasDocument: CanvasDocumentReader = readCanvasDocumentHtmlSource,
  dependencies: BoardHandlerDependencies = {},
): GatewayRequestHandlers {
  const mcpApp: McpAppDependencies = {
    resolveActiveView: dependencies.resolveActiveView ?? resolveMcpAppActiveView,
    resolveAllowedToolNames: dependencies.resolveAllowedToolNames ?? resolveMcpAppAllowedToolNames,
    mintFromTranscript: dependencies.mintFromTranscript ?? mintMcpAppViewFromTranscript,
  };
  return {
    "board.get": defineValidatedGatewayMethod(
      "board.get",
      validateBoardGetParams,
      async (invocation) => {
        const { params: boardParams, respond, context, client } = invocation;
        try {
          const authority = captureBoardRequestAuthority(invocation);
          const boardSession = resolveBoardSession(boardParams, context, respond);
          if (!boardSession) {
            return;
          }
          const { snapshot, htmlViewMetadata } =
            await store.getSnapshotWithHtmlViewMetadata(boardSession);
          authority.assertActive();
          let sandboxPort = context.getMcpAppSandboxPort?.();
          let sandboxOrigin: string | undefined;
          let sandboxOriginResolved = false;
          for (const widget of snapshot.widgets) {
            if (widget.grantState !== "none" && widget.grantState !== "granted") {
              continue;
            }
            const viewMetadata = htmlViewMetadata.get(widget.name);
            if (!viewMetadata || viewMetadata.revision !== widget.revision) {
              continue;
            }
            const registration = widget.pluginKind
              ? resolveBoardWidgetContentKindByPluginKind(
                  authority.pluginRegistry,
                  widget.pluginKind,
                )
              : undefined;
            const scopedHostUrl = registration
              ? client?.pluginSurfaceUrls?.[registration.definition.resources.surface]
              : undefined;
            const resourceUrls =
              registration && scopedHostUrl
                ? resolveBoardWidgetContentKindResourceUrls(registration, scopedHostUrl)
                : undefined;
            if (
              widget.contentKind === "plugin" &&
              (!registration || !resourceUrls || !scopedHostUrl)
            ) {
              continue;
            }
            const resourceOrigins = resourceUrls
              ? [...new Set(Object.values(resourceUrls).map((url) => new URL(url).origin))]
              : undefined;
            if (sandboxPort === undefined && context.ensureSandboxHostPort) {
              sandboxPort = await context.ensureSandboxHostPort();
              authority.assertActive();
            }
            authority.assertActive();
            const { ticket } = createBoardViewTicket({
              agentId: boardSession.agentId,
              sessionKey: snapshot.sessionKey,
              name: widget.name,
              revision: widget.revision,
              viewGeneration: viewMetadata.viewGeneration,
              ...(registration && scopedHostUrl
                ? {
                    pluginFrame: {
                      pluginKind: registration.pluginKind,
                      scopedHostUrl,
                    },
                  }
                : {}),
              authority: authority.ticketAuthority,
            });
            if (registration) {
              widget.kindLabel = registration.definition.label;
            }
            widget.frameUrl = buildBoardWidgetFrameUrl({
              sessionKey: sessionObserverScopeKey(snapshot.sessionKey, boardSession.agentId),
              name: widget.name,
              ticket,
            });
            widget.viewTicket = ticket;
            widget.viewTicketTtlMs = BOARD_VIEW_TICKET_TTL_MS;
            widget.viewGeneration = viewMetadata.viewGeneration;
            if (sandboxPort !== undefined) {
              widget.sandboxUrl = buildBoardWidgetSandboxPath({
                ...viewMetadata,
                ...(resourceOrigins ? { resourceOrigins } : {}),
              });
              widget.sandboxPort = sandboxPort;
              if (!sandboxOriginResolved) {
                const configuredOrigin = context.getRuntimeConfig?.().mcp?.apps?.sandboxOrigin;
                sandboxOrigin = configuredOrigin ? new URL(configuredOrigin).origin : undefined;
                sandboxOriginResolved = true;
              }
              if (sandboxOrigin) {
                widget.sandboxOrigin = sandboxOrigin;
              }
            }
          }
          authority.assertActive();
          respond(true, projectBoardSnapshot(snapshot, boardSession.agentId));
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
    "board.update": defineValidatedGatewayMethod(
      "board.update",
      validateBoardUpdateParams,
      async (invocation) => {
        const { params: boardParams, respond, context } = invocation;
        try {
          const authority = captureBoardRequestAuthority(invocation);
          const boardSession = resolveBoardSession(boardParams, context, respond);
          if (!boardSession) {
            return;
          }
          authority.assertActive();
          const snapshot = projectBoardSnapshot(
            await store.applyOps(boardSession, boardParams.ops, {
              assertCurrent: authority.assertActive,
            }),
            boardSession.agentId,
          );
          authority.assertActive();
          if (boardParams.ops.length > 0) {
            emitSessionsChanged(context, {
              sessionKey: boardSession.sessionKey,
              agentId: boardSession.agentId,
              reason: "board",
            });
            context.broadcast(
              "board.changed",
              {
                sessionKey: snapshot.sessionKey,
                revision: snapshot.revision,
              },
              { sessionKeys: [boardSession.sessionKey], agentId: boardSession.agentId },
            );
          }
          respond(true, snapshot);
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
    "board.widget.put": defineValidatedGatewayMethod(
      "board.widget.put",
      validateBoardWidgetPutParams,
      async (invocation) => {
        const { params: requestParams, respond, context } = invocation;
        try {
          const authority = captureBoardRequestAuthority(invocation);
          const boardSession = resolveBoardSession(requestParams, context, respond);
          if (!boardSession) {
            return;
          }
          const { declared: requestDeclared, ...requestWithoutDeclared } = requestParams;
          let content: BoardWidgetMaterializedPutParams["content"];
          let declared = requestDeclared;
          if (requestParams.content.kind === "canvas-doc") {
            const document = await readCanvasDocument(requestParams.content.docId);
            authority.assertActive();
            if (document.cspSandbox !== "scripts") {
              throw new BoardValidationError(
                "invalid_operation",
                `canvas document is not script-enabled: ${requestParams.content.docId}`,
              );
            }
            content = { kind: "html", html: document.html };
          } else if (requestParams.content.kind === "mcp-app") {
            const active = await mcpApp.resolveActiveView({
              ...boardSession,
              viewId: requestParams.content.viewId,
              cfg: context.getRuntimeConfig(),
            });
            authority.assertActive();
            const { view } = active;
            if (!view.toolCallId) {
              throw new BoardValidationError(
                "invalid_operation",
                "MCP App view is missing its originating tool call",
              );
            }
            let interactive = false;
            try {
              await requireMcpAppInteraction(view);
              interactive = true;
            } catch {
              // Reconstructed or revoked source leases may be pinned only as read-only content.
            }
            authority.assertActive();
            const allowedTools = interactive ? await mcpApp.resolveAllowedToolNames(active) : [];
            authority.assertActive();
            if (interactive) {
              try {
                await requireMcpAppInteraction(view);
              } catch {
                interactive = false;
              }
              authority.assertActive();
            }
            content = {
              kind: "mcp-app",
              descriptor: {
                serverName: view.serverName,
                toolName: view.toolName,
                uiResourceUri: view.uiResourceUri,
                toolCallId: view.toolCallId,
              },
              interactive,
            };
            declared = interactive && allowedTools.length > 0 ? { tools: allowedTools } : undefined;
          } else if (requestParams.content.kind === "registered") {
            const registration = resolveBoardWidgetContentKind(
              authority.pluginRegistry,
              requestParams.content.contentKind,
            );
            if (!registration) {
              throw new BoardValidationError(
                "invalid_operation",
                `widget kind ${JSON.stringify(requestParams.content.contentKind)} is unavailable; enable the plugin that provides it and retry`,
              );
            }
            try {
              registration.definition.validateSource(requestParams.content.source);
            } catch (error) {
              throw new BoardValidationError(
                "invalid_operation",
                `invalid ${requestParams.content.contentKind} widget source: ${String(error)}`,
              );
            }
            content = {
              ...requestParams.content,
              pluginKind: registration.pluginKind,
            };
          } else {
            content = requestParams.content;
          }
          const persistedContent =
            content.kind === "mcp-app"
              ? { kind: content.kind, descriptor: content.descriptor }
              : content.kind === "registered"
                ? {
                    kind: content.kind,
                    contentKind: content.contentKind,
                    source: content.source,
                  }
                : content;
          if (
            !assertValidParams(
              persistedContent,
              validateBoardWidgetContent,
              "board.widget.put content",
              respond,
            )
          ) {
            return;
          }
          declared = normalizeBoardWidgetDeclared(declared);
          const materializedContent: BoardWidgetMaterializedPutParams["content"] =
            content.kind === "html"
              ? {
                  kind: "html",
                  // Authority-bearing bridge code must precede every admitted
                  // byte, including complete HTML and managed Canvas documents.
                  // The wrapper is idempotent so an already-wrapped Canvas view
                  // keeps one effective bridge owner.
                  html: buildWidgetDocument(
                    requestParams.title ?? requestParams.name,
                    content.html,
                    {
                      connectOrigins: declared?.netOrigins,
                    },
                  ),
                }
              : content;
          const boardParams: BoardWidgetMaterializedPutParams = {
            ...requestWithoutDeclared,
            ...boardSession,
            content: materializedContent,
            ...(declared ? { declared } : {}),
          };
          let identity:
            | Awaited<
                ReturnType<typeof import("../github-actions-read.js").prepareBoardGitHubIdentity>
              >
            | undefined;
          if (
            (content.kind === "html" || content.kind === "registered") &&
            declared?.tools?.some((tool) => tool.startsWith(GITHUB_ACTIONS_GRANT_PREFIX))
          ) {
            const { prepareBoardGitHubIdentity } = await import("../github-actions-read.js");
            identity = await prepareBoardGitHubIdentity(context, {
              ...authority,
              boardSession,
            });
          }
          const putWidget = () =>
            store.putWidget(boardParams, {
              assertCurrent: () => {
                authority.assertActive();
                identity?.assertSelected();
                const cfg = context.getRuntimeConfig();
                const current = resolveRequestedSessionAgentId(
                  cfg,
                  boardSession.sessionKey,
                  boardSession.agentId,
                );
                if (
                  !current.ok ||
                  resolveSessionStoreKey({
                    cfg,
                    sessionKey: boardSession.sessionKey,
                    storeAgentId: current.agentId,
                  }) !== boardSession.sessionKey
                ) {
                  throw new BoardValidationError(
                    "invalid_operation",
                    "board session changed; retry",
                  );
                }
              },
            });
          let snapshot = identity ? await identity.start(putWidget) : await putWidget();
          authority.assertActive();
          const widget = snapshot.widgets.find(
            (candidate) => candidate.name === snapshot.resolvedWidgetName,
          );
          if (widget?.grantState === "pending") {
            const decision = await resolveBoardWidgetApproval({
              cfg: context.getRuntimeConfig(),
              ...boardSession,
              name: snapshot.resolvedWidgetName,
              declared: declared ?? {},
            });
            authority.assertActive();
            if (decision) {
              snapshot = {
                ...(await store.grant(
                  boardSession,
                  snapshot.resolvedWidgetName,
                  decision,
                  widget.revision,
                  widget.instanceId,
                  { assertCurrent: authority.assertActive },
                )),
                resolvedWidgetName: snapshot.resolvedWidgetName,
              };
            }
          }
          authority.assertActive();
          snapshot = projectBoardSnapshot(snapshot, boardSession.agentId);
          emitSessionsChanged(context, {
            sessionKey: boardSession.sessionKey,
            agentId: boardSession.agentId,
            reason: "board",
          });
          context.broadcast(
            "board.changed",
            {
              sessionKey: snapshot.sessionKey,
              revision: snapshot.revision,
              widget: snapshot.resolvedWidgetName,
            },
            { sessionKeys: [boardSession.sessionKey], agentId: boardSession.agentId },
          );
          respond(true, snapshot);
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
    "board.widget.grant": defineValidatedGatewayMethod(
      "board.widget.grant",
      validateBoardWidgetGrantParams,
      async (invocation) => {
        const { params: boardParams, respond, context } = invocation;
        try {
          const authority = captureBoardRequestAuthority(invocation);
          const boardSession = resolveBoardSession(boardParams, context, respond);
          if (!boardSession) {
            return;
          }
          authority.assertActive();
          const snapshot = projectBoardSnapshot(
            await store.grant(
              boardSession,
              boardParams.name,
              boardParams.decision,
              boardParams.revision,
              boardParams.instanceId,
              { assertCurrent: authority.assertActive },
            ),
            boardSession.agentId,
          );
          authority.assertActive();
          context.broadcast(
            "board.changed",
            {
              sessionKey: snapshot.sessionKey,
              revision: snapshot.revision,
            },
            { sessionKeys: [boardSession.sessionKey], agentId: boardSession.agentId },
          );
          respond(true, snapshot);
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
    "board.widget.appView": defineValidatedGatewayMethod(
      "board.widget.appView",
      validateBoardWidgetAppViewParams,
      async (invocation) => {
        const { params: boardParams, respond, context } = invocation;
        try {
          const authority = captureBoardRequestAuthority(invocation);
          const boardSession = resolveBoardSession(boardParams, context, respond);
          if (!boardSession) {
            return;
          }
          const snapshot = await store.getSnapshot(boardSession);
          const widget = snapshot.widgets.find((candidate) => candidate.name === boardParams.name);
          const document = await store.readWidgetMcpApp(boardSession, boardParams.name);
          authority.assertActive();
          if (
            !widget ||
            widget.contentKind !== "mcp-app" ||
            widget.revision !== boardParams.revision ||
            widget.instanceId !== boardParams.instanceId ||
            !document ||
            document.revision !== boardParams.revision ||
            document.instanceId !== boardParams.instanceId
          ) {
            throw new BoardValidationError(
              "not_found",
              `board MCP App widget not found: ${boardParams.name}`,
            );
          }
          const interactive = document.interactive && document.grantState === "granted";
          const authorizeAppInteraction = interactive
            ? async () => {
                const current = await store.readWidgetMcpApp(boardSession, boardParams.name);
                return (
                  current?.interactive === true &&
                  current.grantState === "granted" &&
                  current.revision === boardParams.revision &&
                  current.instanceId === boardParams.instanceId
                );
              }
            : undefined;
          const minted = await mcpApp.mintFromTranscript({
            cfg: context.getRuntimeConfig(),
            ...boardSession,
            descriptor: document.descriptor,
            allowedAppToolNames: new Set(interactive ? document.declaredTools : []),
            ...(authorizeAppInteraction ? { authorizeAppInteraction } : {}),
            readOnly: !interactive,
          });
          authority.assertActive();
          if (!minted) {
            throw new Error("Pinned MCP App source is no longer available");
          }
          respond(true, {
            viewId: minted.view.viewId,
            expiresAtMs: minted.view.expiresAtMs,
          });
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
    "board.event": defineValidatedGatewayMethod(
      "board.event",
      validateBoardEventParams,
      async (invocation) => {
        const { params: boardParams, respond, context } = invocation;
        try {
          const authority = captureBoardRequestAuthority(invocation);
          const publish = (identity: BoardSessionTarget & { name: string }) => {
            authority.assertActive();
            const appended = appendBoardEventNotice({
              sessionKey: identity.sessionKey,
              agentId: identity.agentId,
              widget: identity.name,
              payload: boardParams.payload,
            });
            respond(true, { ok: true, appended });
          };
          if ("ticket" in boardParams) {
            await withAuthorizedBoardWidgetView(store, boardParams.ticket, publish, {
              gatewayContext: context,
            });
          } else {
            const boardSession = resolveBoardSession(boardParams, context, respond);
            if (!boardSession) {
              return;
            }
            await store.useSnapshot(boardSession, (snapshot) => {
              if (!snapshot.widgets.some((candidate) => candidate.name === boardParams.widget)) {
                throw new BoardValidationError(
                  "not_found",
                  `board widget not found: ${boardParams.widget}`,
                );
              }
              publish({ ...boardSession, name: boardParams.widget });
            });
          }
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
    "board.prompt.authorize": defineValidatedGatewayMethod(
      "board.prompt.authorize",
      validateBoardPromptAuthorizeParams,
      async (invocation) => {
        const { params: boardParams, respond, context } = invocation;
        try {
          const authority = captureBoardRequestAuthority(invocation);
          await withAuthorizedBoardWidgetView(
            store,
            boardParams.ticket,
            ({ document }) => {
              authority.assertActive();
              respond(true, {
                confirmationRequired: !boardWidgetHasGrantedTool(
                  document.declared,
                  document.grantState,
                  "prompt",
                ),
              });
            },
            { gatewayContext: context },
          );
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
    "board.data.read": defineValidatedGatewayMethod(
      "board.data.read",
      validateBoardDataReadParams,
      async (invocation) => {
        const { params: boardParams, respond } = invocation;
        try {
          const bindingParams = boardParams.params ?? {};
          assertBoardCapabilityParamsSize(bindingParams, "data binding");
          const authority = captureBoardCapabilityAuthority(
            store,
            boardParams.ticket,
            invocation,
            boardDataBindingCapability(boardParams.bindingId, bindingParams),
          );
          await readBoardDataBinding(
            boardParams.bindingId,
            bindingParams,
            invocation,
            authority,
            respond,
          );
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
    "board.action": defineValidatedGatewayMethod(
      "board.action",
      validateBoardActionParams,
      async (invocation) => {
        const { params: boardParams, respond } = invocation;
        try {
          const capability =
            "jobId" in boardParams ? `cron.trigger:${boardParams.jobId}` : boardParams.action;
          const authority = captureBoardCapabilityAuthority(
            store,
            boardParams.ticket,
            invocation,
            capability,
          );
          if ("jobId" in boardParams) {
            await triggerBoardCronJob(boardParams.jobId, invocation, authority, respond);
            return;
          }
          const actionParams = boardParams.params ?? {};
          assertBoardCapabilityParamsSize(actionParams, "action");
          await runBoardActionVerb(
            boardParams.action,
            actionParams,
            invocation,
            authority,
            respond,
          );
        } catch (error) {
          respondBoardError(error, respond);
        }
      },
    ),
  };
}

export const boardHandlers = createBoardHandlers(boardStore);
