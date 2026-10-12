import type { JSX } from "@solidjs/web";
import { For, Show, type Accessor } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { LitContent } from "../../../lit/solid-content.tsx";
import { rawMessageTimestamp } from "../chat-thread-items.ts";
import { renderForwardedAttribution } from "./chat-forwarded-attribution.ts";
import type { RenderMessageGroupOptions } from "./chat-message-group-options.ts";
import { renderChatTimestamp } from "./chat-message-timestamp.ts";
import "./chat-session-activity.css";

export type ChatSessionActivityProps = {
  group: MessageGroup;
  options: RenderMessageGroupOptions;
  renderEntry: (
    item: Accessor<MessageGroup["messages"][number]>,
    index: Accessor<number>,
  ) => { content: JSX.Element; actions: JSX.Element };
};

export function ChatSessionActivity(props: ChatSessionActivityProps) {
  const disclosureId = () => "session-activity:" + props.group.key;
  const expanded = () =>
    Boolean(props.options.searchResult) ||
    (props.options.isToolMessageExpanded?.(disclosureId()) ?? false);
  const count = () =>
    props.group.messages.reduce((total, message) => total + (message.duplicateCount ?? 1), 0);
  return (
    <div
      class="chat-group tool chat-group--turn-block"
      data-chat-row-key={props.group.key}
      data-file-session-key={props.group.senderSession?.sessionKey}
    >
      <div class="chat-group-messages">
        <details
          class="chat-session-activity"
          prop:open={expanded()}
          onToggle={(event) => {
            if (props.options.searchResult) {
              return;
            }
            const open = event.currentTarget.open;
            if (open !== (props.options.isToolMessageExpanded?.(disclosureId()) ?? false)) {
              props.options.onToggleToolMessageExpanded?.(disclosureId(), !open);
            }
          }}
        >
          <summary
            class="chat-inline-disclosure chat-session-activity__summary"
            aria-disabled={props.options.searchResult ? "true" : undefined}
            tabindex={props.options.searchResult ? -1 : undefined}
            onClick={(event) => {
              if (
                props.options.searchResult &&
                !(
                  event.target instanceof Element && event.target.closest("a.markdown-session-link")
                )
              ) {
                event.preventDefault();
              }
            }}
          >
            <LitContent
              value={renderForwardedAttribution(props.group, {
                ...props.options,
                ...(expanded()
                  ? { showAvatar: false }
                  : { updateCount: count(), linkSource: false }),
              })}
            />
            <Show when={!props.options.searchResult}>
              <span class="chat-session-activity__chevron" aria-hidden="true">
                <Icon name="chevronRight" />
              </span>
            </Show>
          </summary>
          <div class="chat-session-activity__body">
            <Show when={expanded() || !props.options.onToggleToolMessageExpanded}>
              <For each={props.group.messages} keyed={(item) => item.key}>
                {(item, index) => {
                  const entry = props.renderEntry(item, index);
                  return (
                    <div class="chat-session-activity__message">
                      {entry.content}
                      <div class="chat-session-activity__meta">
                        <LitContent
                          value={renderChatTimestamp(
                            rawMessageTimestamp(item().message) ?? props.group.timestamp,
                          )}
                        />
                        <div
                          class="chat-group-footer-actions"
                          data-message-actions-for={item().key}
                        >
                          {entry.actions}
                        </div>
                      </div>
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>
        </details>
      </div>
    </div>
  );
}
