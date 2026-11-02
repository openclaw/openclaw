import {
  CANVAS_DOCUMENT_PREVIEW_MAX_BYTES,
  WIDGET_HTML_MAX_UTF8_BYTES,
  type CanvasDocumentViewResult,
  ErrorCodes,
  errorShape,
  validateCanvasDocumentPreviewParams,
  validateCanvasDocumentViewParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { buildSandboxHostPath } from "../../agents/sandbox-host.js";
import { isCoreCanvasHostEnabled } from "../../canvas/config.js";
import { readCanvasDocumentHtmlSource } from "../../canvas/documents.js";
import { isSessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import { isGatewaySubordinateWorkAdmissionClosed } from "../../process/gateway-work-admission.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import { buildBoardWidgetSandboxPath } from "../board-sandbox.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { CANVAS_WIDGET_FORBIDDEN, retainCanvasWidgetRead } from "./canvas-widget-read.js";
import { respondError } from "./response.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

const CANVAS_WIDGET_UNAVAILABLE =
  "Canvas widget unavailable; reload the chat or ask the agent to recreate it.";
const CANVAS_PREVIEW_UNAVAILABLE =
  "Canvas preview unavailable; reload the file preview and try again.";

function canvasReadError(error: unknown, unavailableMessage: string) {
  if (error instanceof SessionMutationAuthorizationChangedError) {
    return errorShape(ErrorCodes.FORBIDDEN, CANVAS_WIDGET_FORBIDDEN);
  }
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    unavailableMessage,
    isSessionTranscriptProjectionUnavailableError(error) ? { retryable: true } : undefined,
  );
}

/** Both stored widgets and caller-owned previews use the same live isolated host. */
async function respondWithCanvasHtml(
  invocation: GatewayRequestHandlerOptions,
  readHtml: () => string | Promise<string>,
  unavailableMessage: string,
  sandboxUrl: string,
  assertReadCurrent?: () => void,
): Promise<void> {
  const { context, client, respond } = invocation;
  const resolveContext = context.resolveGatewayContext;
  const methodRegistry = context.getGatewayMethodRegistry?.();
  const assertActive = () => {
    invocation.signal?.throwIfAborted();
    invocation.sessionMutationCommitGuard?.();
    assertReadCurrent?.();
    if (
      !resolveContext ||
      resolveContext() !== context ||
      context.resolveGatewayContext !== resolveContext ||
      context.getGatewayMethodRegistry?.() !== methodRegistry ||
      client?.invalidated === true ||
      (client?.connId && context.isConnectionActive?.(client.connId) === false) ||
      isGatewaySubordinateWorkAdmissionClosed() ||
      !isCoreCanvasHostEnabled(context.getRuntimeConfig())
    ) {
      throw new Error(unavailableMessage);
    }
  };
  try {
    assertActive();
    const [html, sandboxPort] = await Promise.all([
      readHtml(),
      context.getMcpAppSandboxPort?.() ?? context.ensureSandboxHostPort?.(),
    ]);
    // The bytes and listener must still belong to the admitted caller and Gateway.
    assertActive();
    if (sandboxPort === undefined) {
      throw new Error(unavailableMessage);
    }
    const ingress = client?.remoteControlUiIngress;
    const configuredOrigin =
      ingress?.sandboxOrigin ?? context.getRuntimeConfig().mcp?.apps?.sandboxOrigin;
    const result: CanvasDocumentViewResult = {
      html,
      sandboxUrl: ingress ? new URL(sandboxUrl, ingress.sandboxOrigin).href : sandboxUrl,
      sandboxPort,
      ...(configuredOrigin ? { sandboxOrigin: new URL(configuredOrigin).origin } : {}),
    };
    respond(true, result);
  } catch (error) {
    respond(false, undefined, canvasReadError(error, unavailableMessage));
  }
}

export const canvasHandlers: GatewayRequestHandlers = {
  "canvas.document.view": defineValidatedGatewayMethod(
    "canvas.document.view",
    validateCanvasDocumentViewParams,
    async (invocation) => {
      let retained: Awaited<ReturnType<typeof retainCanvasWidgetRead>> | undefined;
      try {
        if (!operatorScopeSatisfied("operator.read", invocation.client?.connect.scopes ?? [])) {
          retained = await retainCanvasWidgetRead(invocation, invocation.params);
        }
        if (retained?.pending) {
          invocation.respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "Waiting for the widget result.", {
              retryable: true,
              details: { type: "canvas_widget_pending" },
            }),
          );
          return;
        }
        await respondWithCanvasHtml(
          invocation,
          async () => {
            const document = await readCanvasDocumentHtmlSource(invocation.params.docId);
            if (
              document.cspSandbox !== "scripts" ||
              Buffer.byteLength(document.html, "utf8") > WIDGET_HTML_MAX_UTF8_BYTES
            ) {
              throw new Error(CANVAS_WIDGET_UNAVAILABLE);
            }
            return document.html;
          },
          CANVAS_WIDGET_UNAVAILABLE,
          buildBoardWidgetSandboxPath({ grantState: "none" }),
          retained?.read.assertCurrent,
        );
      } catch (error) {
        invocation.respond(false, undefined, canvasReadError(error, CANVAS_WIDGET_UNAVAILABLE));
      } finally {
        retained?.read.release();
      }
    },
  ),
  "canvas.document.preview": defineValidatedGatewayMethod(
    "canvas.document.preview",
    validateCanvasDocumentPreviewParams,
    async (invocation) => {
      const { html } = invocation.params;
      // JSON Schema limits characters; the file-preview contract limits UTF-8 bytes.
      if (Buffer.byteLength(html, "utf8") > CANVAS_DOCUMENT_PREVIEW_MAX_BYTES) {
        respondError(
          invocation.respond,
          ErrorCodes.INVALID_REQUEST,
          "invalid canvas.document.preview params: html must not exceed 2 MiB of UTF-8 data",
        );
        return;
      }
      await respondWithCanvasHtml(
        invocation,
        () => html,
        CANVAS_PREVIEW_UNAVAILABLE,
        buildSandboxHostPath({ blockDescendantFrames: true }),
      );
    },
  ),
};
