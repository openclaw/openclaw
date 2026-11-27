import type { MessageReactionSummary } from "../../../../../packages/gateway-protocol/src/index.js";

type MessageReactionAction = (messageId: string, emoji: string, remove: boolean) => void;
export type MessageReactionPlacement = "bottom-start" | "bottom-end";

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

export type MessageReactionOptions = {
  messageReactions?: ReadonlyMap<string, MessageReactionSummary[]>;
  userId?: string | null;
  onReact?: MessageReactionAction;
  reactionPlacement?: MessageReactionPlacement;
};

/** The message toolbar keeps its picker before and after the first reaction. */
export function hasActionRowReactionPicker(
  messageId: string | undefined,
  opts: MessageReactionOptions,
): messageId is string {
  return Boolean(messageId && opts.onReact);
}

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
