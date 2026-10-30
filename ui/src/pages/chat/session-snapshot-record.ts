import { readSessionMessageSequence } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { removePairingQrContent } from "../../lib/chat/pairing-qr.ts";
import {
  MAX_CHAT_THUMBNAILS,
  MAX_CHAT_THUMBNAIL_BYTES,
  avatarSourcesSchema,
  boundChatThumbnails,
  chatThumbnailWeight,
  projectChatRowDisplay,
  rowDisplaySchema,
} from "../../lib/chat/row-display-facts.ts";
import {
  isChatTranscriptMetadata,
  isProgressCard,
  isMessageReactionSummary,
} from "../../lib/protocol-validators.generated/transcript.js";
import * as json from "../../lib/snapshot-json.ts";
import {
  chatHeaderSharingSnapshotSchema,
  chatHeaderViewersSnapshotSchema,
} from "./chat-header-viewers-snapshot.ts";
import { trimmedChatHistoryPagination } from "./chat-history-pagination.ts";
import { projectChatMessageReactions } from "./chat-message-reactions-snapshot.ts";
import { chatSessionStateSnapshotSchema } from "./chat-session-state-snapshot.ts";
import { detailsSnapshotSchema } from "./session-details-snapshot-schema.ts";
import type { ChatSessionSnapshot } from "./session-message-cache.ts";
import {
  loadChatHistoryStateValidator,
  prewarmedHistoryStateValidator,
} from "./session-snapshot-prewarm.ts";
import { readLiveTerminalRunId } from "./terminal-message-identity.ts";

const nonnegative = json.refine(json.number, (value) => value >= 0);
const sessionKeySchema = json.refine(json.text, (value) => value.length > 0);
const completePaginationSchema = json.object(
  {
    completeSnapshot: json.optional(json.literal(true)),
    hasMore: json.literal(false),
    totalMessages: json.optional(nonnegative),
  },
  true,
);
const morePaginationSchema = json.object(
  {
    hasMore: json.literal(true),
    nextOffset: json.optional(nonnegative),
    olderCursor: json.optional(json.refine(json.text, (value) => value.length > 0)),
    needsBoundary: json.optional(json.literal(true)),
    totalMessages: json.optional(nonnegative),
  },
  true,
);
const paginationSchema = {
  parse(value: unknown) {
    return asOptionalRecord(value)?.hasMore === true
      ? morePaginationSchema.parse(value)
      : completePaginationSchema.parse(value);
  },
};
const permissionModeSchema = json.enumeration(["read-only", "guarded", "workspace", "full"]);
const snapshotSchema = json.object(
  {
    sessionState: json.optional(chatSessionStateSnapshotSchema),
    details: detailsSnapshotSchema,
    headerViewers: json.optional(chatHeaderViewersSnapshotSchema),
    headerSharing: json.optional(json.nullable(chatHeaderSharingSnapshotSchema)),
    rowDisplay: json.optional(rowDisplaySchema),
    avatarSources: json.optional(avatarSourcesSchema),
    composer: json.optional(
      json.nullable(
        json.object({
          id: json.text,
          provider: json.text,
          name: json.text,
          reasoning: json.optional(json.boolean),
          speed: json.optional(
            json.object({
              active: json.boolean,
              currentOverride: json.enumeration(["", "on", "off", "auto", "ultrafast"]),
              label: json.text,
              supported: json.boolean,
            }),
          ),
          thinkingLevel: json.optional(json.text),
          thinkingDefault: json.optional(json.text),
          thinkingLevels: json.optional(
            json.array(json.object({ id: json.text, label: json.text }), 30),
          ),
          permissionMode: json.optional(permissionModeSchema),
          defaultPermissionMode: json.optional(permissionModeSchema),
        }),
      ),
    ),
    board: json.optional(
      json.nullable(json.object({ snapshot: json.unknown, receivedAtMs: nonnegative }, true)),
    ),
    widgetHeights: json.optional(
      json.refine(
        json.record(json.refine(json.number, (height) => height >= 1 && height <= 8000)),
        (heights) => Object.keys(heights).length <= 100,
      ),
    ),
    transcriptMetadata: json.optional(json.checked(isChatTranscriptMetadata)),
    messageReactions: json.optional(
      json.record(json.array(json.checked(isMessageReactionSummary))),
    ),
    progressCard: json.optional(json.nullable(json.checked(isProgressCard))),
    deltaCursor: json.optional(json.text),
    // Only persisted warm metadata needs its full validator; read admission loads it below.
    historyState: json.optional(json.unknown),
    displayedLeafEntryId: json.optional(json.nullable(json.text)),
    // Message contents are opaque; only the array boundary needs validation.
    messages: json.checked<unknown[]>(Array.isArray),
    pagination: paginationSchema,
    sessionId: json.nullable(json.text),
  },
  true,
);
export const recordSchema = json.refine(
  json.object(
    {
      projectionVersion: json.refine(
        json.number,
        (value) => Number.isSafeInteger(value) && value > 0,
      ),
      savedAt: nonnegative,
      sessionId: json.nullable(json.text),
      sessionKey: sessionKeySchema,
      snapshot: snapshotSchema,
    },
    true,
  ),
  (record) => {
    const thumbnails = chatThumbnailWeight(record.snapshot);
    return (
      record.sessionId === record.snapshot.sessionId &&
      thumbnails.count <= MAX_CHAT_THUMBNAILS &&
      thumbnails.bytes <= MAX_CHAT_THUMBNAIL_BYTES
    );
  },
);

