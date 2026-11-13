import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, For, Show } from "solid-js";
import { readNodePermissionRequest } from "../../../../../packages/gateway-protocol/src/node-permissions.js";
import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { unwrapToolCallForDisplay } from "../../../../../src/agents/tool-display-call.js";
import type { ToolCallGroup } from "../../../../../src/chat/tool-call-grouping.js";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import type {
  ActivityOperationGroup,
  ActivityOperationProps,
} from "./chat-message-bubble-options.ts";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";

export function descendantCards(group: ToolCallGroup<ToolCard>) {
  const cards: ToolCard[] = [];
  const pending = [...group.children];
  for (const child of pending) {
    cards.push(child.card);
    pending.push(...child.children);
  }
  return cards;
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
  const pending = roots.toReversed().map((group) => ({
    group,
    target: groups,
    executionCards: [] as ToolCard[],
  }));
  while (pending.length) {
    const { group, target, executionCards } = pending.pop()!;
    const call = unwrapToolCallForDisplay(group.card);
    const args = asNullableRecord(call.args);
    const permission = readNodePermissionRequest(
      asNullableRecord(group.card.details)?.permissionMissing,
    );
    const activity = prepared.get(group.card);
    const container =
      call.name.trim().toLowerCase() === "exec" &&
      !(typeof args?.command === "string" && args.command.trim()) &&
      (group.children.some((child) => visible.has(child)) ||
        suppressed.has(group.card) ||
        activity?.hideFromChannelProgress === true ||
        activity?.suppressChannelProgress === true);
    const outcome = prepared.get(group.card)?.status;
    const showOutcome =
      Boolean(permission) ||
      group.card.isError === true ||
      outcome === "failed" ||
      outcome === "blocked" ||
      outcome === "skipped";
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

export function ActivityOperation(props: ActivityOperationProps) {
  const context = () => props.contexts.get(props.group.card)!;
  const expanded = createMemo(
    () => props.options.isToolExpanded?.(context().disclosureId, props.group.card) ?? false,
  );
  return (
    <ChatToolCard
      card={props.group.card}
      options={{
        ...props.options,
        messageKey: context().messageKey,
        expanded: expanded(),
        onToggleExpanded: () =>
          props.options.onToggleToolExpanded?.(context().disclosureId, expanded()),
        activityCards: [props.group.card, ...descendantCards(props.group)],
        executionCards: props.group.executionCards,
      }}
      hasChildren={props.group.children.length > 0}
    >
      <Show when={expanded()}>
        <For
          each={props.group.children}
          keyed={(group) => group.card.callId ?? props.contexts.get(group.card)!.disclosureId}
        >
          {(group) => (
            <ActivityOperation group={group()} options={props.options} contexts={props.contexts} />
          )}
        </For>
      </Show>
    </ChatToolCard>
  );
}
