import { isPassThroughRemoteMediaSource } from "@openclaw/media-core/media-source-url";
import { isAudioFileName } from "@openclaw/media-core/mime";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { createReplyMediaPathNormalizer } from "../../auto-reply/reply/reply-media-paths.runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSendableOutboundReplyParts } from "../../plugin-sdk/reply-payload.js";

function isDataUrlMedia(mediaUrl: string): boolean {
  return mediaUrl.trim().toLowerCase().startsWith("data:");
}

function shouldPreserveDisplayMediaUrl(payload: ReplyPayload, mediaUrl: string): boolean {
  if (isDataUrlMedia(mediaUrl)) {
    return true;
  }
  if (!isAudioFileName(mediaUrl)) {
    return false;
  }
  if (isPassThroughRemoteMediaSource(mediaUrl)) {
    return true;
  }
  // Local audio is preserved only after the producer marks it as already trust-scoped.
  return payload.trustedLocalMedia === true;
}

/**
 * Normalizes reply media for WebChat display by staging local files into
 * Gateway-managed media storage while preserving media that is already safe to
 * render directly, such as data URLs and trust-scoped local audio.
 */
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
    if (payload.sensitiveMedia === true) {
      // Suppressed media must not be copied into managed outbound storage for display.
      normalized.push(payload);
      continue;
    }
    const mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
    if (!mediaUrls.some((mediaUrl) => shouldPreserveDisplayMediaUrl(payload, mediaUrl))) {
      normalized.push(await normalizeMediaPaths(payload));
      continue;
    }
    if (!mediaUrls.some((mediaUrl) => !shouldPreserveDisplayMediaUrl(payload, mediaUrl))) {
      normalized.push(payload);
      continue;
    }
    // Mixed replies keep directly renderable media in-place while normalizing
    // only the unsafe local entries, so one bad attachment cannot suppress a
    // surviving inline image or trust-scoped audio item.
    const mergedMediaUrls: string[] = [];
    const text = payload.text;
    for (const mediaUrl of mediaUrls) {
      if (shouldPreserveDisplayMediaUrl(payload, mediaUrl)) {
        mergedMediaUrls.push(mediaUrl);
        continue;
      }
      const normalizedPayload = await normalizeMediaPaths({
        ...payload,
        mediaUrl,
        mediaUrls: [mediaUrl],
      });
      const normalizedMediaUrls = resolveSendableOutboundReplyParts(normalizedPayload).mediaUrls;
      if (normalizedMediaUrls.length === 0) {
        continue;
      }
      mergedMediaUrls.push(...normalizedMediaUrls);
    }
    normalized.push({
      ...payload,
      text,
      mediaUrl: mergedMediaUrls[0],
      mediaUrls: mergedMediaUrls,
    });
  }
  return normalized;
}
