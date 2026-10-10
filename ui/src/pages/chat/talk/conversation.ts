import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { RealtimeTalkTranscript } from "./shared.ts";

type RealtimeTalkConversationRole = "user" | "assistant";

export type RealtimeTalkConversationEntry = {
  id: string;
  role: RealtimeTalkConversationRole;
  text: string;
  isStreaming: boolean;
  order?: number;
  transcriptId?: string;
};

export type RealtimeTalkConversationState = {
  entries: RealtimeTalkConversationEntry[];
  nextEntryId: number;
  userEntryId: string | null;
  userEntryAwaitingFinalStartedAtMs: number | null;
  assistantEntryId: string | null;
};

type RealtimeTalkTranscriptUpdate = RealtimeTalkTranscript & {
  nowMs?: number;
};

const MAX_CONVERSATION_ENTRIES = 60;
const MAX_CONVERSATION_ENTRY_CHARS = 8_000;
const CONVERSATION_ENTRY_PREFIX_CHARS = 256;
const CONVERSATION_ENTRY_TRUNCATION_MARKER = "\n…\n";
const USER_FINAL_REWRITE_GRACE_MS = 1_500;

export function createRealtimeTalkConversationState(): RealtimeTalkConversationState {
  return {
    entries: [],
    nextEntryId: 1,
    userEntryId: null,
    userEntryAwaitingFinalStartedAtMs: null,
    assistantEntryId: null,
  };
}

export function continueRealtimeTalkConversation(
  state: RealtimeTalkConversationState,
): RealtimeTalkConversationState {
  return {
    ...createRealtimeTalkConversationState(),
    nextEntryId: state.nextEntryId,
    entries: state.entries.map((entry, order) => ({ ...entry, order, isStreaming: false })),
  };
}

export function updateRealtimeTalkConversation(
  state: RealtimeTalkConversationState,
  update: RealtimeTalkTranscriptUpdate,
): RealtimeTalkConversationState {
  const next = applyRealtimeTalkTranscript(state, update);
  if (!update.transcriptId || next === state) {
    return next;
  }
  const entryIndex =
    update.itemId !== undefined
      ? next.entries.findIndex((entry) => entry.id === `item-${update.itemId}`)
      : next.entries.findLastIndex((entry) => entry.role === update.role);
  if (entryIndex < 0) {
    return next;
  }
  const entries = next.entries.slice();
  entries[entryIndex] = { ...entries[entryIndex]!, transcriptId: update.transcriptId };
  return { ...next, entries };
}

function applyRealtimeTalkTranscript(
  state: RealtimeTalkConversationState,
  update: RealtimeTalkTranscriptUpdate,
): RealtimeTalkConversationState {
  const text = update.text;
  if (update.final ? text.trim() === "" : text === "") {
    return state;
  }
  if (update.itemId !== undefined) {
    const id = `item-${update.itemId}`;
    const previous = state.entries.find((entry) => entry.id === id);
    const entry = {
      id,
      role: update.role,
      order: update.order,
      text: boundRealtimeConversationText(update.final ? text : (previous?.text ?? "") + text),
      isStreaming: !update.final,
    };
    // Provider identities survive delayed ASR and overlapping responses. Text and
    // wall-clock proximity cannot identify which utterance a final replaces.
    return orderRealtimeTalkConversation({
      ...state,
      entries: [...state.entries.filter((candidate) => candidate.id !== id), entry],
    });
  }
  const nowMs = update.nowMs ?? Date.now();
  if (update.textMode === "verbatim" || update.textMode === "snapshot") {
    return upsertRealtimeConversationEntry(
      state,
      update.role,
      update.role === "user" ? state.userEntryId : state.assistantEntryId,
      text,
      update.final,
      update.textMode,
    );
  }
  if (update.role === "assistant") {
    const preparedState = finishRealtimeConversationEntry(state, "user", nowMs);
    return upsertRealtimeConversationEntry(
      preparedState,
      update.role,
      preparedState.assistantEntryId,
      text,
      update.final,
    );
  }
  const entryId = state.userEntryId;
  const shouldStartNewUserEntry =
    entryId !== null && shouldStartNewRealtimeUserEntry(state, entryId, text, update.final, nowMs);
  const assistantClosedState =
    entryId === null || shouldStartNewUserEntry
      ? finishRealtimeConversationEntry(state, "assistant", nowMs)
      : state;
  const nextState = shouldStartNewUserEntry
    ? {
        ...finishRealtimeConversationEntry(assistantClosedState, "user", nowMs),
        userEntryId: null,
        userEntryAwaitingFinalStartedAtMs: null,
      }
    : assistantClosedState;
  return upsertRealtimeConversationEntry(
    nextState,
    update.role,
    shouldStartNewUserEntry ? null : entryId,
    text,
    update.final,
  );
}

