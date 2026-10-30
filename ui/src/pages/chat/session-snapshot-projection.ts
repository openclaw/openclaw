import { readSessionMessageSequence } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { removePairingQrContent } from "../../lib/chat/pairing-qr.ts";
import { projectChatMessageReactions } from "./chat-message-reactions-snapshot.ts";
import type { ChatSessionSnapshot } from "./session-message-cache.ts";

export const CHAT_SNAPSHOT_PROJECTION_VERSION = 6;
const CHAT_SNAPSHOT_MESSAGE_LIMIT = 80;

export function createSnapshotRecord(
  sessionKey: string,
  pending: { savedAt: number; snapshot: ChatSessionSnapshot },
) {
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
    if (projected.messageReactions) {
      projected = {
        ...projected,
        messageReactions: projectChatMessageReactions(
          projected.messages,
          new Map(Object.entries(projected.messageReactions)),
        ),
      };
    }
    // Pairing credentials stay in the live projection, never the browser's disk cache.
    let redacted = false;
    const serialized = JSON.stringify(projected, (_key, value: unknown) => {
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
      redacted ||= sanitized !== value;
      return sanitized;
    });
    snapshot = JSON.parse(serialized);
    // A receipt cannot certify metadata changed by the disk privacy projection.
    if (redacted) {
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
  return {
    record: { ...envelope, snapshot },
    metadata: {
      savedAt: pending.savedAt,
      sessionKey,
      weight: weight + JSON.stringify(envelope).length,
    },
  };
}
