import path from "node:path";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolvePathFromInput } from "../../agents/path-policy.js";
import { assertMediaNotDataUrl, resolveSandboxedMediaSource } from "../../agents/sandbox-paths.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../../agents/tool-fs-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { readPathWithinRoot } from "../../infra/fs-safe.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { resolveConfiguredMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { isPassThroughRemoteMediaSource } from "../../media/media-source-url.js";
import { saveMediaBuffer, saveMediaSource } from "../../media/store.js";
import { isPassThroughRemoteMediaSource } from "../../media/media-source-url.js";
import { resolveConfigDir } from "../../utils.js";
import type { ReplyPayload } from "../types.js";

const FILE_URL_RE = /^file:\/\//i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HAS_FILE_EXT_RE = /\.\w{1,10}$/;
const MANAGED_GLOBAL_MEDIA_SUBDIRS = new Set(["outbound"]);
let cachedPreferredTmpRoot: string | null | undefined;

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isManagedGlobalReplyMediaPath(candidate: string): boolean {
  const globalMediaRoot = path.join(resolveConfigDir(), "media");
  const relative = path.relative(path.resolve(globalMediaRoot), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const firstSegment = relative.split(path.sep)[0] ?? "";
  return MANAGED_GLOBAL_MEDIA_SUBDIRS.has(firstSegment) || firstSegment.startsWith("tool-");
}

function resolvePreferredReplyMediaTmpRoot(): string | undefined {
  if (cachedPreferredTmpRoot !== undefined) {
    return cachedPreferredTmpRoot ?? undefined;
  }
  try {
    cachedPreferredTmpRoot = path.resolve(resolvePreferredOpenClawTmpDir());
  } catch {
    cachedPreferredTmpRoot = null;
  }
  return cachedPreferredTmpRoot ?? undefined;
}

function buildVolatileReplyMediaRoots(): string[] {
  const roots: string[] = [];
  const preferredTmpRoot = resolvePreferredReplyMediaTmpRoot();
  if (preferredTmpRoot) {
    roots.push(preferredTmpRoot);
  }
  return roots;
}

function resolveRootScopedReplyMediaBoundary(params: {
  candidate: string;
  workspaceDir: string;
  sandboxRoot?: string;
}): string | undefined {
  if (isPathInside(params.workspaceDir, params.candidate)) {
    return path.resolve(params.workspaceDir);
  }
  if (params.sandboxRoot && isPathInside(params.sandboxRoot, params.candidate)) {
    return path.resolve(params.sandboxRoot);
  }
  return undefined;
}

function isAllowedAbsoluteReplyMediaPath(params: { candidate: string }): boolean {
  if (isManagedGlobalReplyMediaPath(params.candidate)) {
    return true;
  }
  const preferredTmpRoot = resolvePreferredReplyMediaTmpRoot();
  if (preferredTmpRoot && isPathInside(preferredTmpRoot, params.candidate)) {
    return true;
  }
  return false;
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

export function createReplyMediaPathNormalizer(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  workspaceDir: string;
}): (payload: ReplyPayload) => Promise<ReplyPayload> {
  const agentId = params.sessionKey
    ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
    : undefined;
  const workspaceOnly = resolveEffectiveToolFsWorkspaceOnly({
    cfg: params.cfg,
    agentId,
  });
  const configuredMediaMaxBytes = resolveConfiguredMediaMaxBytes(params.cfg);
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

  const persistVolatileReplyMedia = async (media: string): Promise<string> => {
    if (!path.isAbsolute(media)) {
      return media;
    }
    const sandboxRoot = await resolveSandboxRoot();
    const rootScopedBoundary = resolveRootScopedReplyMediaBoundary({
      candidate: media,
      workspaceDir: params.workspaceDir,
      sandboxRoot,
    });
    if (rootScopedBoundary) {
      const cached = persistedMediaBySource.get(media);
      if (cached) {
        return await cached;
      }
      const persistPromise = readPathWithinRoot({
        rootDir: rootScopedBoundary,
        filePath: media,
        maxBytes: configuredMediaMaxBytes,
      })
        .then(async ({ buffer }) => {
          const saved = await saveMediaBuffer(
            buffer,
            undefined,
            "outbound",
            configuredMediaMaxBytes,
            path.basename(media),
          );
          return saved.path;
        })
        .catch((err) => {
          persistedMediaBySource.delete(media);
          throw err;
        });
      persistedMediaBySource.set(media, persistPromise);
      return await persistPromise;
    }
    const volatileRoots = buildVolatileReplyMediaRoots();
    if (!volatileRoots.some((root) => isPathInside(root, media))) {
      return media;
    }
    const cached = persistedMediaBySource.get(media);
    if (cached) {
      return await cached;
    }
    const persistPromise = saveMediaSource(media, undefined, "outbound", configuredMediaMaxBytes)
      .then((saved) => saved.path)
      .catch((err) => {
        persistedMediaBySource.delete(media);
        throw err;
      });
    persistedMediaBySource.set(media, persistPromise);
    try {
      return await persistPromise;
    } catch (err) {
      logVerbose(`failed to persist volatile reply media ${media}: ${String(err)}`);
      return media;
    }
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
    const sandboxRoot = await resolveSandboxRoot();
    if (sandboxRoot) {
      try {
        return await resolveSandboxedMediaSource({
          media,
          sandboxRoot,
        });
      } catch (err) {
        if (!isLikelyLocalMediaSource(media) || FILE_URL_RE.test(media)) {
          throw err;
        }
        if (workspaceOnly) {
          throw err;
        }
        if (!path.isAbsolute(media)) {
          return resolvePathFromInput(media, params.workspaceDir);
        }
        if (isPathInside(params.workspaceDir, media)) {
          return media;
        }
        if (
          isAllowedAbsoluteReplyMediaPath({
            candidate: media,
          })
        ) {
          return media;
        }
        throw new Error(
          "Absolute host-local MEDIA paths are blocked in normal replies. Use a safe relative path or the message tool.",
          { cause: err },
        );
      }
    }
    if (!isLikelyLocalMediaSource(media)) {
      return media;
    }
    if (FILE_URL_RE.test(media)) {
      throw new Error(
        "Absolute host-local MEDIA file URLs are blocked in normal replies. Use a safe relative path or the message tool.",
      );
    }
    if (!path.isAbsolute(media)) {
      return resolvePathFromInput(media, params.workspaceDir);
    }
    if (isPathInside(params.workspaceDir, media)) {
      return media;
    }
    if (
      isAllowedAbsoluteReplyMediaPath({
        candidate: media,
      })
    ) {
      return media;
    }
    throw new Error(
      "Absolute host-local MEDIA paths are blocked in normal replies. Use a safe relative path or the message tool.",
    );
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
        normalized = await persistVolatileReplyMedia(await normalizeMediaSource(media));
      } catch (err) {
        logVerbose(`dropping blocked reply media ${media}: ${String(err)}`);
        continue;
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