export type SessionSnapshotRecord = Omit<json.SnapshotValue<typeof recordSchema>, "snapshot"> & {
  snapshot: ChatSessionSnapshot;
};
const metadataSchema = json.object(
  {
    savedAt: nonnegative,
    sessionKey: sessionKeySchema,
    weight: nonnegative,
    thumbnailCount: json.defaulted(nonnegative, () => 0),
    thumbnailBytes: json.defaulted(nonnegative, () => 0),
  },
  true,
);
export const metadataRecordsSchema = json.array(metadataSchema);
export type SessionSnapshotMetadata = json.SnapshotValue<typeof metadataSchema>;
export type PreparedSnapshotRecord = {
  record: SessionSnapshotRecord;
  metadata: SessionSnapshotMetadata;
};

export async function parseSnapshotRecord(
  value: unknown,
  sessionKey?: string,
): Promise<SessionSnapshotRecord | null> {
  const parsed = json.parseSnapshot(recordSchema, value);
  if (!parsed || (sessionKey && parsed.sessionKey !== sessionKey)) {
    return null;
  }
  const historyState = parsed.snapshot.historyState;
  if (historyState !== undefined) {
    // A repeated dynamic import can yield past dispatch even after prewarm evaluated it.
    const isChatHistoryState =
      prewarmedHistoryStateValidator ?? (await loadChatHistoryStateValidator());
    if (!isChatHistoryState(historyState)) {
      return null;
    }
  }
  return { ...parsed, snapshot: { ...parsed.snapshot, historyState } };
}

// Refill history whose old display projection omitted reasoning-only messages.
export const CHAT_SNAPSHOT_PROJECTION_VERSION = 12;
const CHAT_SNAPSHOT_MESSAGE_LIMIT = 80;

export async function createSnapshotRecord(
  sessionKey: string,
  pending: { savedAt: number; snapshot: ChatSessionSnapshot },
): Promise<PreparedSnapshotRecord | null> {
  let snapshot: ChatSessionSnapshot;
  let weight: number;
  try {
    const source = pending.snapshot;
    const changes: Partial<ChatSessionSnapshot> = {};
    const messages = source.messages;
    let start = Math.max(0, messages.length - CHAT_SNAPSHOT_MESSAGE_LIMIT);
    // A history entry can project multiple rows; retain its whole sequence group.
    while (start > 0) {
      const seq = readSessionMessageSequence(messages[start]);
      if (seq === null || seq !== readSessionMessageSequence(messages[start - 1])) {
        break;
      }
      start--;
    }
    if (start > 0) {
      // Display rows are not Gateway page boundaries. Reopen the held oldest
      // source before paging; the original cursor would skip the discarded rows.
      changes.messages = messages.slice(start);
      changes.pagination = trimmedChatHistoryPagination(source.pagination);
    }
    let historyChanged = false;
    const retainedMessages = changes.messages ?? messages;
    if (retainedMessages.some((message) => readLiveTerminalRunId(message))) {
      const { reconcileTerminalCanvasMessages } = await import("./chat-thread-canvas.ts");
      const projectedMessages = reconcileTerminalCanvasMessages(retainedMessages);
      if (projectedMessages !== retainedMessages) {
        changes.messages = projectedMessages;
        historyChanged = true;
      }
    }
    if (source.messageReactions) {
      changes.messageReactions = projectChatMessageReactions(
        changes.messages ?? messages,
        new Map(Object.entries(source.messageReactions)),
      );
    }
    const rowDisplay = projectChatRowDisplay(
      historyChanged ? { ...source, ...changes } : source,
      historyChanged ? 0 : start,
    );
    if (rowDisplay !== source.rowDisplay) {
      changes.rowDisplay = rowDisplay;
    }
    const projected = boundChatThumbnails(
      Object.keys(changes).length ? { ...source, ...changes } : source,
    );
    // Pairing credentials stay in the live projection, never the browser's disk cache.
    const serialized = JSON.stringify(projected, (_key, value: unknown) => {
      if (value instanceof Blob) {
        return undefined;
      }
      if (value === projected.messages) {
        return projected.messages.map((message) => {
          const record = asOptionalRecord(message);
          if (!record || !Object.hasOwn(record, "openclawResponsesInputReplay")) {
            return message;
          }
          const { openclawResponsesInputReplay: _replay, ...display } = record;
          return display;
        });
      }
      const sanitized = removePairingQrContent(value);
      historyChanged ||= sanitized !== value;
      return sanitized;
    });
    snapshot = JSON.parse(serialized);
    // Structured clone stores bounded thumbnails alongside the JSON projection.
    // No image decode or object URL creation runs on the snapshot-read path.
    for (const [id, row] of Object.entries(projected.rowDisplay ?? {})) {
      for (const [key, image] of Object.entries(row.images ?? {})) {
        if (image.thumbnail && snapshot.rowDisplay?.[id]?.images?.[key]) {
          snapshot.rowDisplay[id]!.images![key]!.thumbnail = image.thumbnail;
        }
      }
    }
    // A receipt cannot certify history changed by the disk display or privacy projection.
    if (historyChanged) {
      delete snapshot.historyState;
    }
    weight = serialized.length;
  } catch {
    return null;
  }
  const envelope = {
    projectionVersion: CHAT_SNAPSHOT_PROJECTION_VERSION,
    savedAt: pending.savedAt,
    sessionId: pending.snapshot.sessionId,
    sessionKey,
  };
  const thumbnails = chatThumbnailWeight(snapshot);
  return {
    record: { ...envelope, snapshot },
    metadata: {
      savedAt: pending.savedAt,
      sessionKey,
      weight: weight + JSON.stringify(envelope).length,
      thumbnailCount: thumbnails.count,
      thumbnailBytes: thumbnails.bytes,
    },
  };
}
