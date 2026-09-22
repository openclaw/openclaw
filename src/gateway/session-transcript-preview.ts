import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { SessionManager } from "../agents/sessions/session-manager.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.js";
import { readRecentSessionTranscriptHistoryEvents } from "../config/sessions/session-accessor.sqlite-history-events.js";
import { resolveSessionTranscriptReadTarget } from "../config/sessions/session-accessor.transcript-target.js";
import { toTranscriptReadScope } from "./session-transcript-read-target.js";
import { buildSessionPreviewItems } from "./session-utils.fs.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

/** Reads a bounded display or canonical model-context preview before discarding metadata. */
export function readSessionPreviewItemsFromTranscript(
  scope: SessionTranscriptReadScope,
  maxItems: number,
  maxChars: number,
  view: "display" | "model-context" = "display",
): SessionPreviewItem[] {
  const target = resolveSessionTranscriptReadTarget(scope);
  // Tool-only and suppressed rows need headroom; cap even the recovery scan so previews
  // never materialize an entire large transcript or monopolize the Gateway thread.
  const initialMaxEvents = Math.min(256, Math.max(64, Math.ceil(maxItems) * 4));
  const readPreviewPage = (maxEvents: number, maxBytes: number) => {
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
    });
    return {
      items: buildSessionPreviewItems(
        page.events.map((entry) => asOptionalRecord(entry.event)?.message),
        maxItems,
        maxChars,
      ),
      hasOlderEvents: page.totalMessages > page.events.length,
    };
  };
  const preview = readPreviewPage(initialMaxEvents, 1024 * 1024);
  if (preview.items.length >= maxItems || !preview.hasOlderEvents) {
    return preview.items;
  }
  const recoveryMaxEvents = Math.min(
    2048,
    Math.max(1024, initialMaxEvents * 8, Math.ceil(maxItems)),
  );
  return readPreviewPage(recoveryMaxEvents, 8 * 1024 * 1024).items;
}
