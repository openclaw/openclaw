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
import { authorizeSessionFacts } from "../config/sessions/session-incognito-admission.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import {
  prepareIncognitoSessionHistoryRead,
  type IncognitoSessionHistoryBinding,
} from "../config/sessions/session-incognito-history-read.js";
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
  incognito?: IncognitoSessionHistoryBinding,
): Promise<SessionPreviewItem[]> {
  if (incognito) {
    const { actor, authority, target } = prepareIncognitoSessionHistoryRead(incognito, scope);
    const claim = actor.sessions.captureCurrent(target.sessionKey);
    const history: typeof actor.sessions.history = (managerAuthority, command, signal, onRead) =>
      actor.sessions.history(
        {
          assertCurrent() {
            managerAuthority.assertCurrent();
            authority.assertCurrent();
          },
          authorize(stage, facts) {
            authorizeSessionFacts(managerAuthority, stage, facts);
            authorizeSessionFacts(authority, stage, facts);
          },
        },
        command,
        signal,
        onRead,
      );
    const modelTarget = captureSessionTranscriptTargetBinding({
      agentId: actor.agentId,
      storePath: actor.path,
      sessionKey: target.sessionKey,
      sessionId: target.sessionId,
      ...(scope.env ? { env: scope.env } : {}),
    });
    return actor.sessions.withSharedState(async () => {
      const items =
        view === "display"
          ? (
              await actor.sessions.history(authority, {
                type: "session.history.preview",
                input: { ...target, maxItems, maxChars },
              })
            ).items
          : await withIncognitoSessionActor(
              { ...actor, sessions: { ...actor.sessions, history } },
              () => readSessionModelPreviewItems(modelTarget, maxItems, maxChars),
            );
      authority.assertCurrent();
      claim.authorize(authority, "commit");
      return items;
    });
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

function readSessionModelPreviewItems(
  target: ReturnType<typeof captureSessionTranscriptTargetBinding>,
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
