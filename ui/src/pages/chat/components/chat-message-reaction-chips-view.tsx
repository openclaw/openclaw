import { createMemo, For, Show } from "solid-js";
import type { MessageReactionSummary } from "../../../../../packages/gateway-protocol/src/index.js";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import {
  type MessageReactionOptions,
  messageReactionOptions,
  ownReactionEmoji,
} from "./chat-message-reaction-model.ts";
import { MessageReactionPicker } from "./chat-message-reactions-view.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

const FACE_LIMIT = 3;
const NAME_LIMIT = 3;
// Past this many kinds the hover list would outgrow short viewports; the picker lists them all.
const DETAIL_LIMIT = 8;
const compactCount = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function reactorNames(reaction: MessageReactionSummary, userId: string | null | undefined) {
  const you = t("chat.reactions.you");
  const names = reaction.identities
    .map((identity) => (identity.id === userId ? you : (identity.label ?? identity.id)))
    .toSorted((a, b) => Number(b === you) - Number(a === you));
  const shown = names.slice(0, NAME_LIMIT).join(", ");
  // A channel can report more reactors than it names; the remainder reads as "others".
  const hidden = Math.max(reaction.count, names.length) - Math.min(names.length, NAME_LIMIT);
  if (hidden === 1) {
    return t("chat.reactions.andOneOther", { names: shown });
  }
  return hidden > 1
    ? t("chat.reactions.andOthers", { names: shown, count: String(hidden) })
    : shown;
}

type ReactionGroup = Parameters<typeof messageReactionOptions>[0];

/** One tab on the bubble's outer corner: leading emoji, a total past one, names on hover. */
export function GroupMessageReactions(props: {
  group: ReactionGroup;
  actionDetails: { reactionMessageId?: string } | null | undefined;
  isStreaming: boolean;
  options: MessageReactionOptions;
}) {
  const messageId = () => (props.isStreaming ? undefined : props.actionDetails?.reactionMessageId);
  const options = createMemo(() => messageReactionOptions(props.group, props.options));
  const reactions = () => {
    const id = messageId();
    return id ? options().messageReactions?.get(id) : undefined;
  };
  const own = () => ownReactionEmoji(reactions(), options().userId);
  // A stable sort keeps arrival order among equal counts, so the faces do not reshuffle on ties.
  const ranked = createMemo(() => (reactions() ?? []).toSorted((a, b) => b.count - a.count));
  const total = () => ranked().reduce((sum, reaction) => sum + reaction.count, 0);
  return (
    <Show when={ranked().length}>
      <div
        class={["chat-message-reactions", { "chat-message-reactions--own": own().size > 0 }]}
        data-message-id={messageId()}
      >
        <MessageReactionPicker
          placement={options().reactionPlacement ?? "bottom-start"}
          activeEmoji={own()}
          disabled={!options().onReact}
          reactions={ranked()}
          onSelect={(emoji: string, remove: boolean) =>
            options().onReact?.(messageId()!, emoji, remove)
          }
          summaryLabel={ranked()
            .map((reaction) => `${reaction.emoji} ${reactorNames(reaction, options().userId)}`)
            .join("; ")}
          summary={
            <>
              <For each={ranked().slice(0, FACE_LIMIT)} keyed={(reaction) => reaction.emoji}>
                {(reaction) => <span class="chat-reaction-tab__emoji">{reaction().emoji}</span>}
              </For>
              <Show when={total() > 1}>
                <span class="chat-reaction-tab__count">{compactCount.format(total())}</span>
              </Show>
            </>
          }
          summaryDetails={
            <div class="chat-reaction-who">
              <For each={ranked().slice(0, DETAIL_LIMIT)} keyed={(reaction) => reaction.emoji}>
                {(reaction) => (
                  <>
                    <span class="chat-reaction-who__emoji">{reaction().emoji}</span>
                    <span>{reactorNames(reaction(), options().userId)}</span>
                  </>
                )}
              </For>
              <Show when={ranked().length > DETAIL_LIMIT}>
                <span class="chat-reaction-who__more">+{ranked().length - DETAIL_LIMIT}</span>
              </Show>
            </div>
          }
        />
      </div>
    </Show>
  );
}
