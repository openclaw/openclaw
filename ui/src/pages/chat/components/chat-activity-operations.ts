import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { readNodePermissionRequest } from "../../../../../packages/gateway-protocol/src/node-permissions.js";
import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import {
  isToolCallDispatcherName,
  unwrapToolCallForDisplay,
} from "../../../../../src/agents/tool-display-call.js";
import type { ToolCallGroup } from "../../../../../src/chat/tool-call-grouping.js";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { resolveToolCallInput } from "../../../lib/chat/tool-call-input.ts";
import {
  resolveSessionLaunchPresentation,
  readSubagentCancellation,
} from "../chat-spawned-subagent.ts";
import type { ActivityOperationGroup } from "./chat-message-bubble-options.ts";

export function isInlineCommandCard(card: ToolCard): boolean {
  const call = unwrapToolCallForDisplay(card);
  const { kind } = resolveToolCallInput(call.name, asNullableRecord(call.args));
  return kind === "command" || kind === "read" || kind === "search";
}

export function isStandaloneActivity(card: ToolCard): boolean {
  const name = unwrapToolCallForDisplay(card).name.trim().toLowerCase();
  return (
    name === "view_image" ||
    name === "ask_user" ||
    name === "agents_wait" ||
    readSubagentCancellation(card) !== null ||
    resolveSessionLaunchPresentation(card)?.kind === "subagent" ||
    Boolean(readNodePermissionRequest(asNullableRecord(card.details)?.permissionMissing))
  );
}

/** A command started: it reported an exit code, or its code reached bridge dispatch. */
export function isExecutedCommandCard(card: ToolCard): boolean {
  if (card.exitCode !== undefined) {
    return true;
  }
  const call = unwrapToolCallForDisplay(card);
  const args = asNullableRecord(call.args);
  return (
    card.bridgeDispatchStarted === true &&
    call.name.trim().toLowerCase() === "exec" &&
    !(typeof args?.command === "string" && args.command.trim()) &&
    [args?.code, args?.input].some((code) => typeof code === "string" && code.trim())
  );
}

/**
 * A code-mode exec or a tool search dispatch only carries recorded child calls;
 * its children are the operations, and the carrier stays inspector evidence.
 */
export function isInvocationContainer(group: ToolCallGroup<ToolCard>): boolean {
  const call = unwrapToolCallForDisplay(group.card);
  const args = asNullableRecord(call.args);
  return (
    (call.name.trim().toLowerCase() === "exec" &&
      !(typeof args?.command === "string" && args.command.trim())) ||
    (isToolCallDispatcherName(group.card.name) && group.children.length > 0)
  );
}

export function descendantCards(group: ToolCallGroup<ToolCard>) {
  const cards: ToolCard[] = [];
  const pending = [...group.children];
  for (const child of pending) {
    cards.push(child.card);
    pending.push(...child.children);
  }
  return cards;
}

function retainsOwnOutcome(card: ToolCard, activity: AgentActivityItem | undefined): boolean {
  return (
    Boolean(readNodePermissionRequest(asNullableRecord(card.details)?.permissionMissing)) ||
    card.isError === true ||
    activity?.status === "failed" ||
    activity?.status === "blocked" ||
    activity?.status === "skipped"
  );
}

/** Presentation follows recorded children; execution containers remain inspector evidence. */
export function projectActivityOperations(
  roots: readonly ToolCallGroup<ToolCard>[],
  prepared: ReadonlyMap<ToolCard, AgentActivityItem>,
  suppressed: ReadonlySet<ToolCard>,
) {
  const groups: ActivityOperationGroup[] = [];
  const hidden = new Set<ToolCard>();
  const tree = [...roots];
  for (const group of tree) {
    tree.push(...group.children);
  }
  const visible = new Set<ToolCallGroup<ToolCard>>();
  for (const group of tree.toReversed()) {
    const activity = prepared.get(group.card);
    if (
      (!suppressed.has(group.card) &&
        !activity?.hideFromChannelProgress &&
        !activity?.suppressChannelProgress) ||
      group.children.some((child) => visible.has(child))
    ) {
      visible.add(group);
    }
  }
  const pending: {
    group: ToolCallGroup<ToolCard>;
    target: ActivityOperationGroup[];
    executionCards: ToolCard[];
  }[] = roots.toReversed().map((group) => ({
    group,
    target: groups,
    executionCards: [],
  }));
  while (pending.length) {
    const { group, target, executionCards } = pending.pop()!;
    const activity = prepared.get(group.card);
    const showOutcome = retainsOwnOutcome(group.card, activity);
    const execution = isInvocationContainer(group);
    const visibleChildren = group.children.some((child) => visible.has(child));
    if (
      !showOutcome &&
      ((execution && group.children.length > 0 && !visibleChildren) ||
        (target === groups && !visible.has(group)))
    ) {
      const children = descendantCards(group);
      if (!children.some((card) => retainsOwnOutcome(card, prepared.get(card)))) {
        // Routine work stays hidden even after its wrapper is retired. Include every
        // card so the ordinary message renderer cannot restore the subtree.
        hidden.add(group.card);
        for (const card of children) {
          hidden.add(card);
        }
        continue;
      }
    }
    const container =
      execution &&
      (visibleChildren ||
        (!showOutcome &&
          (suppressed.has(group.card) ||
            activity?.hideFromChannelProgress === true ||
            activity?.suppressChannelProgress === true)));
    if (container && !showOutcome) {
      hidden.add(group.card);
    }
    const operation: ActivityOperationGroup = {
      card: group.card,
      children: [],
      ...(executionCards.length ? { executionCards } : {}),
    };
    if (!container || showOutcome) {
      target.push(operation);
    }
    for (const child of group.children.toReversed()) {
      pending.push({
        group: child,
        target: container ? target : operation.children,
        executionCards: container ? [...executionCards, group.card] : executionCards,
      });
    }
  }
  return { groups, hidden };
}
