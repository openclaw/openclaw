import { Show } from "solid-js";
import type { MessageGroup as MessageGroupData } from "../../../lib/chat/chat-types.ts";
import type { readChatInputDelivery } from "../chat-thread-items.ts";
import { ChatInputDeliveryStatus } from "./chat-input-delivery-status-view.tsx";
import { MessageActions, type MessageActionOptions } from "./chat-message-markdown-view.tsx";
import type { MessageActionDetails } from "./chat-message-markdown.types.ts";
import { GroupMessageReactions } from "./chat-message-reaction-chips-view.tsx";
import { MessageMeta } from "./chat-message-timestamp-view.tsx";

export function MessageActionsRow(props: {
  messageKey?: string;
  details: MessageActionDetails | null | undefined;
  options: MessageActionOptions;
  class?: string;
  reactionGroup?: MessageGroupData;
  timestamp?: number;
  inputDelivery?: ReturnType<typeof readChatInputDelivery>;
}) {
  let owner: HTMLDivElement | undefined;
  return (
    <div
      ref={(element) => (owner = element)}
      class={props.class ?? "chat-group-footer-actions"}
      data-message-actions-for={props.messageKey}
    >
      <Show when={props.reactionGroup}>
        {(group) => (
          <GroupMessageReactions
            group={group()}
            actionDetails={props.details}
            isStreaming={false}
            options={props.options}
          />
        )}
      </Show>
      <MessageActions
        details={props.details}
        options={props.options}
        actionOwner={() => owner}
        messageKey={props.messageKey}
      />
      <Show when={props.timestamp !== undefined}>
        <MessageMeta timestamp={props.timestamp!} meta={null} />
      </Show>
      <ChatInputDeliveryStatus delivery={props.inputDelivery ?? null} />
    </div>
  );
}
