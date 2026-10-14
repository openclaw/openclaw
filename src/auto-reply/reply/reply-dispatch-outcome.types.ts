export type ReplyDispatchDeliveryOutcome =
  | "delivered"
  | "delivered-not-visible"
  | "channel-transform"
  | "cancelled"
  | "failed-before-deliver"
  | "recovery-owned"
  | "failed-deliver";
