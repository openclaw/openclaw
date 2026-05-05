import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { createReplyMediaPathNormalizer } from "../../auto-reply/reply/reply-media-paths.runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSendableOutboundReplyParts } from "../../plugin-sdk/reply-payload.js";

function hasDataUrlMedia(payload: ReplyPayload): boolean {
  return resolveSendableOutboundReplyParts(payload).mediaUrls.some((mediaUrl) =>
    mediaUrl.trim().toLowerCase().startsWith("data:"),
  );
}

export async function normalizeWebchatReplyMediaPathsForDisplay(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  workspaceDir?: string;
  accountId?: string;
  payloads: ReplyPayload[];
}): Promise<ReplyPayload[]> {
  if (params.payloads.length === 0) {
    return params.payloads;
  }
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, params.agentId);
  if (!workspaceDir) {
    return params.payloads;
  }
  const normalizeMediaPaths = createReplyMediaPathNormalizer({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    workspaceDir,
    accountId: params.accountId,
  });
  const normalized: ReplyPayload[] = [];
  for (const payload of params.payloads) {
    if (payload.sensitiveMedia === true || hasDataUrlMedia(payload)) {
      normalized.push(payload);
      continue;
    }
    normalized.push(await normalizeMediaPaths(payload));
  }
  return normalized;
}
