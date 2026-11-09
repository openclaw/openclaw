import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import { resolveWorkerVisibleHistoryProjection } from "../config/sessions/session-accessor.sqlite-history-projection.worker.js";
import { readRecentSessionTranscriptHistoryEventsFromProjection } from "../config/sessions/session-accessor.sqlite-history-query.js";
import { readCurrentProjectionSnapshot } from "../config/sessions/session-accessor.sqlite-projection-read.js";
import { readWithCanonicalSessionAdmission } from "../config/sessions/session-canonical-key.js";
import {
  SessionTranscriptProjectionUnavailableError,
  SessionTranscriptStorageUnavailableError,
} from "../config/sessions/session-transcript-projection-error.js";
import type { SessionPreviewWorkerInput } from "../config/sessions/session-transcript-worker.types.js";
import type { OpenClawAgentReadOnlyDatabase } from "../state/openclaw-agent-db-readonly-open.js";
import { withScopedOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-scope.js";
import { buildSessionPreviewItems } from "./session-display-projection.js";
import { readBoundedSessionPreviewItems } from "./session-transcript-preview-bounds.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

/** Native and worker display reads share widening, projection, and the older-page boundary. */
function readSessionDisplayPreviewItems(
  maxItems: number,
  maxChars: number,
  readPage: (
    options: Parameters<typeof readRecentSessionTranscriptHistoryEventsFromProjection>[1],
  ) => ReturnType<typeof readRecentSessionTranscriptHistoryEventsFromProjection>,
): SessionPreviewItem[] {
  return readBoundedSessionPreviewItems(maxItems, ({ maxEvents, maxBytes }) => {
    const page = readPage({ maxBytes, maxLines: maxEvents, maxMessages: maxEvents });
    return {
      items: buildSessionPreviewItems(
        page.events.map((entry) => asOptionalRecord(entry.event)?.message),
        maxItems,
        maxChars,
      ),
      hasOlderEvents: page.totalMessages > page.events.length,
      scannedEvents: page.events.length,
    };
  });
}

/** Read the host-prepared target without importing transcript writers or model context. */
export function readSessionPreviewItemsReadOnly(
  { database: databaseTarget, target, env, maxItems, maxChars }: SessionPreviewWorkerInput,
  retainedDatabase?: OpenClawAgentReadOnlyDatabase,
): SessionPreviewItem[] {
  const read = (database: OpenClawAgentReadOnlyDatabase) =>
    readWithCanonicalSessionAdmission(database, () => {
      if (target.entryValidationKey !== undefined) {
        readSessionEntryRow(database, target.entryValidationKey);
      }
      return readSessionDisplayPreviewItems(maxItems, maxChars, (options) => {
        const snapshot = readCurrentProjectionSnapshot(
          database,
          {
            agentId: target.agentId,
            sessionId: target.sessionId,
            sessionKey: target.sessionKey,
            databaseAgentId: databaseTarget.agentId,
            path: databaseTarget.path,
          },
          (projection) => {
            projection.resolveVisibleHistory = resolveWorkerVisibleHistoryProjection;
            return readRecentSessionTranscriptHistoryEventsFromProjection(projection, options);
          },
        );
        if (snapshot.kind === "unavailable") {
          throw new SessionTranscriptProjectionUnavailableError(target.sessionId);
        }
        return snapshot.value;
      });
    });
  if (retainedDatabase) {
    return read(retainedDatabase);
  }
  const result = withScopedOpenClawAgentDatabaseReadOnly(read, {
    ...databaseTarget,
    ...(env ? { env } : {}),
  });
  if (!result.found) {
    throw new SessionTranscriptStorageUnavailableError();
  }
  return result.value;
}
