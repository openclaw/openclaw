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
import type { OpenClawAgentReadOnlyDatabase } from "../state/openclaw-agent-db-readonly-open.js";
import { withScopedOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-scope.js";
import { buildSessionPreviewItems } from "./session-display-projection.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

type PreviewPage = { items: SessionPreviewItem[]; hasOlderEvents: boolean };

function previewReadLimits(maxItems: number) {
  // Tool-only and suppressed rows need headroom; keep recovery bounded too.
  const initialMaxEvents = Math.min(256, Math.max(64, Math.ceil(maxItems) * 4));
  return [
    { maxEvents: initialMaxEvents, maxBytes: 1024 * 1024 },
    {
      maxEvents: Math.min(2048, Math.max(1024, initialMaxEvents * 8, Math.ceil(maxItems))),
      maxBytes: 8 * 1024 * 1024,
    },
  ];
}

export async function readBoundedSessionPreviewItemsAsync(
  maxItems: number,
  readPage: (maxEvents: number, maxBytes: number) => Promise<PreviewPage>,
): Promise<SessionPreviewItem[]> {
  let items: SessionPreviewItem[] = [];
  for (const { maxEvents, maxBytes } of previewReadLimits(maxItems)) {
    const page = await readPage(maxEvents, maxBytes);
    items = page.items;
    if (items.length >= maxItems || !page.hasOlderEvents) {
      break;
    }
  }
  return items;
}

/** Native and worker display reads share widening, projection, and the older-page boundary. */
export function readSessionDisplayPreviewItems(
  maxItems: number,
  maxChars: number,
  readPage: (
    options: Parameters<typeof readRecentSessionTranscriptHistoryEventsFromProjection>[1],
  ) => ReturnType<typeof readRecentSessionTranscriptHistoryEventsFromProjection>,
): SessionPreviewItem[] {
  let items: SessionPreviewItem[] = [];
  for (const { maxEvents, maxBytes } of previewReadLimits(maxItems)) {
    const page = readPage({ maxBytes, maxLines: maxEvents, maxMessages: maxEvents });
    items = buildSessionPreviewItems(
      page.events.map((entry) => asOptionalRecord(entry.event)?.message),
      maxItems,
      maxChars,
    );
    const hasOlderEvents = page.totalMessages > page.events.length;
    if (items.length >= maxItems || !hasOlderEvents) {
      break;
    }
  }
  return items;
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
          (projection) =>
            readRecentSessionTranscriptHistoryEventsFromProjection(projection, options),
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
