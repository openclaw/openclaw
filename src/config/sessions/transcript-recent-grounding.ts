// Grounds recent conversation rows before replay: managed-media grounding of assistant text
// against the media its own turn's trusted tool results carried, and the channel replay budget.
import {
  findRefusedMediaContinuations,
  findUnverifiedJoinedMediaSpellings,
  prepareManagedMediaGrounding,
  prepareManagedMediaGroundingRoot,
  type ManagedMediaGrounding,
  type ManagedMediaGroundingRoot,
} from "../../media/media-reference.js";
import { truncateUtf8Prefix } from "../../utils/utf8-truncate.js";
import {
  invalidateUngroundedMediaPrefixes,
  MAX_GROUNDING_TOKEN_CHARS,
  PUNCTUATION,
  TOKEN_BOUNDARY,
  type JoinedMediaSpellings,
} from "./transcript-grounding.js";
import type {
  SessionRecentConversationText,
  SessionRecentConversationTextRow,
} from "./transcript-recent-text.js";

const MAX_RECENT_TRANSCRIPT_ENTRY_BYTES = 32 * 1024,
  MAX_RECENT_TRANSCRIPT_WINDOW_BYTES = 128 * 1024;

/**
 * Raw slices of `text` from the authorized alias at `at`, ending wherever a reader could stop a
 * name that keeps spaces, quotes and brackets: before each boundary and before trailing
 * punctuation, shortest first. `end` is where the trimmed text ends. Lazy, because only the store
 * can say whether any of them is worth reading. Undefined when the text runs on past the token
 * budget, which the caller refuses.
 */
function continuedMediaSpellings(
  text: string,
  end: number,
  at: number,
  aliasLength: number,
): Iterable<string> | undefined {
  if (end - at > MAX_GROUNDING_TOKEN_CHARS) {
    return undefined;
  }
  return (function* () {
    let previous = "";
    for (let stop = at + aliasLength + 1; stop <= end; stop += 1) {
      if (stop < end && !TOKEN_BOUNDARY.test(text.charAt(stop))) {
        continue;
      }
      let cut = stop;
      while (cut > at + aliasLength && PUNCTUATION.test(text.charAt(cut - 1))) {
        cut -= 1;
      }
      // The resolver trims, so a stop after whitespace repeats the one before it.
      for (const last of cut === stop ? [stop] : [cut, stop]) {
        const spelling = text.slice(at, last);
        if (
          last > at + aliasLength &&
          !/\s/u.test(text.charAt(last - 1)) &&
          spelling !== previous
        ) {
          previous = spelling;
          yield spelling;
        }
      }
    }
  })();
}

/** What the media owner refuses of a scan's joined spellings and the aliases text follows. */
async function refusedMediaReferences(
  root: ManagedMediaGroundingRoot,
  grounding: ManagedMediaGrounding,
  text: string,
  joins: Required<Pick<JoinedMediaSpellings, "found" | "kept">>,
): Promise<Pick<JoinedMediaSpellings, "unverified" | "refusedContinuations">> {
  const unverified = joins.found.size
    ? await findUnverifiedJoinedMediaSpellings(root, grounding, joins.found)
    : undefined;
  // What normalizeMediaReferenceSource trims is never part of a reference.
  const end = text.trimEnd().length;
  const continued = [...joins.kept].filter(([at, aliasLength]) => at + aliasLength < end);
  const refusedContinuations = continued.length
    ? await findRefusedMediaContinuations(
        root,
        grounding,
        continued.map(([at, aliasLength]) => ({
          key: at,
          alias: text.slice(at, at + aliasLength),
          spellings: () => continuedMediaSpellings(text, end, at, aliasLength),
        })),
      )
    : undefined;
  return { unverified, refusedContinuations };
}

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
      const joins = { found: new Set<string>(), kept: new Map<number, number>() };
      const grounded = invalidateUngroundedMediaPrefixes(entry.text, grounding, joins);
      // Only a recorded spelling or kept alias needs the store, and only one it refuses needs a
      // rescan.
      const refused =
        joins.found.size || joins.kept.size
          ? await refusedMediaReferences(groundingRoot, grounding, entry.text, joins)
          : {};
      entry.text =
        refused.unverified?.size || refused.refusedContinuations?.size
          ? invalidateUngroundedMediaPrefixes(entry.text, grounding, {
              found: new Set(),
              ...refused,
            })
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
