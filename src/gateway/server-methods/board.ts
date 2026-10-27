import { isDeepStrictEqual } from "node:util";
import {
  type BoardWidgetMaterializedPutParams,
  ErrorCodes,
  errorShape,
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
  acquireSessionActorStorage,
  runWithSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import {
  boardDataBindingCapability,
  captureBoardCapabilityAuthority,
  assertBoardCapabilityParamsSize,
  captureBoardRequestAuthority,
  readBoardDataBinding,
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
import { createBoardWidgetApprovalResolver } from "../board-widget-approval.js";
import { withAuthorizedBoardWidgetView } from "../board-widget-view.js";
import {
  supportsMcpAppInteraction,
  resolveMcpAppActiveView,
  resolveMcpAppAllowedToolNames,
} from "../mcp-app-operations.js";
import { mintMcpAppViewFromTranscript } from "../mcp-app-reconstruction.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { sessionObserverScopeKey } from "../session-observer-model.js";
import { resolveRequestedSessionStoreTarget } from "../session-store-key.js";
import {
  defineBoardMethod,
  resolveBoardSession,
  projectBoardSnapshot,
  broadcastBoardChanged,
} from "./board-handler-context.js";
import { retainCanvasWidgetRead } from "./canvas-widget-read.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export function createBoardHandlers(store: BoardStore): GatewayRequestHandlers {
  const resolveBoardWidgetApproval = createBoardWidgetApprovalResolver();
  return {
    "board.get": defineBoardMethod("board.get", validateBoardGetParams, async (invocation) => {
      const { params: boardParams, respond, context, client } = invocation;
      const ingress = client?.remoteControlUiIngress;
      const authority = captureBoardRequestAuthority(invocation);
      const boardSession = resolveBoardSession(boardParams, context, respond);
      if (!boardSession) {
        return;
      }
      const { snapshot, htmlViewMetadata } =
        await store.getSnapshotWithHtmlViewMetadata(boardSession);
      authority.assertActive();
      let sandboxPort = context.getMcpAppSandboxPort?.();
      let sandboxOrigin: string | undefined | null = null;
      for (const widget of snapshot.widgets) {
        if (widget.grantState !== "none" && widget.grantState !== "granted") {
          continue;
        }
        const viewMetadata = htmlViewMetadata.get(widget.name);
        if (!viewMetadata || viewMetadata.revision !== widget.revision) {
          continue;
        }
        if (sandboxPort === undefined && context.ensureSandboxHostPort) {
          sandboxPort = await context.ensureSandboxHostPort();
        }
        authority.assertActive();
        const { ticket } = createBoardViewTicket({
          agentId: boardSession.agentId,
          sessionKey: snapshot.sessionKey,
          name: widget.name,
          revision: widget.revision,
          viewGeneration: viewMetadata.viewGeneration,
          authority: {
            ...authority.ticketAuthority,
            remoteIngressPrincipal: client?.internal?.remoteIngressPrincipal,
          },
        });
        widget.frameUrl = buildBoardWidgetFrameUrl({
          sessionKey: sessionObserverScopeKey(snapshot.sessionKey, boardSession.agentId),
          name: widget.name,
          ticket,
        });
        if (ingress) {
          widget.frameUrl = new URL(widget.frameUrl, ingress.publicOrigin).href;
        }
        widget.viewTicket = ticket;
        widget.viewTicketTtlMs = BOARD_VIEW_TICKET_TTL_MS;
        widget.viewGeneration = viewMetadata.viewGeneration;
        if (sandboxPort !== undefined) {
          widget.sandboxUrl = buildBoardWidgetSandboxPath({
            ...viewMetadata,
          });
          if (ingress) {
            widget.sandboxUrl = new URL(widget.sandboxUrl, ingress.sandboxOrigin).href;
          }
          widget.sandboxPort = sandboxPort;
          if (sandboxOrigin === null) {
            const configuredOrigin =
              ingress?.sandboxOrigin ?? context.getRuntimeConfig?.().mcp?.apps?.sandboxOrigin;
            sandboxOrigin = configuredOrigin ? new URL(configuredOrigin).origin : undefined;
          }
          if (sandboxOrigin) {
            widget.sandboxOrigin = sandboxOrigin;
          }
        }
      }
      authority.assertActive();
      respond(true, projectBoardSnapshot(snapshot, boardSession.agentId));
    }),
    "board.update": defineBoardMethod(
      "board.update",
      validateBoardUpdateParams,
      async (invocation) => {
        const { params: boardParams, respond, context } = invocation;
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
          broadcastBoardChanged(context, boardSession, snapshot);
        }
        respond(true, snapshot);
      },
    ),
    "board.widget.put": defineBoardMethod(
      "board.widget.put",
      validateBoardWidgetPutParams,
      async (invocation) => {
        const { params: requestParams, respond, context } = invocation;
        if (requestParams.content.kind === "registered") {
          throw new BoardValidationError(
            "invalid_operation",
            "Registered board widgets were removed; use HTML widgets instead.",
          );
        }
        const boardAuthority = captureBoardRequestAuthority(invocation);
        let requester: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
        let canvasRead: Awaited<ReturnType<typeof retainCanvasWidgetRead>> | undefined;
        const authority = {
          ...boardAuthority,
          assertActive: composeSessionSourceAssertion(
            [boardAuthority.assertActive],
            (assertSources) => {
              assertSources();
              requester?.authority.assertCurrent();
              canvasRead?.read.assertCurrent();
            },
          ),
        };
        const boardSession = resolveBoardSession(requestParams, context, respond);
        if (!boardSession) {
          return;
        }
        const storageAuthority = {
          assertCurrent: authority.assertActive,
          authorize: authority.assertActive,
        };
        const memory = await acquireSessionActorStorage(boardSession, {
          authority: storageAuthority,
          lifetime: {
            assertCurrent: authority.assertActive,
            assertReadable: authority.assertActive,
          },
        });
        if (isIncognitoSessionKey(boardSession.sessionKey) && !memory) {
          throw new BoardValidationError("not_found", "board session no longer exists");
        }
        try {
          const { declared: requestDeclared, ...requestWithoutDeclared } = requestParams;
          let content: BoardWidgetMaterializedPutParams["content"];
          let declared = requestDeclared;
          let resolveMcpAppInteraction: (() => Promise<boolean>) | undefined;
          if (requestParams.content.kind === "canvas-doc") {
            if (
              invocation.client?.connect &&
              !operatorScopeSatisfied("operator.read", invocation.client.connect.scopes ?? [])
            ) {
              canvasRead = await retainCanvasWidgetRead(invocation, {
                ...boardSession,
                docId: requestParams.content.docId,
              });
            }
            authority.assertActive();
            if (canvasRead?.pending) {
              respond(
                false,
                undefined,
                errorShape(ErrorCodes.UNAVAILABLE, "Waiting for the widget result.", {
                  retryable: true,
                }),
              );
              return;
            }
            const document = await readCanvasDocumentHtmlSource(requestParams.content.docId);
            authority.assertActive();
            if (document.cspSandbox !== "scripts") {
              throw new BoardValidationError(
                "invalid_operation",
                `canvas document is not script-enabled: ${requestParams.content.docId}`,
              );
            }
            content = { kind: "html", html: document.html };
          } else if (requestParams.content.kind === "mcp-app") {
            requester = await captureGatewayOperatorRunAuthority({
              client: invocation.client,
              context,
              hasCurrentClientAuthority: invocation.hasCurrentClientAuthority,
              invocationAuthority: {
                assertCurrent: boardAuthority.assertActive,
                signal: invocation.signal,
              },
            });
            authority.assertActive();
            const active = await resolveMcpAppActiveView({
              ...boardSession,
              viewId: requestParams.content.viewId,
              cfg: context.getRuntimeConfig(),
              requesterId: requester?.authority.profileId,
            });
            authority.assertActive();
            const { view } = active;
            if (!view.toolCallId) {
              throw new BoardValidationError(
                "invalid_operation",
                "MCP App view is missing its originating tool call",
              );
            }
            // Reconstructed or revoked sources can still be pinned read-only.
            resolveMcpAppInteraction = () => supportsMcpAppInteraction(view);
            let interactive = await resolveMcpAppInteraction();
            authority.assertActive();
            const allowedTools = interactive ? await resolveMcpAppAllowedToolNames(active) : [];
            authority.assertActive();
            if (interactive) {
              interactive = await resolveMcpAppInteraction();
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
          } else {
            content = requestParams.content;
          }
          const persistedContent =
            content.kind === "mcp-app"
              ? { kind: content.kind, descriptor: content.descriptor }
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
            content.kind === "html" &&
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
              ...(resolveMcpAppInteraction ? { resolveMcpAppInteraction } : {}),
              assertCurrent: composeSessionSourceAssertion(
                [identity?.assertSelected ?? authority.assertActive],
                (assertSources) => {
                  assertSources();
                  const cfg = context.getRuntimeConfig();
                  const current = resolveRequestedSessionStoreTarget(
                    cfg,
                    boardSession.sessionKey,
                    boardSession.agentId,
                  );
                  if (!current.ok || current.value.sessionKey !== boardSession.sessionKey) {
                    throw new BoardValidationError(
                      "invalid_operation",
                      "board session changed; retry",
                    );
                  }
                },
              ),
            });
          const putAndApprove = async () => {
            let snapshot = identity ? await identity.start(putWidget) : await putWidget();
            authority.assertActive();
            const widget = snapshot.widgets.find(
              (candidate) => candidate.name === snapshot.resolvedWidgetName,
            );
            if (widget?.grantState === "pending") {
              const source = memory?.actor.storage.readCurrent(
                { type: "session.entry.read", input: { sessionKey: boardSession.sessionKey } },
                memory.authority,
              );
              const assertApprovalCurrent = () => {
                authority.assertActive();
                if (!memory) {
                  return;
                }
                const current = memory.actor.storage.readCurrent(
                  { type: "session.entry.read", input: { sessionKey: boardSession.sessionKey } },
                  memory.authority,
                );
                const fields = [
                  "sessionId",
                  "lifecycleRevision",
                  "sandbox",
                  "sandboxMode",
                  "createdActor",
                  "execHost",
                  "execNode",
                  "permissionMode",
                ] as const;
                if (
                  !source ||
                  !current ||
                  fields.some((field) => !isDeepStrictEqual(current[field], source[field]))
                ) {
                  throw new BoardValidationError(
                    "invalid_operation",
                    "board approval policy changed; retry",
                  );
                }
              };
              const decision = await resolveBoardWidgetApproval({
                cfg: context.getRuntimeConfig(),
                ...boardSession,
                name: snapshot.resolvedWidgetName,
                content: materializedContent,
                declared: declared ?? {},
                ...(memory
                  ? {
                      incognitoSession: {
                        agentId: boardSession.agentId,
                        sessionKey: boardSession.sessionKey,
                        entry: source,
                        assertCurrent: assertApprovalCurrent,
                      },
                    }
                  : {}),
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
                    {
                      assertCurrent: assertApprovalCurrent,
                    },
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
            broadcastBoardChanged(context, boardSession, snapshot, snapshot.resolvedWidgetName);
            respond(true, snapshot);
          };
          await (memory ? runWithSessionActorStorage(memory, putAndApprove) : putAndApprove());
        } finally {
          try {
            await memory?.actor.release();
          } finally {
            canvasRead?.read.release();
            requester?.release();
          }
        }
      },
    ),
    "board.widget.grant": defineBoardMethod(
      "board.widget.grant",
      validateBoardWidgetGrantParams,
      async (invocation) => {
        const { params: boardParams, respond, context } = invocation;
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
        broadcastBoardChanged(context, boardSession, snapshot);
        respond(true, snapshot);
      },
    ),
    "board.widget.appView": defineBoardMethod(
      "board.widget.appView",
      validateBoardWidgetAppViewParams,
      async (invocation) => {
        const { params: boardParams, respond, context } = invocation;
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
        const minted = await mintMcpAppViewFromTranscript({
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
      },
    ),
    "board.event": defineBoardMethod(
      "board.event",
      validateBoardEventParams,
      async (invocation) => {
        const { params: boardParams, respond, context } = invocation;
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
      },
    ),
    "board.prompt.authorize": defineBoardMethod(
      "board.prompt.authorize",
      validateBoardPromptAuthorizeParams,
      async (invocation) => {
        const { params: boardParams, respond, context } = invocation;
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
      },
    ),
    "board.data.read": defineBoardMethod(
      "board.data.read",
      validateBoardDataReadParams,
      async (invocation) => {
        const { params: boardParams, respond } = invocation;
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
      },
    ),
    "board.action": defineBoardMethod(
      "board.action",
      validateBoardActionParams,
      async (invocation) => {
        const { params: boardParams, respond } = invocation;
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
        await runBoardActionVerb(boardParams.action, actionParams, invocation, authority, respond);
      },
    ),
  };
}

export const boardHandlers = createBoardHandlers(boardStore);
