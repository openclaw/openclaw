const VISIBLE_DELIVERY_TYPING = Symbol.for("openclaw.replyDispatchVisibleDeliveryTyping");

type ReplyDispatchTyping = {
  [VISIBLE_DELIVERY_TYPING]?: () => Promise<void>;
};

/** Host-owned delivery operation; absent from the supported plugin hook contract. */
export function withReplyDispatchTyping<T extends object>(
  context: T,
  start: ReplyDispatchTyping[typeof VISIBLE_DELIVERY_TYPING],
): T {
  return start ? Object.assign(context, { [VISIBLE_DELIVERY_TYPING]: start }) : context;
}

export function readReplyDispatchTyping(context: object & ReplyDispatchTyping) {
  return context[VISIBLE_DELIVERY_TYPING];
}
