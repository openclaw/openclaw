// Selects safe user/assistant tails for in-log lifecycle boundaries.

/** Default reset tail; kept here so this module stays dependency-free. */
export const DEFAULT_RESET_TAIL_MESSAGES = 6;

type SessionRecord = {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  message?: { role?: unknown };
};
type KeptParsedRecord = { role: "user" | "assistant"; record: unknown };

function isValidReplayTimestamp(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return typeof value === "string" && value.trim().length > 0;
}

function replayableTranscriptRole(record: SessionRecord | null): "user" | "assistant" | undefined {
  if (
    !record ||
    record.type !== "message" ||
    typeof record.id !== "string" ||
    record.id.trim().length === 0 ||
    !isValidReplayTimestamp(record.timestamp) ||
    !(
      record.parentId === null ||
      record.parentId === undefined ||
      typeof record.parentId === "string"
    )
  ) {
    return undefined;
  }
  const role = record.message?.role;
  return role === "user" || role === "assistant" ? role : undefined;
}

/** Tail kept so DM continuity survives silent session rotations. */
export function selectRecentUserAssistantReplayRecords(
  records: readonly unknown[],
  maxMessages = DEFAULT_RESET_TAIL_MESSAGES,
): unknown[] {
  const kept: KeptParsedRecord[] = [];
  for (const record of records) {
    const role = replayableTranscriptRole(record as SessionRecord | null);
    if (role) {
      kept.push({ role, record });
    }
  }
  let startIdx = Math.max(0, kept.length - maxMessages);
  while (startIdx < kept.length && kept[startIdx]?.role === "assistant") {
    startIdx += 1;
  }
  // Keep the newest record from each same-role run without changing its replay bytes.
  const tail: KeptParsedRecord[] = [];
  for (const entry of kept.slice(startIdx)) {
    const lastIdx = tail.length - 1;
    if (lastIdx >= 0 && tail[lastIdx]?.role === entry.role) {
      tail[lastIdx] = entry;
      continue;
    }
    tail.push(entry);
  }
  return tail.map((entry) => entry.record);
}
