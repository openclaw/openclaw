import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, For, Show } from "solid-js";
import { readNodePermissionRequest } from "../../../../../packages/gateway-protocol/src/node-permissions.js";
import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { unwrapToolCallForDisplay } from "../../../../../src/agents/tool-display-call.js";
import type { ToolCallGroup } from "../../../../../src/chat/tool-call-grouping.js";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { resolveToolDisplayIcon } from "../../../lib/chat/tool-display-icon.ts";
import { resolveToolDisplayIdentity } from "../../../lib/chat/tool-display-identity.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import type {
  ActivityOperationGroup,
  ActivityOperationProps,
} from "./chat-message-bubble-options.ts";
import { ChatToolIcon } from "./chat-tool-card-chrome.tsx";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";

registerEnglishCatalog(registerChatToolLabelsEnglish);

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
  const pending = roots.toReversed().map((group) => ({
    group,
    target: groups,
    executionCards: [] as ToolCard[],
  }));
  while (pending.length) {
    const { group, target, executionCards } = pending.pop()!;
    const call = unwrapToolCallForDisplay(group.card);
    const args = asNullableRecord(call.args);
    const activity = prepared.get(group.card);
    const showOutcome = retainsOwnOutcome(group.card, activity);
    const execution =
      call.name.trim().toLowerCase() === "exec" &&
      !(typeof args?.command === "string" && args.command.trim());
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

/** A recorded outcome can survive without its raw call in the loaded history page. */
export function PreparedActivityRow(props: {
  activity: AgentActivityItem;
  options: Pick<ActivityOperationProps["options"], "pluginToolIcons">;
}) {
  const detail = () =>
    props.activity.error || props.activity.summary || props.activity.progressText;
  return (
    <div class="chat-tool-msg-collapse">
      <div class="chat-tool-msg-summary chat-tool-row">
        <span class="chat-tool-msg-summary__icon" aria-hidden="true">
          <ChatToolIcon
            name={
              props.activity.commandBearing
                ? "squareTerminal"
                : resolveToolDisplayIcon(props.activity.name ?? "")
            }
            tool={{
              toolName: props.activity.name ?? "",
              pluginToolIcons: props.options.pluginToolIcons,
            }}
            style={{ display: "contents" }}
          />
        </span>
        <span class="chat-tool-disclosure__content">
          <span class="chat-tool-row__title">
            {props.activity.title || resolveToolDisplayIdentity(props.activity.name ?? "").label}
          </span>
        </span>
        <span
          class={{
            "chat-tool-failure": props.activity.status === "failed",
            "chat-tool-skipped": props.activity.status === "skipped",
            muted: props.activity.status !== "failed" && props.activity.status !== "skipped",
          }}
        >
          {t(`chat.toolCards.${!props.activity.status ? "outcomeUnknown" : props.activity.status}`)}
        </span>
      </div>
      <Show when={detail()}>{(text) => <div class="chat-tool-msg-body">{text()}</div>}</Show>
    </div>
  );
}
