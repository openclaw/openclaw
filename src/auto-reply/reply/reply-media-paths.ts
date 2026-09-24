// Resolves media paths from reply payloads into runtime attachment metadata.
import path from "node:path";
import { mediaKindFromMime } from "@openclaw/media-core/constants";
import { basenameFromAnyPath } from "@openclaw/media-core/file-name";
import { isPassThroughRemoteMediaSource } from "@openclaw/media-core/media-source-url";
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  resolvePathFromInput,
  resolveSandboxPathMapping,
  toRelativeWorkspacePath,
} from "../../agents/path-policy.js";
import {
  assertMediaNotDataUrl,
  resolveAllowedManagedMediaPath,
  resolveSandboxedMediaSource,
} from "../../agents/sandbox-paths.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox.js";
import type { SandboxWorkspaceAccess } from "../../agents/sandbox/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { sanitizeUntrustedFileName } from "../../infra/fs-safe-advanced.js";
import { FsSafeError } from "../../infra/fs-safe.js";
import { collectReplyMediaEntries } from "../../infra/outbound/reply-media-entries.js";
import { resolveOutboundMediaMaxBytes } from "../../media/configured-max-bytes.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import { HostReadMediaTypeError, LocalMediaAccessError } from "../../media/local-media-access.js";
import { normalizeMediaReferenceForComparison } from "../../media/media-reference-comparison.js";
import { resolveOutboundAttachmentFromUrl } from "../../media/outbound-attachment.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import {
  appendReplyMediaFailures,
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyMediaFailure,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

const FILE_URL_RE = /^file:/i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HAS_FILE_EXT_RE = /\.\w{1,10}$/;
const MAX_FAILURE_LABEL_LENGTH = 180;

function resolveReplyMediaFailureLabel(media: string, index: number): string {
  const trimmed = media.trim();
  let source = trimmed;
  if (SCHEME_RE.test(trimmed)) {
    try {
      source = new URL(trimmed).pathname;
    } catch {
      // Fall through to path-style basename handling for malformed sources.
    }
  }
  const basename = basenameFromAnyPath(source).trim();
  const fallback = `Attachment ${index + 1}`;
  return truncateUtf16Safe(
    sanitizeUntrustedFileName(basename, fallback) || fallback,
    MAX_FAILURE_LABEL_LENGTH,
  );
}

function resolveReplyMediaFailureKind(media: string): ReplyMediaFailure["kind"] {
  const kind = mediaKindFromMime(mimeTypeFromFilePath(media));
  return kind === "image" || kind === "audio" || kind === "video" ? kind : "document";
}

function resolveReplyMediaFailureCode(error: unknown): ReplyMediaFailure["code"] {
  let current: unknown = error;
  // Media loaders wrap filesystem/policy errors; bound cause traversal so malformed cycles fail safe.
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (
      (current instanceof LocalMediaAccessError && current.code === "not-found") ||
      (current instanceof FsSafeError && current.code === "not-found")
    ) {
      return "file-not-found";
    }
    if (
      current instanceof HostReadMediaTypeError ||
      (current instanceof LocalMediaAccessError && current.code === "unsupported-media-type")
    ) {
      return "unsupported-format";
    }
    current = current.cause;
  }
  return "delivery-failed";
}