export function orderRealtimeTalkConversation(
  state: RealtimeTalkConversationState,
  orders: ReadonlyArray<{ itemId: string; order: number }> = [],
): RealtimeTalkConversationState {
  const byId = new Map(orders.map(({ itemId, order }) => [`item-${itemId}`, order]));
  return {
    ...state,
    entries: state.entries
      .map((entry) => (byId.has(entry.id) ? { ...entry, order: byId.get(entry.id) } : entry))
      .toSorted((left, right) => (left.order ?? Infinity) - (right.order ?? Infinity))
      .slice(-MAX_CONVERSATION_ENTRIES),
  };
}

function upsertRealtimeConversationEntry(
  state: RealtimeTalkConversationState,
  role: RealtimeTalkConversationRole,
  entryId: string | null,
  text: string,
  isFinal: boolean,
  textMode?: RealtimeTalkTranscript["textMode"],
): RealtimeTalkConversationState {
  const targetIndex =
    entryId === null ? -1 : state.entries.findIndex((entry) => entry.id === entryId);
  const entry = state.entries[targetIndex];
  if (!entry) {
    const id = `rt-${state.nextEntryId}`;
    const entries = [
      ...state.entries,
      {
        id,
        role,
        text: boundRealtimeConversationText(textMode ? text : text.trimStart()),
        isStreaming: !isFinal,
      },
    ].slice(-MAX_CONVERSATION_ENTRIES);
    return rememberRealtimeConversationEntry(
      { ...state, entries, nextEntryId: state.nextEntryId + 1 },
      role,
      id,
      isFinal,
    );
  }

  const mergedText =
    textMode === "snapshot"
      ? text
      : textMode === "verbatim"
        ? entry.text + text
        : mergeRealtimeTranscriptText(entry.text, text, isFinal, role);
  const updatedText = boundRealtimeConversationText(mergedText);
  const entries =
    entry.text === updatedText && entry.isStreaming === !isFinal
      ? state.entries
      : state.entries.map((candidate, index) =>
          index === targetIndex
            ? { ...candidate, text: updatedText, isStreaming: !isFinal }
            : candidate,
        );
  return rememberRealtimeConversationEntry({ ...state, entries }, role, entry.id, isFinal);
}

function rememberRealtimeConversationEntry(
  state: RealtimeTalkConversationState,
  role: RealtimeTalkConversationRole,
  entryId: string,
  isFinal: boolean,
): RealtimeTalkConversationState {
  if (role === "user") {
    return {
      ...state,
      userEntryId: isFinal ? null : entryId,
      userEntryAwaitingFinalStartedAtMs: null,
    };
  }
  return { ...state, assistantEntryId: isFinal ? null : entryId };
}

function finishRealtimeConversationEntry(
  state: RealtimeTalkConversationState,
  role: RealtimeTalkConversationRole,
  nowMs: number = Date.now(),
): RealtimeTalkConversationState {
  const entryId = role === "user" ? state.userEntryId : state.assistantEntryId;
  if (entryId === null) {
    return state;
  }
  const entries = state.entries.map((entry) =>
    entry.id === entryId && entry.isStreaming ? { ...entry, isStreaming: false } : entry,
  );
  if (role === "user") {
    return {
      ...state,
      entries,
      userEntryAwaitingFinalStartedAtMs: nowMs,
    };
  }
  return { ...state, entries, assistantEntryId: null };
}

function shouldStartNewRealtimeUserEntry(
  state: RealtimeTalkConversationState,
  entryId: string,
  incoming: string,
  isFinal: boolean,
  nowMs: number,
): boolean {
  const entry = state.entries.find((candidate) => candidate.id === entryId);
  if (!entry || entry.isStreaming) {
    return false;
  }
  const existing = entry.text;
  if (existing.trim() === "" || incoming.trim() === "") {
    return false;
  }
  if (incoming[0] && /\s/.test(incoming[0])) {
    return false;
  }
  if (incoming === existing || incoming.startsWith(existing) || existing.endsWith(incoming)) {
    return false;
  }
  if (isFinal && state.userEntryAwaitingFinalStartedAtMs !== null) {
    const elapsed = nowMs - state.userEntryAwaitingFinalStartedAtMs;
    if (
      elapsed <= USER_FINAL_REWRITE_GRACE_MS &&
      looksLikeTranscriptReplacement(existing, incoming)
    ) {
      return false;
    }
  }
  return true;
}

