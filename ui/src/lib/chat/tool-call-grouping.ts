/**
 * Aggregate summaries for a run of consecutive tool calls, e.g.
 * "Ran 13 commands, read 6 files, edited 9 files, created a file".
 */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import {
  AgentActivityItemSchema,
  type AgentActivityItem,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { summarizeAgentActivity } from "../../../../src/agents/agent-activity-presentation.js";
import { t } from "../../i18n/index.ts";
import type { ToolCard } from "./chat-types.ts";

export type ToolCardGroup<Card = ToolCard> = {
  card: Card;
  children: ToolCardGroup<Card>[];
};

/** Preserve recorded nesting without guessing relationships from names or arrival order. */
export function groupToolCards<
  Card extends Pick<ToolCard, "callId" | "runId" | "parentToolCallId">,
>(cards: readonly Card[]): ToolCardGroup<Card>[] {
  const groups = cards.map((card): ToolCardGroup<Card> => ({ card, children: [] }));
  const identities = new Map<string, ToolCardGroup<Card> | null>();
  for (const group of groups) {
    const { runId, callId } = group.card;
    if (runId && callId) {
      const key = JSON.stringify([runId, callId]);
      identities.set(key, identities.has(key) ? null : group);
    }
  }

  const parents = new Map<ToolCardGroup<Card>, ToolCardGroup<Card>>();
  for (const group of groups) {
    const { runId, callId, parentToolCallId } = group.card;
    if (
      !runId ||
      !parentToolCallId ||
      parentToolCallId === callId ||
      (callId && identities.get(JSON.stringify([runId, callId])) !== group)
    ) {
      continue;
    }
    const parent = identities.get(JSON.stringify([runId, parentToolCallId]));
    if (parent) {
      parents.set(group, parent);
    }
  }

  // Break every cycle member out as a root before linking children. Iterative
  // traversal also keeps malformed or deeply nested transcripts stack-safe.
  const visited = new Set<ToolCardGroup<Card>>();
  for (const group of groups) {
    const path: ToolCardGroup<Card>[] = [];
    let current: ToolCardGroup<Card> | undefined = group;
    while (current && !visited.has(current)) {
      visited.add(current);
      path.push(current);
      current = parents.get(current);
    }
    const cycleStart = current ? path.indexOf(current) : -1;
    if (cycleStart >= 0) {
      for (const member of path.slice(cycleStart)) {
        parents.delete(member);
      }
    }
  }

  const roots: ToolCardGroup<Card>[] = [];
  for (const group of groups) {
    const parent = parents.get(group);
    (parent ? parent.children : roots).push(group);
  }
  return roots;
}

export function readPreparedActivity(message: unknown): AgentActivityItem[] {
  const activity = asOptionalRecord(message)?.activity;
  return Array.isArray(activity)
    ? activity.filter((item): item is AgentActivityItem =>
        Value.Check(AgentActivityItemSchema, item),
      )
    : [];
}

export function summarizeToolGroup(items: readonly AgentActivityItem[]): string {
  return summarizeAgentActivity(items) || t("chat.toolCards.rawDetails");
}
