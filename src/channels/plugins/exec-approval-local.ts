import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/config.js";
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
  return (
    getChannelPlugin(channel)?.execApprovals?.shouldSuppressLocalPrompt?.({
      cfg: params.cfg,
      accountId: params.accountId,
      payload: params.payload,
    }) ?? false
  );
}
