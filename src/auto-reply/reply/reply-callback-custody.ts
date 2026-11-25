// Callback custody follows source copies, independently of one-shot ingress adoption.
export const replyCallbackCustody = Symbol.for("openclaw.replyCallbackCustody");
export type ReplyCallbackCustodyBinding = {
  [replyCallbackCustody]?: { retain: () => () => void };
};
