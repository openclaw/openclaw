/**
 * Local exec approval prompt suppression.
 *
 * Lets channel plugins hide generic local prompts while native approval routes are active.
 */
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getExecApprovalReplyMetadata } from "../../infra/exec-approval-reply.js";
import { getChannelPlugin, normalizeChannelId } from "./registry.js";

export function shouldSuppressLocalExecApprovalPrompt(params: {
  channel?: string | null;
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  const channel = params.channel ? normalizeChannelId(params.channel) : null;
  if (!channel) {
    return false;
  }
  const nativeRouteActive = getExecApprovalReplyMetadata(params.payload)?.nativeRouteActive;
  return (
    getChannelPlugin(channel)?.outbound?.shouldSuppressLocalPayloadPrompt?.({
      cfg: params.cfg,
      accountId: params.accountId,
      payload: params.payload,
      hint: {
        kind: "approval-pending",
        approvalKind: "exec",
        nativeRouteActive,
      },
    }) ?? false
  );
}
