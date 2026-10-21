import {
  CANVAS_DOCUMENT_PREVIEW_MAX_BYTES,
  WIDGET_HTML_MAX_UTF8_BYTES,
  type CanvasDocumentViewResult,
  type CanvasDocumentViewParams,
  ErrorCodes,
  errorShape,
  validateCanvasDocumentPreviewParams,
  validateCanvasDocumentViewParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { buildSandboxHostPath } from "../../agents/sandbox-host.js";
import { isCoreCanvasHostEnabled } from "../../canvas/config.js";
import { readCanvasDocumentHtmlSource } from "../../canvas/documents.js";
import type { SessionTranscriptReadScope } from "../../config/sessions/session-accessor.sqlite-contract.js";
import { findTranscriptEvent } from "../../config/sessions/session-transcript-match.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  SessionTranscriptProjectionUnavailableError,
} from "../../config/sessions/session-transcript-projection-error.js";
import { listAgentRunsForSession, hasLiveAgentRunContext } from "../../infra/agent-run-registry.js";
import { isGatewaySubordinateWorkAdmissionClosed } from "../../process/gateway-work-admission.js";
import { matchesTranscriptEvent } from "../../sessions/transcript-visible-record.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import { buildBoardWidgetSandboxPath } from "../board-sandbox.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { readSessionMessagesPageWithStatsAsync } from "../session-transcript-readers.js";
import { SOURCE_PAGE_MAX_MESSAGES } from "../session-transcript-source-pages.js";
import { retainSessionScopedRead } from "./session-scoped-read.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

const CANVAS_WIDGET_UNAVAILABLE =
  "Canvas widget unavailable; reload the chat or ask the agent to recreate it.";
const CANVAS_PREVIEW_UNAVAILABLE =
  "Canvas preview unavailable; reload the file preview and try again.";
const CANVAS_WIDGET_FORBIDDEN = "You don't have access to this widget in this conversation.";

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

async function hasArchivedWidgetReceipt(
  scope: SessionTranscriptReadScope,
  docId: string,
  assertCurrent: () => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const options = { offset: 0, maxMessages: 0, allowResetArchiveFallback: true, readOnly: true };
  // The history owner selects legacy archives only when native displayed history is empty.
  const archive = await readSessionMessagesPageWithStatsAsync(scope, options, signal);
  assertCurrent();
  if (archive.transcriptSource !== "reset-archive") {
    return false;
  }
  for (let offset = 0; offset < archive.totalMessages; offset += SOURCE_PAGE_MAX_MESSAGES) {
    const page = await readSessionMessagesPageWithStatsAsync(
      scope,
      { ...options, offset, maxMessages: SOURCE_PAGE_MAX_MESSAGES },
      signal,
    );
    assertCurrent();
    if (page.transcriptSource !== "reset-archive" || page.displaySource !== archive.displaySource) {
      throw new SessionTranscriptProjectionUnavailableError(scope.sessionId, "window-changed");
    }
    if (
      page.transcriptEvents?.some((event) =>
        matchesTranscriptEvent(event, { kind: "canvas-widget", docId }),
      )
    ) {
      return true;
    }
  }
  return false;
}

async function retainWidgetRead(
  invocation: GatewayRequestHandlerOptions & { params: CanvasDocumentViewParams },
) {
  const { sessionKey, docId } = invocation.params;
  const denied = () =>
    new SessionMutationAuthorizationChangedError(
      errorShape(ErrorCodes.FORBIDDEN, CANVAS_WIDGET_FORBIDDEN),
    );
  if (!sessionKey) {
    throw denied();
  }
  const owner = resolveRequestedSessionAgentId(invocation.context.getRuntimeConfig(), sessionKey);
  if (!owner.ok) {
    throw denied();
  }
  const read = await retainSessionScopedRead(invocation, sessionKey, owner.agentId, {
    requireMaterialized: true,
    allowMetadataChanges: true,
    retain: true,
  });
  if (!read) {
    throw denied();
  }
  try {
    const source = read.prepared;
    const scope: SessionTranscriptReadScope = {
      agentId: source.readSource?.agentId ?? source.agentId,
      storePath: source.readSource?.path ?? source.storePath,
      sessionKey: source.canonicalKey,
      sessionId: source.entry!.sessionId,
      sessionEntry: source.entry,
    };
    const found = await findTranscriptEvent(
      scope,
      { kind: "canvas-widget", docId },
      invocation.signal,
    );
    read.assertCurrent();
    if (
      found ||
      (await hasArchivedWidgetReceipt(scope, docId, read.assertCurrent, invocation.signal))
    ) {
      return { read, pending: false };
    }
    // Tool output can precede its ordered transcript commit while parallel peers run.
    // Live presentation only permits waiting; the saved receipt alone grants the read.
    const pending = listAgentRunsForSession({
      sessionKey: source.canonicalKey,
      sessionId: source.entry!.sessionId,
    }).some(({ runId }) => {
      if (!hasLiveAgentRunContext(runId)) {
        return false;
      }
      const state = invocation.context.chatRunState;
      const registration = state.registry.peek(runId);
      const clientRunId =
        registration?.sessionKey === source.canonicalKey ? registration.clientRunId : runId;
      const run = state.runs.get(clientRunId);
      return (
        run?.bufferIsCurrent?.() !== false &&
        run?.canvasBlocks?.some(
          ({ preview }) => preview.surface === "assistant_message" && preview.viewId === docId,
        )
      );
    });
    if (!pending) {
      throw denied();
    }
    return { read, pending: true };
  } catch (error) {
    read.release();
    throw error;
  }
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
      let retained: Awaited<ReturnType<typeof retainWidgetRead>> | undefined;
      try {
        if (!operatorScopeSatisfied("operator.read", invocation.client?.connect.scopes ?? [])) {
          retained = await retainWidgetRead(invocation);
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
        invocation.respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "invalid canvas.document.preview params: html must not exceed 2 MiB of UTF-8 data",
          ),
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
