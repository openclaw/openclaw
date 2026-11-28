import type { NormalizeReplySkipReason } from "../auto-reply/reply/normalize-reply-skip-reason.js";
import type { ChannelId } from "../channels/plugins/types.public.js";

/** Public channel id type carried by gateway hook payloads. */
export type HookMessageChannel = ChannelId;

export type HookAgentCompletion = {
  status: "ok" | "error" | "skipped";
  replyDisposition: "visible" | "silent" | "empty";
  delivered?: boolean;
  deliveryAttempted?: boolean;
  deliveryError?: "delivery-failed";
  deliverySuppressionReason?: NormalizeReplySkipReason;
};

export type HookAgentDispatchSuccess = {
  ok: true;
  runId: string;
  completion: Promise<HookAgentCompletion>;
};

export type HookAgentDispatchResult =
  | HookAgentDispatchSuccess
  | { ok: false; statusCode: 400 | 409 | 502 | 503; error: string; runId?: string };
