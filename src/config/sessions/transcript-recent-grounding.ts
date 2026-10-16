// Grounds recent conversation rows before replay: managed-media grounding of assistant text
// against the media its own turn's trusted tool results carried, and the channel replay budget.
import {
  findUnverifiedJoinedMediaSpellings,
  prepareManagedMediaGrounding,
  prepareManagedMediaGroundingRoot,
  type ManagedMediaGroundingRoot,
} from "../../media/media-reference.js";
import { truncateUtf8Prefix } from "../../utils/utf8-truncate.js";
import {
  invalidateUngroundedMediaPrefixes,
  type JoinedMediaSpellings,
} from "./transcript-grounding.js";
import type {
  SessionRecentConversationText,
  SessionRecentConversationTextRow,
} from "./transcript-recent-text.js";

const MAX_RECENT_TRANSCRIPT_ENTRY_BYTES = 32 * 1024,
  MAX_RECENT_TRANSCRIPT_WINDOW_BYTES = 128 * 1024;

/**
 * Oldest first, with unverified managed media removed from assistant text. The rows and their
 * `turnMediaReferences` come from one transcript snapshot; an assistant row without references
 * keeps no managed media. `boundReplayBytes` is channel replay's budget, applied newest first
 * after grounding: 32 KiB per entry and 128 KiB per read.
 */
export async function groundRecentConversationRows(
  rows: readonly SessionRecentConversationTextRow[],
  options: { boundReplayBytes: boolean },
): Promise<SessionRecentConversationText[]> {
  let groundingRoot: ManagedMediaGroundingRoot | undefined;
  const selected: SessionRecentConversationText[] = [];
  let remainingBytes = MAX_RECENT_TRANSCRIPT_WINDOW_BYTES;
  for (const { turnMediaReferences, ...entry } of rows.toReversed()) {
    if (options.boundReplayBytes && remainingBytes <= 0) {
      break;
    }
    if (entry.role === "assistant") {
      groundingRoot ??= await prepareManagedMediaGroundingRoot();
      const grounding = await prepareManagedMediaGrounding(
        groundingRoot,
        turnMediaReferences ?? [],
      );
      const joins: JoinedMediaSpellings = { found: new Set() };
      const grounded = invalidateUngroundedMediaPrefixes(entry.text, grounding, joins);
      // Only a recorded joined spelling needs the store, and only one it finds needs a rescan.
      const unverified = joins.found.size
        ? await findUnverifiedJoinedMediaSpellings(groundingRoot, grounding, joins.found)
        : undefined;
      entry.text = unverified?.size
        ? invalidateUngroundedMediaPrefixes(entry.text, grounding, { found: new Set(), unverified })
        : grounded;
    }
    let text = entry.text;
    if (options.boundReplayBytes) {
      text = truncateUtf8Prefix(text, Math.min(remainingBytes, MAX_RECENT_TRANSCRIPT_ENTRY_BYTES));
      remainingBytes -= Buffer.byteLength(text);
    }
    if (text) {
      selected.push({ ...entry, text });
    }
  }
  return selected.toReversed();
}
