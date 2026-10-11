import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import type { MessageReactionSummary } from "../../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../../i18n/index.ts";
import type { MessageReactionPlacement } from "./chat-message-reactions-view.tsx";
import "./chat-message-reactions-view.tsx";

export type MessageReactionAction = (messageId: string, emoji: string, remove: boolean) => void;

const TOOLTIP_NAME_LIMIT = 3;

export function ownReactionEmoji(
  reactions: readonly MessageReactionSummary[] | undefined,
  userId: string | null | undefined,
): ReadonlySet<string> {
  return new Set(
    (reactions ?? [])
      .filter((reaction) => reaction.identities.some((identity) => identity.id === userId))
      .map((reaction) => reaction.emoji),
  );
}

function reactorsLabel(reaction: MessageReactionSummary, userId: string | null | undefined) {
  const you = t("chat.reactions.you");
  const names = reaction.identities
    .map((identity) => (identity.id === userId ? you : (identity.label ?? identity.id)))
    .toSorted((a, b) => Number(b === you) - Number(a === you));
  const shown = names.slice(0, TOOLTIP_NAME_LIMIT).join(", ");
  const hidden = names.length - Math.min(names.length, TOOLTIP_NAME_LIMIT);
  return t("chat.reactions.reactedWith", {
    names:
      hidden > 0 ? t("chat.reactions.andOthers", { names: shown, count: String(hidden) }) : shown,
    emoji: reaction.emoji,
  });
}

export type MessageReactionOptions = {
  messageReactions?: ReadonlyMap<string, MessageReactionSummary[]>;
  userId?: string | null;
  onReact?: MessageReactionAction;
  reactionPlacement?: MessageReactionPlacement;
};

/** Pickers under a person's own right-aligned prompt open toward the left. */
export function messageReactionOptions(
  group: { role: string; sender?: { identity?: { type: string; id: string } } | null },
  opts: MessageReactionOptions,
): MessageReactionOptions {
  const identity = group.sender?.identity;
  const own = group.role === "user" && identity?.type === "profile" && identity.id === opts.userId;
  return {
    messageReactions: opts.messageReactions,
    userId: opts.userId,
    onReact: opts.onReact,
    reactionPlacement: own ? "bottom-end" : "bottom-start",
  };
}

export function renderGroupMessageReactions(
  group: Parameters<typeof messageReactionOptions>[0],
  actionDetails: { reactionMessageId?: string } | null | undefined,
  isStreaming: boolean,
  opts: MessageReactionOptions,
) {
  const messageId = isStreaming ? undefined : actionDetails?.reactionMessageId;
  const options = messageReactionOptions(group, opts);
  const reactions = messageId ? options.messageReactions?.get(messageId) : undefined;
  if (!messageId || !reactions?.length) {
    return nothing;
  }
  const { userId, onReact } = options;
  const own = ownReactionEmoji(reactions, userId);
  return html`<div class="chat-message-reactions" data-message-id=${messageId}>
    ${reactions.map((reaction) => {
      const pressed = own.has(reaction.emoji);
      return html`<openclaw-tooltip .content=${reactorsLabel(reaction, userId)}>
        <button
          class="chat-reaction-chip"
          type="button"
          aria-label=${`${reaction.emoji} ${reaction.count}`}
          aria-pressed=${String(pressed)}
          ?disabled=${!onReact}
          @click=${() => onReact?.(messageId, reaction.emoji, pressed)}
        >
          <span class="chat-reaction-chip__emoji">${reaction.emoji}</span>
          ${keyed(
            reaction.count,
            html`<span class="chat-reaction-chip__count">${reaction.count}</span>`,
          )}
        </button>
      </openclaw-tooltip>`;
    })}
    ${
      onReact
        ? html`<openclaw-message-reaction-picker
            class="chat-reaction-chip chat-reaction-chip--add"
            compact
            placement=${options.reactionPlacement ?? "bottom-start"}
            .activeEmoji=${own}
            .onSelect=${(emoji: string, remove: boolean) => onReact(messageId, emoji, remove)}
          ></openclaw-message-reaction-picker>`
        : nothing
    }
  </div>`;
}
