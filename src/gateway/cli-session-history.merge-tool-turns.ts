// Collapses a local CLI reply that duplicates imported tool-split segments.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isToolResultBlock } from "../chat/tool-content.js";

type ComparableTurnMessage = {
  message: unknown;
  order: number;
  role?: string;
  text?: string;
  timestamp?: number;
};

type ImportedTurn = { start: number; end: number; segments: string[] };

// Claude keeps a tool result as a user row after an assistant row that mixes
// text with its tool call; that row continues the turn rather than opening one.
function isPrompt(entry: ComparableTurnMessage): boolean {
  if (entry.role !== "user") {
    return false;
  }
  if (entry.text !== undefined) {
    return true;
  }
  const content = isRecord(entry.message) ? entry.message.content : undefined;
  return !(
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => isRecord(block) && isToolResultBlock(block))
  );
}

function collectImportedTurns(importedEntries: readonly ComparableTurnMessage[]): ImportedTurn[] {
  const turns: ImportedTurn[] = [];
  let turn: ImportedTurn | undefined;
  for (const imported of importedEntries) {
    if (isPrompt(imported)) {
      if (turn) {
        turn.end = imported.timestamp ?? Number.NaN;
      }
      turn =
        imported.timestamp === undefined
          ? undefined
          : { start: imported.timestamp, end: Number.POSITIVE_INFINITY, segments: [] };
      if (turn) {
        turns.push(turn);
      }
    } else if (turn && imported.role === "assistant" && imported.text) {
      turn.segments.push(imported.text);
    }
  }
  return turns;
}

// A tool-split CLI turn is stored locally as one assistant row that joins every
// pre-tool segment with the reply, while the native session keeps one row per
// segment. No single imported row equals the joined row, so both would render
// (#159707). Prefer the imported segments: they carry the tool boundaries.
// Only a local row inside the same prompt turn qualifies, so an identical reply
// elsewhere in the session stays visible.
export function dropJoinedToolTurnReplies<T extends ComparableTurnMessage>(
  merged: T[],
  importedEntries: readonly T[],
  consumed: ReadonlySet<T>,
): boolean {
  // Imported entries are numbered after every local row.
  const localCount = importedEntries[0]?.order ?? merged.length;
  const turns = collectImportedTurns(importedEntries);
  // The next imported prompt bounds a turn. Local prompts only bound the latest
  // turn: mid-turn inbound notices are recorded locally before the CLI sees them.
  const localPromptTimestamps = merged
    .filter((entry) => entry.order < localCount && isPrompt(entry))
    .map((entry) => entry.timestamp ?? Number.NaN);
  const removed = new Set<T>();
  for (const { start, end: importedEnd, segments } of turns) {
    const end =
      importedEnd === Number.POSITIVE_INFINITY
        ? localPromptTimestamps.reduce(
            (bound, timestamp) => (timestamp > start && timestamp < bound ? timestamp : bound),
            importedEnd,
          )
        : importedEnd;
    if (segments.length < 2 || !(end > start)) {
      continue;
    }
    const joined = segments.join(" ");
    const covered = merged.find(
      (entry) =>
        entry.order < localCount &&
        entry.role === "assistant" &&
        entry.text === joined &&
        entry.timestamp !== undefined &&
        entry.timestamp >= start &&
        entry.timestamp < end &&
        !consumed.has(entry) &&
        !removed.has(entry),
    );
    if (covered) {
      removed.add(covered);
    }
  }
  if (removed.size === 0) {
    return false;
  }
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    if (removed.has(merged[index]!)) {
      merged.splice(index, 1);
    }
  }
  return true;
}
