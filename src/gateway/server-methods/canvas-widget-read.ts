import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionTranscriptReadScope } from "../../config/sessions/session-accessor.sqlite-contract.js";
import { findTranscriptEvent } from "../../config/sessions/session-transcript-match.js";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import { listAgentRunsForSession, hasLiveAgentRunContext } from "../../infra/agent-run-registry.js";
import { matchesTranscriptEvent } from "../../sessions/transcript-visible-record.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { readSessionMessagesPageWithStatsAsync } from "../session-transcript-readers.js";
import { SOURCE_PAGE_MAX_MESSAGES } from "../session-transcript-source-pages.js";
import { retainSessionScopedRead } from "./session-scoped-read.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export const CANVAS_WIDGET_FORBIDDEN = "You don't have access to this widget in this conversation.";

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

export async function retainCanvasWidgetRead(
  invocation: GatewayRequestHandlerOptions,
  { sessionKey, docId, agentId }: { sessionKey?: string; docId: string; agentId?: string },
) {
  const denied = () =>
    new SessionMutationAuthorizationChangedError(
      errorShape(ErrorCodes.FORBIDDEN, CANVAS_WIDGET_FORBIDDEN),
    );
  if (!sessionKey) {
    throw denied();
  }
  const owner = resolveRequestedSessionAgentId(
    invocation.context.getRuntimeConfig(),
    sessionKey,
    agentId,
  );
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
