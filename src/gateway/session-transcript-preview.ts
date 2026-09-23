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
import { captureSessionTranscriptTargetBinding } from "../config/sessions/transcript-target-binding.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { buildSessionPreviewItems } from "./session-display-projection.js";
import {
  readBoundedSessionPreviewItems,
  readBoundedSessionPreviewItemsAsync,
} from "./session-transcript-preview-reader.js";
import { toTranscriptReadScope } from "./session-transcript-read-target.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

/** Durable previews share the history reader; incognito SQLite stays with its process owner. */
export async function readSessionPreviewItemsFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
  maxItems: number,
  maxChars: number,
  view: "display" | "model-context" = "display",
): Promise<SessionPreviewItem[]> {
  const target = prepareSessionTranscriptReadTargetCore(scope);
  if (view === "model-context") {
    const { agentId, sessionKey, storePath } = target;
    const sessionId = scope.sessionId;
    if (!agentId || !sessionKey || !storePath) {
      throw new Error("Model-context preview requires an exact session target");
    }
    const modelTarget = captureSessionTranscriptTargetBinding({
      agentId,
      sessionId,
      sessionKey,
      storePath,
      ...(scope.env ? { env: scope.env } : {}),
    });
    return await readBoundedSessionPreviewItemsAsync(maxItems, async (maxEvents, maxBytes) => {
      let truncated = false;
      const manager = await SessionManager.openBoundedAsync(modelTarget, {
        maxEvents,
        maxBytes,
        onTruncated: () => {
          truncated = true;
        },
      });
      return {
        items: buildSessionPreviewItems(
          manager.buildSessionContext().messages,
          maxItems,
          maxChars,
          view,
        ),
        hasOlderEvents: truncated,
      };
    });
  }
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
    return readSessionDisplayPreviewItems(readScope, maxItems, maxChars);
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

function readSessionDisplayPreviewItems(
  scope: SessionTranscriptReadScope,
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  const target = resolveSessionTranscriptReadTarget(scope);
  return readBoundedSessionPreviewItems(maxItems, (maxEvents, maxBytes) => {
    const page = readRecentSessionTranscriptHistoryEvents(toTranscriptReadScope(target), {
      maxBytes,
      maxLines: maxEvents,
      maxMessages: maxEvents,
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
