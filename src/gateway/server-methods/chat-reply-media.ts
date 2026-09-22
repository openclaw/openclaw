import { isPassThroughRemoteMediaSource } from "@openclaw/media-core/media-source-url";
import { isAudioFileName } from "@openclaw/media-core/mime";
import { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveSessionPermissionCoreToolPolicy } from "../../agents/session-permission-exec-mode.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../../agents/tool-fs-policy.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyMediaFailure,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import type { ReplyDispatchOperation } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { collectReplyMediaEntries } from "../../infra/outbound/reply-media-entries.js";
import type { LocalMediaAccessError } from "../../media/local-media-access.js";
import {
  appendLocalMediaParentRoots,
  getAgentScopedMediaLocalRoots,
} from "../../media/local-roots.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { getMediaDir } from "../../media/store.js";
import { resolveSendableOutboundReplyParts } from "../../plugin-sdk/reply-payload.js";
import {
  captureChannelReadAuthority,
  withChannelReadAuthority,
} from "../../shared/channel-read-authority.js";
import { loadSessionEntry } from "../session-utils.js";
import { resolveSessionWorkerPlacementContext } from "../session-worker-placement-context.js";
import { resolveSessionWorkspaceRoots } from "../session-workspace-roots.js";
import { buildAssistantReplyContentFromInputs } from "./chat-assistant-content.js";
import {
  readChatSendReplyPayload,
  replaceChatSendReplyPayload,
} from "./chat-send-command-replies.js";
import { buildWebchatAssistantMessageFromReplyPayloads } from "./chat-webchat-media.js";

export type WebchatReplyMediaRequesterContext = Pick<
  MsgContext,
  | "SenderId"
  | "SenderName"
  | "SenderUsername"
  | "SenderE164"
  | "GroupChannel"
  | "GroupSpace"
  | "Provider"
  | "Surface"
>;

type WebchatReplyMediaScope = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionEntry: SessionEntry | undefined;
  requesterContext?: WebchatReplyMediaRequesterContext;
  sessionKey?: string;
  accountId?: string;
  assertCurrent?: () => void;
};

function resolveRequesterPolicyContext(requester?: WebchatReplyMediaRequesterContext) {
  return {
    requesterSenderId: requester?.SenderId,
    requesterSenderName: requester?.SenderName,
    requesterSenderUsername: requester?.SenderUsername,
    requesterSenderE164: requester?.SenderE164,
    groupChannel: requester?.GroupChannel,
    groupSpace: requester?.GroupSpace,
    messageProvider: requester?.Surface ?? requester?.Provider,
  };
}

/** Bind reads to the source session; reread its owner after every awaited file operation. */
export function captureWebchatReplyMediaScope(
  params: Omit<WebchatReplyMediaScope, "sessionEntry"> & {
    sessionKey: string;
    sessionLoadOptions?: Parameters<typeof loadSessionEntry>[1];
  },
): WebchatReplyMediaScope & { sessionKey: string; assertCurrent: () => void } {
  const readEntry = () => loadSessionEntry(params.sessionKey, params.sessionLoadOptions).entry;
  const sessionEntry = readEntry();
  const scope = { ...params, sessionEntry: sessionEntry ? { ...sessionEntry } : undefined };
  const authority = (entry: SessionEntry | undefined) => {
    const currentScope = { ...scope, sessionEntry: entry };
    const workspace = resolveWebchatReplyWorkspace(currentScope);
    return JSON.stringify([
      entry?.sessionId,
      entry?.lifecycleRevision,
      entry?.permissionMode,
      entry?.execNode,
      entry?.repositoryWorkspaceId,
      workspace.remote,
      workspace.workspaceDir,
      resolveWebchatReplyWorkspaceOnly(currentScope),
    ]);
  };
  const expected = authority(scope.sessionEntry);
  return {
    ...scope,
    assertCurrent: () => {
      params.assertCurrent?.();
      if (authority(readEntry()) !== expected) {
        throw new Error("Session media access changed before attachment delivery.");
      }
    },
  };
}

export async function prepareWebchatReplyMediaForDisplay(params: {
  scope: ReturnType<typeof captureWebchatReplyMediaScope>;
  inputs: readonly ReplyDispatchOperation[];
  storePath?: string;
  transcriptTarget?: { sessionKey: string; agentId?: string };
  abortSignal?: AbortSignal;
  includeSensitiveMedia?: boolean;
  includeSensitiveDisplay?: boolean;
  onLocalAudioAccessDenied?: (error: LocalMediaAccessError) => void;
  onManagedMediaPrepareError?: (message: string) => void;
  onSensitiveDisplayPrepareError?: (message: string) => void;
}) {
  const scope = params.scope;
  const sourcePayloads = params.inputs.map(readChatSendReplyPayload);
  const hasMedia = sourcePayloads.some(
    (payload) => resolveSendableOutboundReplyParts(payload).mediaUrls.length > 0,
  );
  return await withChannelReadAuthority(
    scope.assertCurrent,
    async () => {
      const payloads = await normalizeWebchatReplyMediaPathsForDisplay({
        ...scope,
        payloads: sourcePayloads,
      });
      const inputs = params.inputs.flatMap((input, index) => {
        const payload = payloads[index];
        return payload ? replaceChatSendReplyPayload(input, payload) : [];
      });
      const localRoots = getWebchatReplyMediaLocalRoots({ ...scope, storePath: params.storePath });
      const mediaMessage = await buildWebchatAssistantMessageFromReplyPayloads(
        inputs.map(readChatSendReplyPayload),
        {
          localRoots,
          assertCurrent: captureChannelReadAuthority(),
          onLocalAudioAccessDenied: params.onLocalAudioAccessDenied,
        },
      );
      const content = await buildAssistantReplyContentFromInputs({
        sessionKey: params.transcriptTarget?.sessionKey ?? scope.sessionKey,
        agentId: params.transcriptTarget?.agentId ?? scope.agentId,
        inputs,
        transcriptMediaMessage: mediaMessage,
        managedMediaLocalRoots: localRoots,
        assertCurrent: scope.assertCurrent,
        abortSignal: params.abortSignal,
        includeSensitiveMedia: params.includeSensitiveMedia,
        includeSensitiveDisplay: params.includeSensitiveDisplay,
        onManagedMediaPrepareError: params.onManagedMediaPrepareError,
        onSensitiveDisplayPrepareError: params.onSensitiveDisplayPrepareError,
      });
      return { ...content, inputs, payloads, mediaMessage };
    },
    hasMedia ? params.abortSignal : undefined,
  );
}

