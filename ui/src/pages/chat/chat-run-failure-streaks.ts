import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { normalizeRoleForGrouping, resolveMessageRole } from "../../lib/chat/message-normalizer.ts";

function isRealUserInput(item: ChatItem): boolean {
  if (
    item.kind !== "message" ||
    normalizeRoleForGrouping(resolveMessageRole(item.message)) !== "user"
  ) {
    return false;
  }
  const provenance = asRecord(asRecord(item.message)?.provenance);
  return provenance?.kind !== "inter_session" && provenance?.kind !== "internal_system";
}

/** Keep the latest matching failure without changing transcript or intervening rows. */
export function projectRunFailureStreaks(items: ChatItem[]): ChatItem[] {
  // Walk backward so a superseded notice can be skipped without splicing the list.
  const result: ChatItem[] = [];
  result.length = items.length;
  let start = items.length;
  let latest: Extract<ChatItem, { kind: "notice" }> | undefined;
  let latestIndex = 0;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (isRealUserInput(item)) {
      latest = undefined;
    } else if (item.kind === "notice" && item.runError) {
      if (latest?.runError?.summary === item.runError.summary) {
        latest = { ...latest, repeatCount: (latest.repeatCount ?? 1) + (item.repeatCount ?? 1) };
        result[latestIndex] = latest;
        continue;
      }
      latest = item;
      latestIndex = start - 1;
    }
    result[--start] = item;
  }
  return result.slice(start);
}
