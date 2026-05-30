import type { ChatItem, MessageGroup } from "../types/chat-types.ts";
import { isToolResultMessage, normalizeRoleForGrouping } from "./role-normalizer.ts";
import { getOrCreateSessionCacheValue } from "./session-cache.ts";
import { extractToolCards } from "./tool-cards.ts";

const expandedToolCardsBySession = new Map<string, Map<string, boolean>>();
const manuallyToggledBySession = new Map<string, Set<string>>();

export function getExpandedToolCards(sessionKey: string): Map<string, boolean> {
  return getOrCreateSessionCacheValue(expandedToolCardsBySession, sessionKey, () => new Map());
}

function getManuallyToggledToolCards(sessionKey: string): Set<string> {
  return getOrCreateSessionCacheValue(manuallyToggledBySession, sessionKey, () => new Set());
}

/**
 * Record that the user opened/closed a tool card by hand. Manually toggled
 * cards keep their state and stop following the auto "only the last card in
 * the turn stays open" rule until the card scrolls out of the transcript.
 */
export function markToolCardManuallyToggled(sessionKey: string, disclosureId: string) {
  getManuallyToggledToolCards(sessionKey).add(disclosureId);
}

export function resetToolExpansionStateForTest() {
  expandedToolCardsBySession.clear();
  manuallyToggledBySession.clear();
}

function isToolEntryMessage(message: unknown): boolean {
  const record = message as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : "unknown";
  const normalizedRole = normalizeRoleForGrouping(role);
  return (
    isToolResultMessage(message) ||
    normalizedRole === "tool" ||
    role.toLowerCase() === "toolresult" ||
    role.toLowerCase() === "tool_result" ||
    typeof record.toolCallId === "string" ||
    typeof record.tool_call_id === "string"
  );
}

/** Collect tool disclosure ids for one group, in the order they render. */
function collectGroupDisclosureIds(group: MessageGroup): string[] {
  const ids: string[] = [];
  for (const entry of group.messages) {
    const cards = extractToolCards(entry.message, entry.key);
    for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
      ids.push(`${entry.key}:toolcard:${cardIndex}`);
    }
    if (isToolEntryMessage(entry.message)) {
      ids.push(`toolmsg:${entry.key}`);
    }
  }
  return ids;
}

/**
 * Keep the transcript clean: within each turn (message group) only the most
 * recent tool card stays expanded; every earlier card collapses to a single
 * row. Re-evaluated on every render so a turn's expanded card follows the
 * latest streamed tool result. Cards the user toggled by hand are left alone.
 *
 * The `autoExpandToolCalls` preference no longer forces every card open; the
 * last-card-only rule is always in effect.
 */
export function syncToolCardExpansionState(
  sessionKey: string,
  items: Array<ChatItem | MessageGroup>,
  _autoExpandToolCalls: boolean,
) {
  const expanded = getExpandedToolCards(sessionKey);
  const manual = getManuallyToggledToolCards(sessionKey);
  const live = new Set<string>();

  for (const item of items) {
    if (item.kind !== "group") {
      continue;
    }
    const disclosureIds = collectGroupDisclosureIds(item);
    const lastId = disclosureIds.at(-1);
    for (const disclosureId of disclosureIds) {
      live.add(disclosureId);
      if (manual.has(disclosureId)) {
        continue;
      }
      expanded.set(disclosureId, disclosureId === lastId);
    }
  }

  // Forget cards that left the transcript so manual flags and stale state do
  // not leak across reloads or session switches.
  for (const id of [...manual]) {
    if (!live.has(id)) {
      manual.delete(id);
    }
  }
  for (const id of [...expanded.keys()]) {
    if (!live.has(id)) {
      expanded.delete(id);
    }
  }
}
