import { createMemo, For, Show } from "solid-js";
import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import { resolveToolDisplayIcon } from "../../../lib/chat/tool-display-icon.ts";
import { resolveToolDisplayIdentity } from "../../../lib/chat/tool-display-identity.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { descendantCards } from "./chat-activity-operations.ts";
import type { ActivityOperationProps } from "./chat-message-bubble-options.ts";
import { ChatToolIcon } from "./chat-tool-card-chrome.tsx";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";

registerEnglishCatalog(registerChatToolLabelsEnglish);

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
        onOpenWorkspaceFile: context().onOpenWorkspaceFile,
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
