// Webchat reply media path normalizer for display-safe outbound payloads.
import { isPassThroughRemoteMediaSource } from "@openclaw/media-core/media-source-url";
import { isAudioFileName } from "@openclaw/media-core/mime";
import { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyMediaFailure,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { createReplyMediaPathNormalizer } from "../../auto-reply/reply/reply-media-paths.runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { collectReplyMediaEntries } from "../../infra/outbound/reply-media-entries.js";
import { resolveSendableOutboundReplyParts } from "../../plugin-sdk/reply-payload.js";
import { resolveSessionWorkerPlacementContext } from "../session-worker-placement-context.js";
import { resolveSessionWorkspaceRoots } from "../session-workspace-roots.js";

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

/** Normalize reply media paths for webchat display without leaking sensitive media. */
export async function normalizeWebchatReplyMediaPathsForDisplay(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  sessionEntry: SessionEntry | undefined;
  accountId?: string;
  payloads: ReplyPayload[];
}): Promise<ReplyPayload[]> {
  if (
    params.payloads.every(
      (payload) => resolveSendableOutboundReplyParts(payload).mediaUrls.length === 0,
    )
  ) {
    return params.payloads;
  }
  const entry = params.sessionEntry;
  const placement = entry?.sessionId
    ? resolveSessionWorkerPlacementContext()
        .workerSessionPlacementService?.getMany([entry.sessionId])
        .get(entry.sessionId)
    : undefined;
  // Remote workspace paths must never grant access to same-named Gateway directories.
  const remote =
    entry?.execNode ||
    entry?.repositoryWorkspaceId ||
    isCloudWorkerPlacementState(placement?.state);
  const workspaceDir =
    entry && !remote
      ? (entry.sessionRoot ?? resolveSessionWorkspaceRoots(params.cfg, params.agentId, entry).root)
      : resolveAgentWorkspaceDir(params.cfg, params.agentId);
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
    const mergedMediaUrls: string[] = [];
    const mergedAttachments: NonNullable<ReplyPayload["attachments"]> = [];
    const previousMediaFailures = getReplyPayloadMetadata(payload)?.assistantMediaFailures ?? [];
    const mediaFailures: ReplyMediaFailure[] = [...previousMediaFailures];
    let text = payload.text;
    for (const { url: mediaUrl, attachment } of collectReplyMediaEntries(payload, mediaUrls)) {
      if (shouldPreserveDisplayMediaUrl(payload, mediaUrl)) {
        mergedMediaUrls.push(mediaUrl);
        mergedAttachments.push(attachment ?? {});
        continue;
      }
      const normalizedPayload = await normalizeMediaPaths(
        copyReplyPayloadMetadata(payload, {
          ...payload,
          text,
          mediaUrl,
          mediaUrls: [mediaUrl],
          attachments: attachment ? [attachment] : undefined,
        }),
      );
      const normalizedMediaUrls = resolveSendableOutboundReplyParts(normalizedPayload).mediaUrls;
      mediaFailures.push(
        ...(getReplyPayloadMetadata(normalizedPayload)?.assistantMediaFailures ?? []).slice(
          previousMediaFailures.length,
        ),
      );
      text = normalizedPayload.text;
      if (normalizedMediaUrls.length === 0) {
        continue;
      }
      mergedMediaUrls.push(...normalizedMediaUrls);
      mergedAttachments.push(
        ...(normalizedPayload.attachments ?? normalizedMediaUrls.map(() => ({}))),
      );
    }
    const merged = copyReplyPayloadMetadata(payload, {
      ...payload,
      text,
      mediaUrl: mergedMediaUrls[0],
      mediaUrls: mergedMediaUrls,
      attachments: mergedAttachments,
    });
    normalized.push(
      mediaFailures.length > 0
        ? setReplyPayloadMetadata(merged, { assistantMediaFailures: mediaFailures })
        : merged,
    );
  }
  return normalized;
}
