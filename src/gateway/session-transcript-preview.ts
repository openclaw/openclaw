import { SessionManager } from "../agents/sessions/session-manager.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { prepareSessionTranscriptReadTargetCore } from "../config/sessions/session-accessor.transcript-read-target.js";
import { captureSessionActorTranscriptRead } from "../config/sessions/session-actor-transcript-read.js";
import { isSessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { resolveSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { startSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import {
  captureSessionTranscriptTargetBinding,
  type CapturedSessionTranscriptTargetBinding,
} from "../config/sessions/transcript-target-binding.js";
import { buildSessionPreviewItems } from "./session-display-projection.js";
import { readBoundedSessionPreviewItemsAsync } from "./session-transcript-preview-reader.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

/** Previews use the selected history backend and retain the existing model-context projection. */
export async function readSessionPreviewItemsFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
  maxItems: number,
  maxChars: number,
  view: "display" | "model-context" = "display",
): Promise<SessionPreviewItem[]> {
  const memory = captureSessionActorTranscriptRead(scope);
  if (memory) {
    if (memory.missing) {
      return [];
    }
    return view === "display"
      ? (await memory.read("session.history.preview", { maxItems, maxChars })).items
      : readSessionModelPreviewItems(memory.target, maxItems, maxChars);
  }
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
    return readSessionModelPreviewItems(modelTarget, maxItems, maxChars);
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

function readSessionModelPreviewItems(
  target: CapturedSessionTranscriptTargetBinding,
  maxItems: number,
  maxChars: number,
): Promise<SessionPreviewItem[]> {
  return readBoundedSessionPreviewItemsAsync(maxItems, async (maxEvents, maxBytes) => {
    let truncated = false;
    const manager = await SessionManager.openBoundedAsync(target, {
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
        "model-context",
      ),
      hasOlderEvents: truncated,
    };
  });
}
