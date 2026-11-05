import { For, Show } from "solid-js";
import type { ToolCallGroup } from "../../../../../src/chat/tool-call-grouping.js";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import type { ActivityOperationProps } from "./chat-message-bubble-options.ts";
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

export function ActivityOperation(props: ActivityOperationProps) {
  const context = () => props.contexts.get(props.group.card)!;
  const expanded = () => props.options.isToolExpanded?.(context().disclosureId) ?? false;
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
