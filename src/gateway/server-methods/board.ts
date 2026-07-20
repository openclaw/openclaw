import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type BoardEventParams,
  type BoardWidgetAppViewParams,
  type BoardUpdateParams,
  type BoardWidgetGrantParams,
  type BoardWidgetMaterializedPutParams,
  type BoardWidgetPutParams,
  validateBoardEventParams,
  validateBoardGetParams,
  validateBoardUpdateParams,
  validateBoardWidgetContent,
  validateBoardWidgetAppViewParams,
  validateBoardWidgetGrantParams,
  validateBoardWidgetPutParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { BoardValidationError } from "../../boards/board-layout.js";
import { appendBoardEventNotice, BoardEventPayloadError } from "../../boards/board-notices.js";
import type { BoardStore } from "../../boards/board-store.js";
import { readCanvasDocumentHtmlSource } from "../../canvas/documents.js";
import { boardStore } from "../board-store.js";
import { buildBoardWidgetFrameUrl, createBoardViewTicket } from "../board-view-ticket.js";
import { resolveMcpAppActiveView, resolveMcpAppAllowedToolNames } from "../mcp-app-operations.js";
import { mintMcpAppViewFromTranscript } from "../mcp-app-reconstruction.js";
import type { GatewayRequestHandlers } from "./types.js";

type NoticeAppender = typeof appendBoardEventNotice;
type CanvasDocumentReader = typeof readCanvasDocumentHtmlSource;
type McpAppDependencies = {
  resolveActiveView: typeof resolveMcpAppActiveView;
  resolveAllowedToolNames: typeof resolveMcpAppAllowedToolNames;
  mintFromTranscript: typeof mintMcpAppViewFromTranscript;
};

const defaultMcpAppDependencies: McpAppDependencies = {
  resolveActiveView: resolveMcpAppActiveView,
  resolveAllowedToolNames: resolveMcpAppAllowedToolNames,
  mintFromTranscript: mintMcpAppViewFromTranscript,
};

