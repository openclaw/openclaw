import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import type { OpenClawConfig } from "../../config/config.js";
import { expandHomePrefix } from "../../infra/home-dir.js";
import { isPathInside } from "../../infra/path-guards.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { saveMediaSource } from "../../media/store.js";

const HTTP_URL_RE = /^https?:\/\//i;
const FILE_URL_RE = /^file:\/\//i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
/** Non-file schemes (e.g. media://) that must pass through unchanged. */
const OPAQUE_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function isUnderAnyMediaRoot(target: string, roots: readonly string[]): boolean {
  const resolvedTarget = path.resolve(target);
  for (const root of roots) {
    if (isPathInside(path.resolve(root), resolvedTarget)) {
      return true;
    }
  }
  return false;
}

function resolveOutboundLocalFilesystemPath(raw: string): string {
  const trimmed = raw.trim();
  if (FILE_URL_RE.test(trimmed)) {
    return path.resolve(fileURLToPath(trimmed));
  }
  const expanded = trimmed.startsWith("~") ? expandHomePrefix(trimmed) : trimmed;
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  return path.resolve(process.cwd(), expanded);
}

function shouldPassThroughUnstaged(media: string): boolean {
  const t = media.trim();
  if (!t) {
    return true;
  }
  if (HTTP_URL_RE.test(t)) {
    return true;
  }
  if (FILE_URL_RE.test(t)) {
    return false;
  }
  if (WINDOWS_DRIVE_RE.test(t)) {
    return false;
  }
  if (OPAQUE_SCHEME_RE.test(t)) {
    return true;
  }
  return false;
}

/**
 * Gateway RPC only carries media URL strings; the gateway process must read the
 * bytes from paths under {@link getAgentScopedMediaLocalRoots}. CLI users often
 * pass arbitrary absolute paths (e.g. ~/Downloads/x.ogg) that are outside those
 * roots. Copy into the managed media cache on the CLI host before invoking the
 * gateway so delivery matches the agent path (which uses `saveMediaSource`).
 */
export async function stageLocalMediaPathsForGatewayRpc(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
}): Promise<{ mediaUrl?: string; mediaUrls?: string[] }> {
  const urls = resolveOutboundMediaUrls({
    mediaUrl: params.mediaUrl,
    mediaUrls: params.mediaUrls,
  });
  if (urls.length === 0) {
    return { mediaUrl: params.mediaUrl, mediaUrls: params.mediaUrls };
  }

  const roots = getAgentScopedMediaLocalRoots(params.cfg, params.agentId);
  const staged: string[] = [];

  for (const raw of urls) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    if (shouldPassThroughUnstaged(trimmed)) {
      staged.push(trimmed);
      continue;
    }

    const absolutePath = resolveOutboundLocalFilesystemPath(trimmed);
    if (isUnderAnyMediaRoot(absolutePath, roots)) {
      staged.push(absolutePath);
      continue;
    }

    const saved = await saveMediaSource(absolutePath, undefined, "outbound");
    staged.push(saved.path);
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of staged) {
    if (!seen.has(entry)) {
      seen.add(entry);
      deduped.push(entry);
    }
  }

  if (deduped.length === 0) {
    return { mediaUrl: undefined, mediaUrls: undefined };
  }
  if (deduped.length === 1) {
    return { mediaUrl: deduped[0], mediaUrls: undefined };
  }
  return { mediaUrl: undefined, mediaUrls: deduped };
}
