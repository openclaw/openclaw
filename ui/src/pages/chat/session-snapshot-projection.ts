import { readSessionMessageSequence } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { removePairingQrContent } from "../../lib/chat/pairing-qr.ts";
import { projectChatMessageReactions } from "./chat-message-reactions-snapshot.ts";
import type { ChatSessionSnapshot } from "./session-message-cache.ts";
import { readLiveTerminalRunId } from "./terminal-message-identity.ts";
import {
  boundChatThumbnails,
  chatThumbnailWeight,
  projectChatRowDisplay,
} from "./session-message-display-facts.ts";
import type { PreparedSnapshotRecord } from "./session-snapshot-record.ts";


export const CHAT_SNAPSHOT_PROJECTION_VERSION = 10;
const CHAT_SNAPSHOT_MESSAGE_LIMIT = 80;

export async function createSnapshotRecord(
  sessionKey: string,
  pending: { savedAt: number; snapshot: ChatSessionSnapshot },
): Promise<PreparedSnapshotRecord | null> {
  let snapshot: ChatSessionSnapshot;
  let weight: number;
  try {
    let projected = pending.snapshot;
    const messages = projected.messages;
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
      // Display rows are not Gateway page boundaries. Refill from zero on the
      // first upward scroll; the history owner deduplicates the overlap and
      // returns the next authoritative offset, including merged CLI histories.
      projected = {
        ...projected,
        messages: messages.slice(start),
        pagination: {
          hasMore: true,
          nextOffset: 0,
          ...(projected.pagination.totalMessages !== undefined
            ? { totalMessages: projected.pagination.totalMessages }
            : {}),
        },
      };
    }
    let historyChanged = false;
    if (projected.messages.some((message) => readLiveTerminalRunId(message))) {
      const { reconcileTerminalCanvasMessages } = await import("./chat-thread-canvas.ts");
      const projectedMessages = reconcileTerminalCanvasMessages(projected.messages);
      if (projectedMessages !== projected.messages) {
        projected = { ...projected, messages: projectedMessages };
        historyChanged = true;
      }
    }
    if (projected.messageReactions) {
      projected = {
        ...projected,
        messageReactions: projectChatMessageReactions(
          projected.messages,
          new Map(Object.entries(projected.messageReactions)),
        ),
      };
    }
    const rowDisplay = projectChatRowDisplay(projected);
    if (rowDisplay !== projected.rowDisplay) {
      projected = { ...projected, rowDisplay };
    }
    projected = boundChatThumbnails(projected);
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
