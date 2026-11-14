import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { MAX_HUMAN_MENTIONS } from "../../../../packages/gateway-protocol/src/human-mention-limits.js";
import type { HumanMention } from "./chat-types.ts";

export { MAX_HUMAN_MENTIONS } from "../../../../packages/gateway-protocol/src/human-mention-limits.js";

/** Carries recipient spans beside plain text; "@Name" alone never binds a person. */
export const HUMAN_MENTION_CLIPBOARD_TYPE = "application/x-openclaw-mentions";

export type HumanMentionInput = {
  value: string;
  start: number;
  end: number;
  inputType: string;
};

// Edits only need validation; draft reads also normalize a copy. Keep the checks
// shared without allocating an array and copied recipient for every edited span.
function isHumanMention(text: string, entry: unknown, previousEnd: number): entry is HumanMention {
  if (
    !isRecord(entry) ||
    typeof entry.profileId !== "string" ||
    !entry.profileId.trim() ||
    entry.profileId.length > 256 ||
    typeof entry.start !== "number" ||
    !Number.isSafeInteger(entry.start) ||
    typeof entry.end !== "number" ||
    !Number.isSafeInteger(entry.end) ||
    entry.start < previousEnd ||
    entry.end <= entry.start + 1 ||
    entry.end > text.length ||
    text[entry.start] !== "@" ||
    /[\p{L}\p{N}\p{M}_@.%+-]/u.test(text[entry.start - 1] ?? "") ||
    !text.slice(entry.start + 1, entry.end).trim()
  ) {
    return false;
  }
  for (let offset = entry.start; offset < entry.end; offset += 1) {
    if (text.charCodeAt(offset) < 32) {
      return false;
    }
  }
  return true;
}

/** Stored browser drafts are untrusted; never recover a recipient without its visible token. */
export function readHumanMentions(
  text: string,
  value: unknown,
): readonly HumanMention[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_HUMAN_MENTIONS) {
    return undefined;
  }
  const mentions: HumanMention[] = [];
  let previousEnd = 0;
  for (const entry of value) {
    if (!isHumanMention(text, entry, previousEnd)) {
      return undefined;
    }
    mentions.push({ profileId: entry.profileId, start: entry.start, end: entry.end });
    previousEnd = entry.end;
  }
  return mentions;
}

let pendingRestoration:
  | { text: string; restored: readonly HumanMention[] | undefined; input: HumanMentionInput }
  | undefined;

/** Supplies the editor's exact edit during one synchronous owner update. `restored`
 * replaces the mapped recipients (history, transfers); omit it for an ordinary edit. */
export function withHumanMentionEdit<T>(
  text: string,
  restored: readonly HumanMention[] | undefined,
  input: HumanMentionInput,
  run: () => T,
): T {
  const previous = pendingRestoration;
  pendingRestoration = { text, restored, input };
  try {
    return run();
  } finally {
    pendingRestoration = previous;
  }
}

function restoreHumanMentions(next: string, mentions: readonly HumanMention[]) {
  const restored = pendingRestoration?.text === next ? pendingRestoration.restored : undefined;
  return restored ? (readHumanMentions(next, restored) ?? []) : mentions;
}

/** A contiguous edit shifts later spans and invalidates every token it touches. */
export function updateHumanMentions(
  previous: string,
  next: string,
  mentions: readonly HumanMention[] = [],
  inputHint?: HumanMentionInput,
): readonly HumanMention[] {
  const editorInput =
    pendingRestoration?.text === next && pendingRestoration.input.value === previous
      ? pendingRestoration.input
      : undefined;
  const input = editorInput ?? inputHint;
  if ((!input && previous === next) || mentions.length === 0) {
    return restoreHumanMentions(next, mentions);
  }
  let start: number | undefined;
  let previousEnd = 0;
  // Use the supplied edit before scanning the draft. Native undo exposes only a
  // caret, whereas the rich editor supplies its exact inverse range.
  if (input?.value === previous && (editorInput || !input.inputType.startsWith("history"))) {
    const removed = previous.length - next.length;
    let inputStart = input.start;
    let inputEnd = input.end;
    if (inputStart === inputEnd && input.inputType.startsWith("delete") && removed > 0) {
      if (input.inputType.endsWith("Backward")) {
        inputStart -= removed;
      } else {
        inputEnd += removed;
      }
    }
    const inserted = next.length - previous.length + inputEnd - inputStart;
    if (
      inputStart >= 0 &&
      inserted >= 0 &&
      previous.slice(0, inputStart) === next.slice(0, inputStart) &&
      previous.slice(inputEnd) === next.slice(inputStart + inserted)
    ) {
      start = inputStart;
      previousEnd = inputEnd;
    }
  }
  if (start === undefined) {
    start = 0;
    while (start < previous.length && start < next.length && previous[start] === next[start]) {
      start += 1;
    }
    let suffix = 0;
    const sharedLength = Math.min(previous.length, next.length);
    while (
      suffix < sharedLength &&
      previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
    ) {
      suffix += 1;
    }
    previousEnd = previous.length - suffix;
    // Repeated labels are ambiguous without an exact range. Invalidate the union
    // of possible edits rather than guessing which person was changed.
    if (start + suffix > sharedLength) {
      previousEnd = start + Math.max(0, previous.length - next.length);
      start = sharedLength - suffix;
    }
  }
  const delta = next.length - previous.length;
  const shifted = mentions.flatMap((mention) => {
    if (mention.end <= start) {
      // Typing into the end of a selected label edits that label, not its identity.
      return mention.end === start && /[\p{L}\p{N}\p{M}_-]/u.test(next[start] ?? "")
        ? []
        : [mention];
    }
    if (mention.start >= previousEnd) {
      return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
    }
    return [];
  });
  // Invalidate only the tokens this edit broke; unrelated recipients survive.
  return restoreHumanMentions(
    next,
    shifted.filter((mention) => isHumanMention(next, mention, 0)),
  );
}

/** Text and UTF-16 spans must be normalized together at the submission boundary. */
export function trimHumanMentions(text: string, mentions: readonly HumanMention[] = []) {
  const trimmed = text.trim();
  const offset = text.length - text.trimStart().length;
  const shifted = mentions.map((mention) => ({
    ...mention,
    start: mention.start - offset,
    end: mention.end - offset,
  }));
  const normalized = readHumanMentions(trimmed, shifted);
  return { text: trimmed, ...(normalized ? { mentions: normalized } : {}) };
}