function createReplyMediaFailure(media: string, index: number, error: unknown): ReplyMediaFailure {
  const mimeType = mimeTypeFromFilePath(media);
  return {
    code: resolveReplyMediaFailureCode(error),
    kind: resolveReplyMediaFailureKind(media),
    label: resolveReplyMediaFailureLabel(media, index),
    ...(mimeType ? { mimeType } : {}),
  };
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

type PreparedReplyMediaSource = {
  mediaUrl: string;
  trustedLocalMedia: boolean;
  fileName?: string;
  mimeType?: string;
};

/** Delivery facts only; contains no live reader or transcript changes. */
export type PreparedReplyMedia = readonly {
  source: string;
  outcome: PreparedReplyMediaSource | { failure: ReplyMediaFailure };
}[];

export function createReplyMediaSourcePreparer(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  workspaceDir: string;
  sessionWorkspaceDir?: string;
  workspaceOnly?: boolean;
  allowHostWorkspace?: boolean;
  messageProvider?: string;
  accountId?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  requesterSenderId?: string;
  requesterSenderName?: string;
  requesterSenderUsername?: string;
  requesterSenderE164?: string;
  sandboxRoot?: string;
  sandboxContainerWorkdir?: string;
  mediaAccess?: OutboundMediaAccess;
  workspaceMediaAccess?: OutboundMediaAccess;
  /** Physical remote alias of the captured logical workspace. */
  workspaceMediaRoot?: string;
}): (sources: readonly string[]) => Promise<PreparedReplyMedia> {
  // Prefer an explicit agentId so callers without a resolved sessionKey (e.g.
  // `openclaw agent --deliver` with `--reply-channel/--reply-to`) still get
  // the stricter agent-scoped file-read policy applied during staging.
  const agentId =
    params.agentId ??
    (params.sessionKey
      ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
      : undefined);
  const maxBytes = resolveOutboundMediaMaxBytes({
    cfg: params.cfg,
    channel: params.messageProvider,
    accountId: params.accountId,
  });
  const explicitSandboxRoot = params.sandboxRoot?.trim();
  let sandboxWorkspacePromise:
    | Promise<
        | {
            root: string;
            containerWorkdir?: string;
            workspaceAccess: SandboxWorkspaceAccess;
          }
        | undefined
      >
    | undefined = explicitSandboxRoot
    ? Promise.resolve({
        root: explicitSandboxRoot,
        containerWorkdir: params.sandboxContainerWorkdir,
        // A caller-held workspace reader is proof of a mounted read path; otherwise fail closed.
        workspaceAccess: params.workspaceMediaAccess?.readFile ? "ro" : "none",
      })
    : undefined;
  const persistedMediaBySource = new Map<string, Promise<{ path: string; contentType?: string }>>();

  const resolveSandboxWorkspace = async () => {
    if (!sandboxWorkspacePromise) {
      sandboxWorkspacePromise = ensureSandboxWorkspaceForSession({
        config: params.cfg,
        agentId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
      }).then((sandbox) =>
        sandbox
          ? {
              root: sandbox.workspaceDir,
              containerWorkdir: sandbox.containerWorkdir,
              // Fail closed when access metadata is absent: treat as unmounted.
              workspaceAccess: sandbox.workspaceAccess ?? "none",
            }
          : undefined,
      );
    }
    return await sandboxWorkspacePromise;
  };

  const resolveMediaAccessForSource = (
    media: string,
    sessionWorkspaceDir?: string,
    workspaceDir?: string,
  ) =>
    resolveAgentScopedOutboundMediaAccess({
      cfg: params.cfg,
      agentId,
      workspaceDir: workspaceDir ?? params.workspaceDir,
      sessionWorkspaceDir: sessionWorkspaceDir ?? params.sessionWorkspaceDir,
      workspaceOnly: params.workspaceOnly,
      allowHostWorkspace: params.allowHostWorkspace,
      mediaSources: [media],
      mediaAccess: params.mediaAccess,
      workspaceMediaAccess: params.workspaceMediaAccess,
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

  const persistLocalReplyMedia = async (
    media: string,
    sessionWorkspaceDir?: string,
    workspaceDir?: string,
  ): Promise<{ path: string; contentType?: string }> => {
    if (!isLikelyLocalMediaSource(media)) {
      return { path: media };
    }
    const managedMediaPath = await resolveAllowedManagedMediaPath(media);
    if (managedMediaPath) {
      return {
        path: managedMediaPath,
        contentType: mimeTypeFromFilePath(managedMediaPath),
      };
    }
    const cached = persistedMediaBySource.get(media);
    if (cached) {
      return await cached;
    }
    const persistPromise = resolveOutboundAttachmentFromUrl(media, maxBytes, {
      mediaAccess: resolveMediaAccessForSource(media, sessionWorkspaceDir, workspaceDir),
    })
      .then((saved) => ({
        ...saved,
        contentType: saved.contentType ?? mimeTypeFromFilePath(media) ?? "application/octet-stream",
      }))
      .catch((err: unknown) => {
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

  const resolveAbsoluteWorkspaceMedia = (media: string): string | undefined => {
    if (FILE_URL_RE.test(media) || (!path.isAbsolute(media) && !WINDOWS_DRIVE_RE.test(media))) {
      return undefined;
    }
    try {
      return resolveWorkspaceRelativeMedia(media);
    } catch {
      return undefined;
    }
  };

  const normalizeMediaSource = async (
    raw: string,
  ): Promise<{
    mediaUrl: string;
    trustedLocalMedia: boolean;
    fileName?: string;
    mimeType?: string;
  }> => {
    const source = raw.trim();
    const mapping = params.workspaceMediaRoot
      ? resolveSandboxPathMapping(
          [{ hostRoot: params.workspaceDir, containerRoot: params.workspaceMediaRoot }],
          source,
        )
      : null;
    const media = mapping?.hostPath ?? source;
    if (!media) {
      return { mediaUrl: media, trustedLocalMedia: false };
    }
    assertMediaNotDataUrl(media);
    if (isPassThroughRemoteMediaSource(media)) {
      return { mediaUrl: media, trustedLocalMedia: false };
    }
    const sandboxWorkspace = await resolveSandboxWorkspace();
    // A sandboxed session whose workspace is not mounted into the sandbox
    // (workspaceAccess "none") must not read host-workspace files through media
    // staging; the sandbox branch below owns those paths and fails closed.
    const workspaceMounted = !sandboxWorkspace || sandboxWorkspace.workspaceAccess !== "none";
    const absoluteWorkspaceMedia = workspaceMounted
      ? resolveAbsoluteWorkspaceMedia(media)
      : undefined;
    if (absoluteWorkspaceMedia) {
      const persisted = await persistLocalReplyMedia(absoluteWorkspaceMedia);
      return {
        mediaUrl: persisted.path,
        trustedLocalMedia: true,
        fileName: path.basename(absoluteWorkspaceMedia),
        ...(persisted.contentType ? { mimeType: persisted.contentType } : {}),
      };
    }
    const isRelativeLocalMedia =
      isLikelyLocalMediaSource(media) &&
      !FILE_URL_RE.test(media) &&
      !media.startsWith("~") &&
      !path.isAbsolute(media) &&
      !WINDOWS_DRIVE_RE.test(media);
    // Use the remote reader for relative workspace output only when sandbox policy
    // permits workspace access; otherwise keep the sandbox's fail-closed path.
    const useRemoteWorkspace =
      workspaceMounted &&
      isRelativeLocalMedia &&
      params.workspaceMediaRoot &&
      params.workspaceMediaAccess?.readFile;
    if (sandboxWorkspace && !useRemoteWorkspace) {
      let sandboxResolvedMedia: string;
      try {
        sandboxResolvedMedia = await resolveSandboxedMediaSource({
          media,
          sandboxRoot: sandboxWorkspace.root,
          containerWorkdir: sandboxWorkspace.containerWorkdir,
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
      const persisted = await persistLocalReplyMedia(
        sandboxResolvedMedia,
        sandboxWorkspace.root,
        // Without a mounted workspace, the session's media workspace is its sandbox,
        // never the host agent workspace.
        workspaceMounted ? undefined : sandboxWorkspace.root,
      );
      return {
        mediaUrl: persisted.path,
        trustedLocalMedia: true,
        fileName: path.basename(sandboxResolvedMedia),
        ...(persisted.contentType ? { mimeType: persisted.contentType } : {}),
      };
    }
    if (isRelativeLocalMedia) {
      const workspaceMedia = resolveWorkspaceRelativeMedia(media);
      const persisted = await persistLocalReplyMedia(workspaceMedia);
      return {
        mediaUrl: persisted.path,
        trustedLocalMedia: true,
        fileName: path.basename(workspaceMedia),
        ...(persisted.contentType ? { mimeType: persisted.contentType } : {}),
      };
    }
    if (!isLikelyLocalMediaSource(media)) {
      return { mediaUrl: media, trustedLocalMedia: false };
    }
    if (FILE_URL_RE.test(media)) {
      throw new Error(
        "Host-local MEDIA file URLs are blocked in normal replies. Use a safe path or the message tool.",
      );
    }
    const persisted = await persistLocalReplyMedia(media);
    return {
      mediaUrl: persisted.path,
      trustedLocalMedia: true,
      fileName: path.basename(media),
      ...(persisted.contentType ? { mimeType: persisted.contentType } : {}),
    };
  };

  return async (sources) => {
    const prepared: Array<PreparedReplyMedia[number]> = [];
    for (const [index, source] of sources.entries()) {
      try {
        prepared.push({ source, outcome: await normalizeMediaSource(source) });
      } catch (error) {
        prepared.push({
          source,
          outcome: { failure: createReplyMediaFailure(source, index, error) },
        });
        logVerbose(`dropping blocked reply media ${source}: ${String(error)}`);
      }
    }
    return prepared;
  };
}

/** Applies already-prepared bytes after final answer selection, without reopening files. */
export function applyPreparedReplyMedia(
  payload: ReplyPayload,
  prepared: PreparedReplyMedia,
): ReplyPayload {
  const mediaList = getPayloadMediaList(payload);
  if (!mediaList.length || !prepared.length) {
    return payload;
  }
  const bySource = new Map(prepared.map(({ source, outcome }) => [source, outcome]));
  const normalizedMedia: string[] = [];
  const normalizedAttachments: NonNullable<ReplyPayload["attachments"]> = [];
  const previousSourceUrls = getReplyPayloadMetadata(payload)?.replyMediaSourceUrls;
  const sourcesByReference = new Map<string, Set<string>>();
  const seen = new Set<string>();
  let hasTrustedLocalMedia = payload.trustedLocalMedia === true;
  const mediaFailures: ReplyMediaFailure[] = [];
  const mediaEntries = collectReplyMediaEntries(payload, mediaList);
  for (const { url: media, attachment } of mediaEntries) {
    const normalized: PreparedReplyMedia[number]["outcome"] = bySource.get(media) ?? {
      mediaUrl: media,
      trustedLocalMedia: false,
    };
    if ("failure" in normalized) {
      mediaFailures.push(normalized.failure);
      continue;
    }
    if (!normalized.mediaUrl) {
      continue;
    }
    const normalizedKey = normalizeMediaReferenceForComparison(normalized.mediaUrl);
    const sourceKey = normalizeMediaReferenceForComparison(media);
    const sourceUrls = sourcesByReference.get(normalizedKey) ?? new Set<string>();
    for (const source of previousSourceUrls?.get(sourceKey) ?? []) {
      sourceUrls.add(source);
    }
    if (normalized.mediaUrl !== media.trim()) {
      sourceUrls.add(media.trim());
    }
    if (sourceUrls.size > 0) {
      sourcesByReference.set(normalizedKey, sourceUrls);
    }
    if (seen.has(normalized.mediaUrl)) {
      continue;
    }
    seen.add(normalized.mediaUrl);
    normalizedMedia.push(normalized.mediaUrl);
    hasTrustedLocalMedia ||= normalized.trustedLocalMedia;
    const existingAttachment = attachment ?? {};
    const normalizedAttachment = {
      ...existingAttachment,
      ...(normalized.fileName && !existingAttachment.name ? { name: normalized.fileName } : {}),
      ...(normalized.mimeType && !existingAttachment.mimeType
        ? { mimeType: normalized.mimeType }
        : {}),
      ...(normalized.trustedLocalMedia ? { trustedLocalMedia: true } : {}),
    };
    if (normalized.mediaUrl !== media) {
      for (const field of ["path", "url", "mediaUrl", "filePath"] as const) {
        if (normalizedAttachment[field] !== undefined) {
          normalizedAttachment[field] = normalized.mediaUrl;
        }
      }
    }
    normalizedAttachments.push(normalizedAttachment);
  }

  const replyMediaSourceUrls =
    sourcesByReference.size > 0
      ? new Map<string, readonly string[]>(
          [...sourcesByReference].map(([key, sources]) => [key, [...sources]]),
        )
      : undefined;
  const text = appendReplyMediaFailures(payload.text, mediaFailures);
  const previousMediaFailures = getReplyPayloadMetadata(payload)?.assistantMediaFailures ?? [];
  const assistantMediaFailures = [...previousMediaFailures, ...mediaFailures];

  if (normalizedMedia.length === 0) {
    const normalized = copyReplyPayloadMetadata(payload, {
      ...payload,
      text,
      mediaUrl: undefined,
      mediaUrls: undefined,
      attachments: undefined,
    });
    return setReplyPayloadMetadata(normalized, {
      replyMediaSourceUrls: undefined,
      ...(mediaFailures.length > 0 ? { assistantMediaFailures } : {}),
    });
  }

  const normalized = copyReplyPayloadMetadata(payload, {
    ...payload,
    text,
    mediaUrl: normalizedMedia[0],
    mediaUrls: normalizedMedia,
    attachments: normalizedAttachments.some((attachment) => Object.keys(attachment).length > 0)
      ? normalizedAttachments
      : undefined,
    ...(hasTrustedLocalMedia ? { trustedLocalMedia: true } : {}),
  });
  return setReplyPayloadMetadata(normalized, {
    replyMediaSourceUrls,
    ...(mediaFailures.length > 0 ? { assistantMediaFailures } : {}),
  });
}

export function createReplyMediaPathNormalizer(
  params: Parameters<typeof createReplyMediaSourcePreparer>[0],
): (payload: ReplyPayload) => Promise<ReplyPayload> {
  const prepare = createReplyMediaSourcePreparer(params);
  return async (payload) =>
    applyPreparedReplyMedia(payload, await prepare(getPayloadMediaList(payload)));
}

export type ReplyMediaContext = {
  normalizePayload: (payload: ReplyPayload) => Promise<ReplyPayload>;
};

export function createReplyMediaContext(
  params: Parameters<typeof createReplyMediaPathNormalizer>[0] & {
    mediaNormalizationOwner?: "gateway";
  },
): ReplyMediaContext {
  return {
    normalizePayload:
      params.mediaNormalizationOwner === "gateway"
        ? async (payload) => payload
        : createReplyMediaPathNormalizer(params),
  };
}
