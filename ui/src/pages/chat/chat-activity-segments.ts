import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { unwrapToolCallForDisplay } from "../../../../src/agents/tool-display-call.js";
import { groupToolCalls } from "../../../../src/chat/tool-call-grouping.js";
import type { MessageGroup, ToolCard } from "../../lib/chat/chat-types.ts";
import { resolveToolCallInput } from "../../lib/chat/tool-call-input.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import type { SystemEventRenderItem } from "./chat-system-event-grouping.ts";
import { getExplicitToolExpansion } from "./chat-thread.ts";
import { isActivityMessageGroup } from "./chat-turn-presentation.ts";

export type ActivitySegment = { key: string; inline: boolean; groups: MessageGroup[] };

function isInlineCommandCard(card: ToolCard): boolean {
  const call = unwrapToolCallForDisplay(card);
  const { kind } = resolveToolCallInput(call.name, asNullableRecord(call.args));
  return kind === "command" || kind === "read" || kind === "search";
}

/** Inline presentation overrides defaults without changing grouped disclosure state. */
export function readInlineToolExpansion(
  expanded: ReadonlyMap<string, boolean>,
  id: string,
  card?: ToolCard,
) {
  return (
    getExplicitToolExpansion(expanded, id) ??
    (card && isInlineCommandCard(card) ? false : expanded.get(id))
  );
}

export function* inlineActivityDisclosureCalls(
  items: readonly SystemEventRenderItem[],
  bubbleMode = false,
): Iterable<readonly [string, string]> {
  for (const item of items) {
    if (item.kind === "agent-run-frame") {
      yield* inlineActivityDisclosureCalls(item.parts, bubbleMode);
      continue;
    }
    // Use the same pooled or singleton activity groups the native rows render.
    const activityGroups =
      item.kind === "activity-run"
        ? [item.groups]
        : (item.kind === "work-group" ? item.groups : item.kind === "group" ? [item] : [])
            .filter((group) => isActivityMessageGroup(group, bubbleMode))
            .map((group) => [group]);
    for (const groups of activityGroups) {
      for (const segment of inlineActivitySegments(groups)) {
        const card = segment.groups
          .flatMap((group) =>
            group.messages.flatMap((entry) => extractToolCardsCached(entry.message)),
          )
          .find((candidate) => candidate.callId);
        if (card?.callId) {
          yield [`activity:${segment.groups[0]!.key}`, `activity:${card.callId}`];
        }
      }
    }
  }
}

export function inlineActivitySegments(
  groups: readonly MessageGroup[],
  roots: Pick<ReadonlySet<ToolCard>, "has"> = new Set(
    groupToolCalls(
      groups.flatMap((group) =>
        group.messages.flatMap((entry) => extractToolCardsCached(entry.message)),
      ),
    ).map((group) => group.card),
  ),
): ActivitySegment[] {
  const segments: ActivitySegment[] = [];
  for (const group of groups) {
    let segmentGroup: MessageGroup | undefined;
    let segmentOwner: ActivitySegment | undefined;
    for (const entry of group.messages) {
      const cards = extractToolCardsCached(entry.message);
      const rootCards = cards.filter((card) => roots.has(card));
      // Descendants render with their recorded parent, even across an intervening
      // command. Keep any separate narration/media at its original position.
      const relocated = cards.length > 0 && rootCards.length === 0;
      if (relocated && !entry.hasVisibleContent) {
        continue;
      }
      // A mixed command/edit envelope stays one native message: only commands
      // gain previews, while its other cards keep their existing disclosures.
      const inline = relocated || rootCards.some(isInlineCommandCard);
      let segment = segments.at(-1);
      if (!segment || segment.inline !== inline) {
        segment = { key: entry.key, inline, groups: [] };
        segments.push(segment);
      }
      if (segmentGroup && segmentOwner === segment) {
        segmentGroup.messages.push(entry);
      } else {
        segmentGroup = {
          ...group,
          key: entry === group.messages[0] ? group.key : `${group.key}:${entry.key}`,
          messages: [entry],
        };
        segment.groups.push(segmentGroup);
        segmentOwner = segment;
      }
    }
  }
  return segments;
}