function mergeRealtimeTranscriptText(
  existing: string,
  incoming: string,
  isFinal: boolean,
  role: RealtimeTalkConversationRole,
): string {
  if (existing.trim() === "") {
    return incoming.trimStart();
  }
  if (role === "assistant") {
    // Assistant transcripts are verbatim fragment streams: providers concatenate
    // deltas into the exact transcript (OpenAI audio-transcript deltas, Google Live
    // outputTranscription chunks). Never synthesize characters between fragments —
    // the user-side ASR spacing heuristic would mangle "ChatGPT" into "Chat G PT"
    // and "Version 1.2" into "Version 1. 2".
    // Final shape differs by provider: OpenAI-style finals carry the full
    // transcript (replace), Google Live finals carry only the last fragment
    // (append). Replace only when incoming restates what already streamed.
    return isFinal &&
      (incoming.startsWith(existing) || looksLikeTranscriptReplacement(existing, incoming))
      ? incoming
      : `${existing}${incoming}`;
  }
  if (existing.endsWith(incoming)) {
    return existing;
  }
  if (incoming.startsWith(existing)) {
    return incoming;
  }
  if (incoming[0] && /\s/.test(incoming[0])) {
    return `${existing}${incoming}`;
  }
  if (isFinal && looksLikeTranscriptReplacement(existing, incoming)) {
    return incoming;
  }
  const overlap = findTextOverlap(existing, incoming);
  const suffix = overlap > 0 ? incoming.slice(overlap) : incoming;
  if (suffix === "") {
    return existing;
  }
  const separator = overlap > 0 || !shouldInsertTranscriptSpace(existing, suffix) ? "" : " ";
  return `${existing}${separator}${suffix}`;
}

function boundRealtimeConversationText(text: string): string {
  if (text.length <= MAX_CONVERSATION_ENTRY_CHARS) {
    return text;
  }
  // Keep the opening context for late full-final replacement detection and
  // the newest tail for the visible conversation. Reuse the original prefix
  // so repeated streaming deltas do not move the truncation boundary.
  const markerIndex = text.indexOf(CONVERSATION_ENTRY_TRUNCATION_MARKER);
  const hasBoundedPrefix =
    markerIndex >= CONVERSATION_ENTRY_PREFIX_CHARS - 1 &&
    markerIndex <= CONVERSATION_ENTRY_PREFIX_CHARS;
  const prefixEnd = hasBoundedPrefix ? markerIndex : CONVERSATION_ENTRY_PREFIX_CHARS;
  // A natural marker can follow malformed provider text ending in a lone high
  // surrogate. Keep that code unit out of the retained truncation boundary.
  const prefix = sliceUtf16Safe(text, 0, prefixEnd).replace(/[\uD800-\uDBFF]$/, "");
  const tailChars =
    MAX_CONVERSATION_ENTRY_CHARS - prefix.length - CONVERSATION_ENTRY_TRUNCATION_MARKER.length;
  const tail = sliceUtf16Safe(text, -tailChars);
  return `${prefix}${CONVERSATION_ENTRY_TRUNCATION_MARKER}${tail}`;
}

function looksLikeTranscriptReplacement(existing: string, incoming: string): boolean {
  const existingWords = transcriptWords(existing);
  const incomingWords = transcriptWords(incoming);
  if (existingWords.length === 0 || incomingWords.length === 0) {
    return false;
  }
  if (existingWords[0] !== incomingWords[0]) {
    return false;
  }
  if (
    existingWords.length > 1 &&
    incomingWords.length > 1 &&
    existingWords[1] === incomingWords[1]
  ) {
    return true;
  }
  const existingText = normalizeTranscriptText(existing);
  const incomingText = normalizeTranscriptText(incoming);
  const commonPrefix = commonPrefixLength(existingText, incomingText);
  const shortest = Math.min(existingText.length, incomingText.length);
  return commonPrefix >= 6 && commonPrefix / Math.max(1, shortest) >= 0.45;
}

function transcriptWords(value: string): string[] {
  return [...value.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((match) => match[0]);
}

function normalizeTranscriptText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function findTextOverlap(base: string, next: string): number {
  const normalizedBase = base.toLowerCase();
  const normalizedNext = next.toLowerCase();
  const max = Math.min(normalizedBase.length, normalizedNext.length);
  for (let length = max; length >= 3; length -= 1) {
    if (normalizedBase.endsWith(normalizedNext.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function shouldInsertTranscriptSpace(base: string, next: string): boolean {
  const last = base.at(-1);
  const first = next[0];
  if (!last || !first || /\s/.test(last) || /\s/.test(first)) {
    return false;
  }
  return /[\p{L}\p{N}.!?,:;)\]}"'’”]/u.test(last) && /[\p{L}\p{N}]/u.test(first);
}
