import path from "node:path";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolvePathFromInput, toRelativeWorkspacePath } from "../../agents/path-policy.js";
import { assertMediaNotDataUrl, resolveSandboxedMediaSource } from "../../agents/sandbox-paths.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { resolveChannelAccountMediaMaxMb } from "../../media/configured-max-bytes.js";
import { isPassThroughRemoteMediaSource } from "../../media/media-source-url.js";
import { resolveOutboundAttachmentFromUrl } from "../../media/outbound-attachment.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { MEDIA_MAX_BYTES } from "../../media/store.js";
import { resolveConfigDir } from "../../utils.js";
import type { ReplyPayload } from "../types.js";

const FILE_URL_RE = /^file:\/\//i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HAS_FILE_EXT_RE = /\.\w{1,10}$/;
const MANAGED_GLOBAL_MEDIA_SUBDIRS = new Set(["outbound"]);

function isManagedGlobalReplyMediaPath(candidate: string): boolean {
  const globalMediaRoot = path.join(resolveConfigDir(), "media");
  const relative = path.relative(path.resolve(globalMediaRoot), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const firstSegment = relative.split(path.sep)[0] ?? "";
  return MANAGED_GLOBAL_MEDIA_SUBDIRS.has(firstSegment) || firstSegment.startsWith("tool-");
}

function isLikelyLocalMediaSource(media: string): boolean {
  return (
    FILE_URL_RE.test(media) ||
    media.startsWith("/") ||
    media.startsWith("./") ||
    media.startsWith("../") ||
    media.startsWith("~") ||
    WINDOWS_DRIVE_RE.test(media) ||
    media.startsWith("\\\\") ||
    (!SCHEME_RE.test(media) &&
      (media.includes("/") || media.includes("\\") || HAS_FILE_EXT_RE.test(media)))
  );
}

function getPayloadMediaList(payload: ReplyPayload): string[] {
  return resolveSendableOutboundReplyParts(payload).mediaUrls;
}

export class ReplyMediaNormalizationError extends Error {
  readonly attemptedMedia: string[];
  readonly failedMedia: string[];

  constructor(params: { attemptedMedia: string[]; failedMedia: string[]; cause?: unknown }) {
    const count = params.failedMedia.length;
    super(`Failed to normalize ${count} reply media item${count === 1 ? "" : "s"}.`, {
      cause: params.cause,
    });
    this.name = "ReplyMediaNormalizationError";
    this.attemptedMedia = [...params.attemptedMedia];
    this.failedMedia = [...params.failedMedia];
  }
}

function describeReplyMediaNormalizationFailure(err: unknown): string {
  const cause = err instanceof ReplyMediaNormalizationError ? err.cause : err;
  const message =
    cause instanceof Error ? cause.message.trim() : typeof cause === "string" ? cause.trim() : "";
  if (/host-local media file urls are blocked/i.test(message)) {
    return "Host file URLs are blocked in normal replies.";
  }
  if (/sandbox root/i.test(message)) {
    return "The requested file path resolves outside the allowed sandbox.";
  }
  if (/allowed directory|allowed media/i.test(message)) {
    return "The requested file path is outside the allowed media directories.";
  }
  if (/enoent|no such file/i.test(message)) {
    return "The requested file no longer exists.";
  }
  if (/too large|exceeds|larger than/i.test(message)) {
    return "The requested file is larger than the allowed attachment limit.";
  }
  return "OpenClaw couldn't stage the attachment.";
}

export function buildReplyMediaNormalizationFailurePayload(
  payload: ReplyPayload,
  err: unknown,
): ReplyPayload {
  return {
    text: `⚠️ I couldn't attach the requested media, so I didn't send a text-only fallback. ${describeReplyMediaNormalizationFailure(err)}`,
    isError: true,
    replyToId: payload.replyToId,
    replyToTag: payload.replyToTag,
    replyToCurrent: payload.replyToCurrent,
  };
}

function resolveReplyMediaMaxBytes(params: {
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
}): number {
  const limitMb =
    resolveChannelAccountMediaMaxMb(params) ?? params.cfg.agents?.defaults?.mediaMaxMb;
  return typeof limitMb === "number" && Number.isFinite(limitMb) && limitMb > 0
    ? Math.floor(limitMb * 1024 * 1024)
    : MEDIA_MAX_BYTES;
}

export function createReplyMediaPathNormalizer(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  workspaceDir: string;
  messageProvider?: string;
  accountId?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  requesterSenderId?: string;
  requesterSenderName?: string;
  requesterSenderUsername?: string;
  requesterSenderE164?: string;
}): (payload: ReplyPayload) => Promise<ReplyPayload> {
  // Prefer an explicit agentId so callers without a resolved sessionKey (e.g.
  // `openclaw agent --deliver` with `--reply-channel/--reply-to`) still get
  // the stricter agent-scoped file-read policy applied during staging.
  const agentId =
    params.agentId ??
    (params.sessionKey
      ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
      : undefined);
  const maxBytes = resolveReplyMediaMaxBytes({
    cfg: params.cfg,
    channel: params.messageProvider,
    accountId: params.accountId,
  });
  let sandboxRootPromise: Promise<string | undefined> | undefined;
  const persistedMediaBySource = new Map<string, Promise<string>>();

  const resolveSandboxRoot = async (): Promise<string | undefined> => {
    if (!sandboxRootPromise) {
      sandboxRootPromise = ensureSandboxWorkspaceForSession({
        config: params.cfg,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
      }).then((sandbox) => sandbox?.workspaceDir);
    }
    return await sandboxRootPromise;
  };

  const resolveMediaAccessForSource = (media: string) =>
    resolveAgentScopedOutboundMediaAccess({
      cfg: params.cfg,
      agentId,
      workspaceDir: params.workspaceDir,
      mediaSources: [media],
      sessionKey: params.sessionKey,
      messageProvider: params.sessionKey ? undefined : params.messageProvider,
      accountId: params.accountId,
      requesterSenderId: params.requesterSenderId,
      requesterSenderName: params.requesterSenderName,
      requesterSenderUsername: params.requesterSenderUsername,
      requesterSenderE164: params.requesterSenderE164,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
    });

  const persistLocalReplyMedia = async (media: string): Promise<string> => {
    if (!isLikelyLocalMediaSource(media)) {
      return media;
    }
    if (path.isAbsolute(media) && isManagedGlobalReplyMediaPath(media)) {
      return media;
    }
    const cached = persistedMediaBySource.get(media);
    if (cached) {
      return await cached;
    }
    const persistPromise = resolveOutboundAttachmentFromUrl(media, maxBytes, {
      mediaAccess: resolveMediaAccessForSource(media),
    })
      .then((saved) => saved.path)
      .catch((err) => {
        persistedMediaBySource.delete(media);
        throw err;
      });
    persistedMediaBySource.set(media, persistPromise);
    return await persistPromise;
  };

  const resolveWorkspaceRelativeMedia = (media: string): string => {
    const relativeWorkspacePath = toRelativeWorkspacePath(params.workspaceDir, media, {
      cwd: params.workspaceDir,
    });
    return resolvePathFromInput(relativeWorkspacePath, params.workspaceDir);
  };

  const resolveWorkspaceAbsoluteMediaInSandbox = (
    media: string,
    sandboxRoot: string,
  ): string | undefined => {
    if (FILE_URL_RE.test(media) || media.startsWith("~")) {
      return undefined;
    }
    const isAbsoluteLocalMedia = path.isAbsolute(media) || WINDOWS_DRIVE_RE.test(media);
    if (!isAbsoluteLocalMedia) {
      return undefined;
    }
    const relativeWorkspacePath = toRelativeWorkspacePath(params.workspaceDir, media, {
      cwd: params.workspaceDir,
    });
    return resolvePathFromInput(relativeWorkspacePath, sandboxRoot);
  };

  const normalizeMediaSource = async (raw: string): Promise<string> => {
    const media = raw.trim();
    if (!media) {
      return media;
    }
    assertMediaNotDataUrl(media);
    if (isPassThroughRemoteMediaSource(media)) {
      return media;
    }
    const isRelativeLocalMedia =
      isLikelyLocalMediaSource(media) &&
      !FILE_URL_RE.test(media) &&
      !media.startsWith("~") &&
      !path.isAbsolute(media) &&
      !WINDOWS_DRIVE_RE.test(media);
    const sandboxRoot = await resolveSandboxRoot();
    if (sandboxRoot) {
      const sandboxWorkspaceMedia = resolveWorkspaceAbsoluteMediaInSandbox(media, sandboxRoot);
      if (sandboxWorkspaceMedia) {
        return await persistLocalReplyMedia(sandboxWorkspaceMedia);
      }
      let sandboxResolvedMedia: string;
      try {
        sandboxResolvedMedia = await resolveSandboxedMediaSource({
          media,
          sandboxRoot,
        });
      } catch (err) {
        if (FILE_URL_RE.test(media)) {
          throw new Error(
            "Host-local MEDIA file URLs are blocked in normal replies. Use a safe path or the message tool.",
            { cause: err },
          );
        }
        throw err;
      }
      return await persistLocalReplyMedia(sandboxResolvedMedia);
    }
    if (isRelativeLocalMedia) {
      return await persistLocalReplyMedia(resolveWorkspaceRelativeMedia(media));
    }
    if (!isLikelyLocalMediaSource(media)) {
      return media;
    }
    if (FILE_URL_RE.test(media)) {
      throw new Error(
        "Host-local MEDIA file URLs are blocked in normal replies. Use a safe path or the message tool.",
      );
    }
    return await persistLocalReplyMedia(media);
  };

  return async (payload) => {
    const mediaList = getPayloadMediaList(payload);
    if (mediaList.length === 0) {
      return payload;
    }

    const normalizedMedia: string[] = [];
    const seen = new Set<string>();
    for (const media of mediaList) {
      let normalized: string;
      try {
        normalized = await normalizeMediaSource(media);
      } catch (err) {
        logVerbose(`dropping blocked reply media ${media}: ${String(err)}`);
        throw new ReplyMediaNormalizationError({
          attemptedMedia: mediaList,
          failedMedia: [media],
          cause: err,
        });
      }
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      normalizedMedia.push(normalized);
    }

    if (normalizedMedia.length === 0) {
      return {
        ...payload,
        mediaUrl: undefined,
        mediaUrls: undefined,
      };
    }

    return {
      ...payload,
      mediaUrl: normalizedMedia[0],
      mediaUrls: normalizedMedia,
    };
  };
}
