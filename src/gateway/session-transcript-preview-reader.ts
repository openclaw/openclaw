import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import { readRecentSessionTranscriptHistoryEventsFromProjection } from "../config/sessions/session-accessor.sqlite-history-query.js";
import { readCurrentProjectionSnapshot } from "../config/sessions/session-accessor.sqlite-projection-read.js";
import { readWithCanonicalSessionAdmission } from "../config/sessions/session-canonical-key.js";
import {
  SessionTranscriptProjectionUnavailableError,
  SessionTranscriptStorageUnavailableError,
} from "../config/sessions/session-transcript-projection-error.js";
import type { SessionPreviewWorkerInput } from "../config/sessions/session-transcript-worker.types.js";
import { withScopedOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-scope.js";
import { buildSessionPreviewItems } from "./session-display-projection.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

/** Share the same bounded widening for display and canonical model-context previews. */
export function readBoundedSessionPreviewItems(
  maxItems: number,
  readPage: (
    maxEvents: number,
    maxBytes: number,
  ) => { items: SessionPreviewItem[]; hasOlderEvents: boolean },
): SessionPreviewItem[] {
  // Tool-only and suppressed rows need headroom; cap even the recovery scan so previews
  // never materialize an entire large transcript or monopolize the Gateway thread.
  const initialMaxEvents = Math.min(256, Math.max(64, Math.ceil(maxItems) * 4));
  const preview = readPage(initialMaxEvents, 1024 * 1024);
  if (preview.items.length >= maxItems || !preview.hasOlderEvents) {
    return preview.items;
  }
  const recoveryMaxEvents = Math.min(
    2048,
    Math.max(1024, initialMaxEvents * 8, Math.ceil(maxItems)),
  );
  return readPage(recoveryMaxEvents, 8 * 1024 * 1024).items;
}

/** Read the host-prepared target without importing transcript writers or model context. */
export function readSessionPreviewItemsReadOnly({
  database: databaseTarget,
  target,
  env,
  maxItems,
  maxChars,
}: SessionPreviewWorkerInput): SessionPreviewItem[] {
  const result = withScopedOpenClawAgentDatabaseReadOnly(
    (database) =>
      readWithCanonicalSessionAdmission(database, () => {
        if (target.entryValidationKey !== undefined) {
          readSessionEntryRow(database, target.entryValidationKey);
        }
        return readBoundedSessionPreviewItems(maxItems, (maxEvents, maxBytes) => {
          const snapshot = readCurrentProjectionSnapshot(
            database,
            {
              agentId: target.agentId,
              sessionId: target.sessionId,
              sessionKey: target.sessionKey,
              databaseAgentId: databaseTarget.agentId,
              path: databaseTarget.path,
            },
            (projection) =>
              readRecentSessionTranscriptHistoryEventsFromProjection(projection, {
                maxBytes,
                maxLines: maxEvents,
                maxMessages: maxEvents,
              }),
          );
          if (snapshot.kind === "unavailable") {
            throw new SessionTranscriptProjectionUnavailableError(target.sessionId);
          }
          const page = snapshot.value;
          return {
            items: buildSessionPreviewItems(
              page.events.map((entry) => asOptionalRecord(entry.event)?.message),
              maxItems,
              maxChars,
            ),
            hasOlderEvents: page.totalMessages > page.events.length,
          };
        });
      }),
    { ...databaseTarget, ...(env ? { env } : {}) },
  );
  if (!result.found) {
    throw new SessionTranscriptStorageUnavailableError();
  }
  return result.value;
}
