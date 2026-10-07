import type { SourceReplyDeliveryMode } from "../../auto-reply/source-reply-delivery-mode.types.js";

/** Owner responsible for making source delivery visible to the user. */
type SourceVisibleDeliveryOwner =
  | "automatic_source"
  | "message_tool"
  | "message_tool_then_direct_fallback"
  | "direct_fallback"
  | "none";

/** Reason code explaining why source delivery policy took this shape. */
type SourceDeliveryPlanReason =
  | "config"
  | "room_event"
  | "cron_announce"
  | "cron_webhook"
  | "cron_none"
  | "media_completion"
  | "subagent_completion";

/** Configured or inferred destination source delivery must satisfy. */
export type SourceDeliveryTarget = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

/** Message-tool destination observed during a run. */
export type SourceDeliveryMessageToolTarget = {
  tool?: string;
  provider?: string;
  accountId?: string;
  to?: string;
  threadId?: string;
  threadImplicit?: boolean;
  threadSuppressed?: boolean;
  text?: string;
  mediaUrls?: string[];
};

/** Visible message-tool delivery with target verification state. */
export type SourceDeliveryVisibleDelivery = {
  via: "message_tool";
  target: SourceDeliveryMessageToolTarget;
  verifiedTarget: boolean;
};

/** Resolved source-delivery satisfaction result after a run. */
export type SourceDeliveryOutcome = {
  visibleDeliveries: SourceDeliveryVisibleDelivery[];
  verifiedMessageToolDelivery: boolean;
  satisfiesSourceDelivery: boolean;
  unverifiedMessageToolDelivery: boolean;
};

/** Policy contract that decides message-tool ownership and fallback delivery. */
export type SourceDeliveryPlan = {
  owner: SourceVisibleDeliveryOwner;
  reason: SourceDeliveryPlanReason;
  target: SourceDeliveryTarget;
  normalFinal: "visible" | "private";
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  messageTool: {
    enabled: boolean;
    force: boolean;
    requireExplicitTarget: boolean;
    requireExplicitTargetEvidence: boolean;
  };
  fallback: {
    directDelivery: boolean;
    skipWhenMessageToolSentToTarget: boolean;
  };
};