function resolveWebchatReplyWorkspace(params: WebchatReplyMediaScope) {
  const entry = params.sessionEntry;
  const placement =
    entry?.sessionId && !entry.execNode && !entry.repositoryWorkspaceId
      ? resolveSessionWorkerPlacementContext()
          .workerSessionPlacementService?.getMany([entry.sessionId])
          .get(entry.sessionId)
      : undefined;
  // Placement can be remote before any workspace metadata has been published.
  const remote = Boolean(
    entry?.execNode ||
    entry?.repositoryWorkspaceId ||
    isCloudWorkerPlacementState(placement?.state),
  );
  return {
    remote,
    workspaceDir:
      !remote && entry
        ? (entry.sessionRoot ??
          resolveSessionWorkspaceRoots(params.cfg, params.agentId, entry).root)
        : resolveAgentWorkspaceDir(params.cfg, params.agentId),
  };
}

function resolveWebchatReplyWorkspaceOnly(params: WebchatReplyMediaScope): boolean {
  const mode = params.sessionEntry?.permissionMode;
  return mode
    ? resolveSessionPermissionCoreToolPolicy({ mode }).workspaceOnly
    : resolveEffectiveToolFsWorkspaceOnly(params);
}

/** Trusted audio bypasses staging, but its reader must use the same session workspace. */
export function getWebchatReplyMediaLocalRoots(
  params: WebchatReplyMediaScope & { storePath?: string },
): readonly string[] {
  const { remote, workspaceDir } = resolveWebchatReplyWorkspace(params);
  if (remote) {
    return [getMediaDir()];
  }
  const workspaceRoots = getAgentScopedMediaLocalRoots(params.cfg, params.agentId, workspaceDir);
  const roots = resolveWebchatReplyWorkspaceOnly(params)
    ? workspaceRoots
    : [
        ...new Set([
          ...getAgentScopedMediaLocalRoots(params.cfg, params.agentId),
          ...workspaceRoots,
        ]),
      ];
  return (
    resolveAgentScopedOutboundMediaAccess({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      accountId: params.accountId,
      workspaceDir,
      workspaceOnly: resolveWebchatReplyWorkspaceOnly(params),
      mediaAccess: {
        localRoots: appendLocalMediaParentRoots(
          roots,
          params.storePath ? [params.storePath] : undefined,
        ),
      },
      ...resolveRequesterPolicyContext(params.requesterContext),
    }).localRoots ?? []
  );
}

function shouldPreserveDisplayMediaUrl(payload: ReplyPayload, mediaUrl: string): boolean {
  if (mediaUrl.trim().toLowerCase().startsWith("data:")) {
    return true;
  }
  if (!isAudioFileName(mediaUrl)) {
    return false;
  }
  if (isPassThroughRemoteMediaSource(mediaUrl)) {
    return true;
  }
  // Trusted audio keeps its playback path and size cap; the reader still enforces local roots.
  return payload.trustedLocalMedia === true;
}

/** Normalize reply media paths for webchat display without leaking sensitive media. */
export async function normalizeWebchatReplyMediaPathsForDisplay(
  params: WebchatReplyMediaScope & {
    sessionKey: string;
    accountId?: string;
    payloads: ReplyPayload[];
  },
): Promise<ReplyPayload[]> {
  return await withChannelReadAuthority(params.assertCurrent, async () => {
    if (
      params.payloads.every(
        (payload) =>
          payload.sensitiveMedia === true ||
          resolveSendableOutboundReplyParts(payload).mediaUrls.every((url) =>
            shouldPreserveDisplayMediaUrl(payload, url),
          ),
      )
    ) {
      return params.payloads;
    }
    const { remote, workspaceDir } = resolveWebchatReplyWorkspace(params);
    if (!workspaceDir) {
      return params.payloads;
    }
    const assertCurrent = captureChannelReadAuthority();
    const { createReplyMediaPathNormalizer } =
      await import("../../auto-reply/reply/reply-media-paths.runtime.js");
    assertCurrent?.();
    const workspaceOnly = resolveWebchatReplyWorkspaceOnly(params);
    const normalizeMediaPaths = createReplyMediaPathNormalizer({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      workspaceDir,
      sessionWorkspaceDir: workspaceOnly && !remote ? workspaceDir : undefined,
      workspaceOnly,
      allowHostWorkspace: !remote,
      accountId: params.accountId,
      ...resolveRequesterPolicyContext(params.requesterContext),
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
  });
}
