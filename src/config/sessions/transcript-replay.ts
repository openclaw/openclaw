// Selects safe user/assistant tails for in-log lifecycle boundaries.

/** Tail kept so DM continuity survives silent session rotations. */
const DEFAULT_REPLAY_MAX_MESSAGES = 6;

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

export function selectRecentUserAssistantReplayRecords(
  records: readonly unknown[],
  maxMessages = DEFAULT_REPLAY_MAX_MESSAGES,
): unknown[] {
  const max = Math.max(0, maxMessages);
  if (max === 0) {
    return [];
  }
  const kept: KeptParsedRecord[] = [];
  for (const record of records) {
    const role = replayableTranscriptRole(record as SessionRecord | null);
    if (role) {
      kept.push({ role, record });
    }
  }
  let startIdx = Math.max(0, kept.length - max);
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
