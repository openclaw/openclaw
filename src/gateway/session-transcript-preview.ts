import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { SessionManager } from "../agents/sessions/session-manager.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.js";
import { readRecentSessionTranscriptHistoryEvents } from "../config/sessions/session-accessor.sqlite-history-events.js";
import {
  resolveSqliteScope,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { prepareSessionTranscriptReadTargetCore } from "../config/sessions/session-accessor.transcript-read-target.js";
import { resolveSessionTranscriptReadTarget } from "../config/sessions/session-accessor.transcript-target.js";
import { isSessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { resolveSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { startSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { buildSessionPreviewItems } from "./session-display-projection.js";
import { readBoundedSessionPreviewItems } from "./session-transcript-preview-reader.js";
import { toTranscriptReadScope } from "./session-transcript-read-target.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

/** Durable previews share the history reader; incognito SQLite stays with its process owner. */
export async function readSessionPreviewItemsFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
  maxItems: number,
  maxChars: number,
): Promise<SessionPreviewItem[]> {
  const target = prepareSessionTranscriptReadTargetCore(scope);
  const readScope: SessionTranscriptReadScope = {
    agentId: target.agentId,
    sessionId: scope.sessionId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
    ...(scope.env ? { env: scope.env } : {}),
    ...(scope.sessionEntry ? { sessionEntry: { sessionId: scope.sessionEntry.sessionId } } : {}),
  };
  const resolved = resolveSqliteTranscriptReadScope(readScope);
  const options = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  if (isIncognitoOpenClawAgentSqlitePath(databasePath, options)) {
    return readSessionPreviewItemsFromTranscript(readScope, maxItems, maxChars);
  }
  // Qualify the key with the bound logical agent without discovering the physical store again.
  const entryValidationKey = target.entryValidationScope
    ? resolveSqliteScope({
        agentId: resolved.agentId,
        sessionKey: target.entryValidationScope.sessionKey,
      }).sessionKey
    : undefined;
  const admission = resolveSessionTranscriptReadFence(resolved);
  const { withSessionHistoryWorkerDatabase } =
    await import("../config/sessions/session-transcript-worker-runtime.js");
  try {
    return await withSessionHistoryWorkerDatabase(options, (owner) =>
      owner.readPreview({
        target: {
          agentId: resolved.agentId,
          sessionId: resolved.sessionId,
          sessionKey: entryValidationKey ?? resolved.sessionKey,
          ...(entryValidationKey !== undefined ? { entryValidationKey } : {}),
        },
        ...(scope.env ? { env: scope.env } : {}),
        maxItems,
        maxChars,
        ...(admission ? { admission: { ...admission } } : {}),
      }),
    );
  } catch (error) {
    if (isSessionTranscriptProjectionUnavailableError(error)) {
      startSessionTranscriptIndexReconcile({ ...options, preferredSessionId: resolved.sessionId });
    }
    throw error;
  }
}

/** Reads a bounded display or canonical model-context preview before discarding metadata. */
export function readSessionPreviewItemsFromTranscript(
  scope: SessionTranscriptReadScope,
  maxItems: number,
  maxChars: number,
  view: "display" | "model-context" = "display",
  options: { readOnly?: boolean } = {},
): SessionPreviewItem[] {
  const target = resolveSessionTranscriptReadTarget(scope);
  return readBoundedSessionPreviewItems(maxItems, (maxEvents, maxBytes) => {
    if (view === "model-context") {
      const { agentId, sessionId, sessionKey, storePath } = target;
      if (!agentId || !sessionKey || !storePath) {
        throw new Error("Model-context preview requires an exact session target");
      }
      let truncated = false;
      const manager = SessionManager.openBounded(
        { agentId, sessionId, sessionKey, storePath },
        {
          maxEvents,
          maxBytes,
          onTruncated: () => {
            truncated = true;
          },
        },
      );
      return {
        items: buildSessionPreviewItems(
          manager.buildSessionContext().messages,
          maxItems,
          maxChars,
          view,
        ),
        hasOlderEvents: truncated,
      };
    }
    const page = readRecentSessionTranscriptHistoryEvents(toTranscriptReadScope(target), {
      maxBytes,
      maxLines: maxEvents,
      maxMessages: maxEvents,
      ...options,
    });
    return {
      items: buildSessionPreviewItems(
        page.events.map((entry) => asOptionalRecord(entry.event)?.message),
        maxItems,
        maxChars,
      ),
      hasOlderEvents: page.totalMessages > page.events.length,
    };
  });
}
