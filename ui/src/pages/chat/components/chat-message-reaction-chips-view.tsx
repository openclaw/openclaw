import { createMemo, For, Show } from "solid-js";
import type { MessageReactionSummary } from "../../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  type MessageReactionOptions,
  messageReactionOptions,
  ownReactionEmoji,
} from "./chat-message-reaction-model.ts";
import { MessageReactionPicker } from "./chat-message-reactions-view.tsx";

function reactorsLabel(reaction: MessageReactionSummary, userId: string | null | undefined) {
  const you = t("chat.reactions.you");
  const names = reaction.identities
    .map((identity) => (identity.id === userId ? you : (identity.label ?? identity.id)))
    .toSorted((a, b) => Number(b === you) - Number(a === you));
  const shown = names.slice(0, 3).join(", ");
  const hidden = names.length - Math.min(names.length, 3);
  return t("chat.reactions.reactedWith", {
    names:
      hidden > 0 ? t("chat.reactions.andOthers", { names: shown, count: String(hidden) }) : shown,
    emoji: reaction.emoji,
  });
}

type ReactionGroup = Parameters<typeof messageReactionOptions>[0];
export function renderSolidGroupMessageReactions(
  group: ReactionGroup,
  actionDetails: { reactionMessageId?: string } | null | undefined,
  isStreaming: boolean,
  options: MessageReactionOptions,
) {
  return (
    <GroupMessageReactions
      group={group}
      actionDetails={actionDetails}
      isStreaming={isStreaming}
      options={options}
    />
  );
}

export function GroupMessageReactions(props: {
  group: ReactionGroup;
  actionDetails: { reactionMessageId?: string } | null | undefined;
  isStreaming: boolean;
  options: MessageReactionOptions;
}) {
  const messageId = () => (props.isStreaming ? undefined : props.actionDetails?.reactionMessageId);
  const options = createMemo(() => messageReactionOptions(props.group, props.options));
  const reactions = () => (messageId() ? options().messageReactions?.get(messageId()!) : undefined);
  const own = () => ownReactionEmoji(reactions(), options().userId);
  return (
    <Show when={messageId() && reactions()?.length}>
      <div class="chat-message-reactions" data-message-id={messageId()}>
        <For each={reactions()} keyed={(reaction) => reaction.emoji}>
          {(reaction) => {
            const pressed = () => own().has(reaction().emoji);
            return (
              <openclaw-tooltip prop:content={reactorsLabel(reaction(), options().userId)}>
                <button
                  class="chat-reaction-chip"
                  type="button"
                  aria-label={`${reaction().emoji} ${reaction().count}`}
                  aria-pressed={pressed() ? "true" : "false"}
                  disabled={!options().onReact}
                  onClick={() => options().onReact?.(messageId()!, reaction().emoji, pressed())}
                >
                  <span class="chat-reaction-chip__emoji">{reaction().emoji}</span>
                  <span class="chat-reaction-chip__count">{reaction().count}</span>
                </button>
              </openclaw-tooltip>
            );
          }}
        </For>
        <Show when={options().onReact}>
          <MessageReactionPicker
            class="chat-reaction-chip chat-reaction-chip--add"
            compact
            placement={options().reactionPlacement ?? "bottom-start"}
            activeEmoji={own()}
            onSelect={(emoji: string, remove: boolean) =>
              options().onReact?.(messageId()!, emoji, remove)
            }
          />
        </Show>
      </div>
    </Show>
  );
}