function invalidParams(
  method: string,
  errors: unknown,
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(errors as never)}`,
    ),
  );
}

function respondBoardError(
  error: unknown,
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
): void {
  if (error instanceof BoardValidationError || error instanceof BoardEventPayloadError) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    return;
  }
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
}

export function createBoardHandlers(
  store: BoardStore,
  appendNotice: NoticeAppender = appendBoardEventNotice,
  readCanvasDocument: CanvasDocumentReader = readCanvasDocumentHtmlSource,
  mcpApp: McpAppDependencies = defaultMcpAppDependencies,
): GatewayRequestHandlers {
  return {
    "board.get": ({ params, respond }) => {
      if (!validateBoardGetParams(params)) {
        invalidParams("board.get", validateBoardGetParams.errors, respond);
        return;
      }
      const snapshot = store.getSnapshot(params.sessionKey);
      for (const widget of snapshot.widgets) {
        if (widget.grantState !== "none" && widget.grantState !== "granted") {
          continue;
        }
        const document = store.readWidgetHtml(snapshot.sessionKey, widget.name);
        if (!document || !("html" in document) || document.revision !== widget.revision) {
          continue;
        }
        const { ticket } = createBoardViewTicket({
          sessionKey: snapshot.sessionKey,
          name: widget.name,
          revision: widget.revision,
          viewGeneration: document.viewGeneration,
        });
        widget.frameUrl = buildBoardWidgetFrameUrl({
          sessionKey: snapshot.sessionKey,
          name: widget.name,
          ticket,
        });
      }
      respond(true, snapshot);
    },
    "board.update": ({ params, respond, context }) => {
      if (!validateBoardUpdateParams(params)) {
        invalidParams("board.update", validateBoardUpdateParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardUpdateParams;
        const snapshot = store.applyOps(boardParams.sessionKey, boardParams.ops);
        if (boardParams.ops.length > 0) {
          context.broadcast("board.changed", {
            sessionKey: snapshot.sessionKey,
            revision: snapshot.revision,
          });
        }
        respond(true, snapshot);
      } catch (error) {
        respondBoardError(error, respond);
      }
    },
    "board.widget.put": async ({ params, respond, context }) => {
      if (!validateBoardWidgetPutParams(params)) {
        invalidParams("board.widget.put", validateBoardWidgetPutParams.errors, respond);
        return;
      }
      try {
        const requestParams = params as BoardWidgetPutParams;
        const boardSessionKey = store.getSnapshot(requestParams.sessionKey).sessionKey;
        const { declared: requestDeclared, ...requestWithoutDeclared } = requestParams;
        let content: BoardWidgetMaterializedPutParams["content"];
        let declared = requestDeclared;
        if (requestParams.content.kind === "canvas-doc") {
          const document = await readCanvasDocument(requestParams.content.docId);
          if (document.cspSandbox !== "scripts") {
            throw new BoardValidationError(
              "invalid_operation",
              `canvas document is not script-enabled: ${requestParams.content.docId}`,
            );
          }
          content = { kind: "html", html: document.html };
        } else if (requestParams.content.kind === "mcp-app") {
          const descriptor = requestParams.content.descriptor;
          const originSessionKey = store.getSnapshot(descriptor.originSessionKey).sessionKey;
          if (originSessionKey !== boardSessionKey) {
            throw new BoardValidationError(
              "invalid_operation",
              "MCP App widgets can only be pinned to their originating session board",
            );
          }
          const active = await mcpApp.resolveActiveView({
            sessionKey: originSessionKey,
            viewId: descriptor.viewId,
            cfg: context.getRuntimeConfig(),
          });
          const { view } = active;
          if (
            view.serverName !== descriptor.serverName ||
            view.toolName !== descriptor.toolName ||
            view.uiResourceUri !== descriptor.uiResourceUri ||
            view.toolCallId !== descriptor.toolCallId
          ) {
            throw new BoardValidationError(
              "invalid_operation",
              "MCP App pin descriptor does not match the active view",
            );
          }
          const allowedTools = await mcpApp.resolveAllowedToolNames(active);
          content = {
            kind: "mcp-app",
            descriptor: {
              serverName: descriptor.serverName,
              toolName: descriptor.toolName,
              uiResourceUri: descriptor.uiResourceUri,
              originSessionKey,
              toolCallId: descriptor.toolCallId,
            },
          };
          declared = allowedTools.length > 0 ? { tools: allowedTools } : undefined;
        } else {
          content = requestParams.content;
        }
        if (!validateBoardWidgetContent(content)) {
          invalidParams("board.widget.put content", validateBoardWidgetContent.errors, respond);
          return;
        }
        const boardParams: BoardWidgetMaterializedPutParams = {
          ...requestWithoutDeclared,
          sessionKey: boardSessionKey,
          content,
          ...(declared ? { declared } : {}),
        };
        const snapshot = store.putWidget(boardParams);
        context.broadcast("board.changed", {
          sessionKey: snapshot.sessionKey,
          revision: snapshot.revision,
          widget: boardParams.name,
        });
        respond(true, snapshot);
      } catch (error) {
        respondBoardError(error, respond);
      }
    },
    "board.widget.grant": ({ params, respond, context }) => {
      if (!validateBoardWidgetGrantParams(params)) {
        invalidParams("board.widget.grant", validateBoardWidgetGrantParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardWidgetGrantParams;
        const snapshot = store.grant(
          boardParams.sessionKey,
          boardParams.name,
          boardParams.decision,
          boardParams.revision,
          boardParams.instanceId,
        );
        context.broadcast("board.changed", {
          sessionKey: snapshot.sessionKey,
          revision: snapshot.revision,
        });
        respond(true, snapshot);
      } catch (error) {
        respondBoardError(error, respond);
      }
    },
    "board.widget.appView": async ({ params, respond, context }) => {
      if (!validateBoardWidgetAppViewParams(params)) {
        invalidParams("board.widget.appView", validateBoardWidgetAppViewParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardWidgetAppViewParams;
        const snapshot = store.getSnapshot(boardParams.sessionKey);
        const widget = snapshot.widgets.find((candidate) => candidate.name === boardParams.name);
        const document = store.readWidgetMcpApp(snapshot.sessionKey, boardParams.name);
        if (
          !widget ||
          widget.contentKind !== "mcp-app" ||
          !document ||
          document.revision !== widget.revision ||
          document.revision !== boardParams.revision ||
          widget.instanceId !== boardParams.instanceId
        ) {
          throw new BoardValidationError(
            "not_found",
            `board MCP App widget not found: ${boardParams.name}`,
          );
        }
        const originSessionKey = store.getSnapshot(document.descriptor.originSessionKey).sessionKey;
        if (originSessionKey !== snapshot.sessionKey) {
          throw new BoardValidationError(
            "invalid_operation",
            "Pinned MCP App source does not belong to this board session",
          );
        }
        // Pins created before server-side source validation have no generation and stay read-only.
        const sourceValidated =
          Boolean(document.grantGeneration) && document.grantGeneration === widget.instanceId;
        const requiresToolGrant = document.declaredTools.length > 0;
        const interactive =
          sourceValidated && (!requiresToolGrant || document.grantState === "granted");
        const minted = await mcpApp.mintFromTranscript({
          cfg: context.getRuntimeConfig(),
          sessionKey: originSessionKey,
          descriptor: { ...document.descriptor, originSessionKey },
          allowedAppToolNames: new Set(interactive ? document.declaredTools : []),
          ...(interactive && requiresToolGrant
            ? {
                authorizeAppToolCall: () => {
                  const current = store.readWidgetMcpApp(snapshot.sessionKey, boardParams.name);
                  return (
                    current?.revision === document.revision &&
                    current.grantState === "granted" &&
                    current.grantGeneration === document.grantGeneration
                  );
                },
              }
            : {}),
          readOnly: !interactive,
        });
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
    "board.event": ({ params, respond }) => {
      if (!validateBoardEventParams(params)) {
        invalidParams("board.event", validateBoardEventParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardEventParams;
        const snapshot = store.getSnapshot(boardParams.sessionKey);
        const widget = snapshot.widgets.some((candidate) => candidate.name === boardParams.widget);
        if (!widget) {
          throw new BoardValidationError(
            "not_found",
            `board widget not found: ${boardParams.widget}`,
          );
        }
        const appended = appendNotice({
          sessionKey: snapshot.sessionKey,
          widget: boardParams.widget,
          payload: boardParams.payload,
        });
        respond(true, { ok: true, appended });
      } catch (error) {
        respondBoardError(error, respond);
      }
    },
  };
}

export const boardHandlers = createBoardHandlers(boardStore);
