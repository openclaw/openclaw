import path from "node:path";
import { detectMime } from "@openclaw/media-core/mime";
import {
  SESSIONS_FILES_ASSET_MAX_BYTES,
  SESSIONS_FILES_ASSETS_MAX_TOTAL_BYTES,
  type SessionFileEntry,
  type SessionsFilesAssetsResult,
} from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { WORKSPACE_PREVIEW_MAX_BYTES } from "../workspace-file-limits.js";
import { resolveSessionFileReadTarget, type SessionFileReadBoundary } from "./session-file-read.js";
import { resolveRepositoryArtifactPath } from "./session-repository-artifacts.js";
import { decodeUtf8Strict, readWorkspaceFile, statWorkspacePath } from "./workspace-fs.js";

type SessionWorkspaceAssetsParams = SessionFileReadBoundary & {
  path: string;
  refs: string[];
  assertCurrent?: () => void;
  repositoryFile?: (path: string) => Promise<SessionFileEntry | undefined>;
};
type AssetError = Extract<SessionsFilesAssetsResult["assets"][number], { error: string }>["error"];

function relativeAssetPath(ref: string): string | undefined {
  const value = ref.trim();
  if (!value || value.startsWith("#")) {
    return undefined;
  }
  try {
    const decoded = decodeURIComponent(value.split(/[?#]/u, 1)[0] ?? "").replaceAll("\\", "/");
    if (
      !decoded ||
      decoded.startsWith("/") ||
      decoded.startsWith("~") ||
      decoded.includes("\0") ||
      /^[a-z][a-z\d+.-]*:/iu.test(decoded)
    ) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

async function assetMime(buffer: Buffer, filePath: string): Promise<string | undefined> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".css" || extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return decodeUtf8Strict(buffer) === undefined
      ? undefined
      : extension === ".css"
        ? "text/css"
        : "text/javascript";
  }
  const mime = await detectMime({ buffer, filePath });
  return mime && /^(?:image|audio|video)\//u.test(mime) ? mime : undefined;
}

async function readAsset(
  params: SessionWorkspaceAssetsParams,
  relativePath: string,
  maxBytes: number,
): Promise<{ buffer: Buffer; filePath: string } | AssetError> {
  if (params.repositoryFile) {
    const filePath = resolveRepositoryArtifactPath(
      path.posix.join(path.posix.dirname(params.path), relativePath),
    );
    if (filePath === undefined) {
      return "outside_session_boundary";
    }
    let file: SessionFileEntry | undefined;
    try {
      file = await params.repositoryFile(filePath);
    } catch {
      params.assertCurrent?.();
      return "not_found";
    }
    params.assertCurrent?.();
    if (!file || file.missing) {
      return "not_found";
    }
    // Repository inspection supplies bounded previews, not an unrestricted raw-file transport.
    const previewMaxBytes = Math.min(maxBytes, WORKSPACE_PREVIEW_MAX_BYTES);
    if (previewMaxBytes === 0 || (file.size !== undefined && file.size > previewMaxBytes)) {
      return "too_large";
    }
    if (file.previewKind === "unsupported" || file.content === undefined || !file.contentEncoding) {
      return "unsupported";
    }
    const buffer = Buffer.from(file.content, file.contentEncoding);
    return buffer.length > previewMaxBytes ? "too_large" : { buffer, filePath };
  }
  if (!params.root) {
    return "not_found";
  }
  const documentDirectory = path.dirname(path.resolve(params.root, params.path));
  const target = await resolveSessionFileReadTarget(
    params,
    path.resolve(documentDirectory, relativePath),
  );
  params.assertCurrent?.();
  if (!target || target === "outside_session_boundary") {
    return target ?? "not_found";
  }
  const stat = await statWorkspacePath(target.root, target.path, params.assertCurrent);
  params.assertCurrent?.();
  if (!stat?.isFile) {
    return "not_found";
  }
  if (maxBytes === 0 || stat.size > maxBytes) {
    return "too_large";
  }
  const read = await readWorkspaceFile(target.root, target.path, {
    maxBytes,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent?.();
  return read && read !== "too-large"
    ? { buffer: read.buffer, filePath: target.absolutePath }
    : read === "too-large"
      ? "too_large"
      : "not_found";
}

export async function getSessionWorkspaceAssets(
  params: SessionWorkspaceAssetsParams,
): Promise<SessionsFilesAssetsResult> {
  const assets: SessionsFilesAssetsResult["assets"] = [];
  // Base64 expansion and bounded reference metadata stay well below the 25 MiB frame limit.
  let remainingBytes = SESSIONS_FILES_ASSETS_MAX_TOTAL_BYTES;
  for (const ref of params.refs) {
    params.assertCurrent?.();
    const relativePath = relativeAssetPath(ref);
    if (!relativePath) {
      assets.push({ ref, error: "unsupported" });
      continue;
    }
    const read = await readAsset(
      params,
      relativePath,
      Math.min(SESSIONS_FILES_ASSET_MAX_BYTES, remainingBytes),
    );
    params.assertCurrent?.();
    if (typeof read === "string") {
      assets.push({ ref, error: read });
      continue;
    }
    const mimeType = await assetMime(read.buffer, read.filePath);
    params.assertCurrent?.();
    if (!mimeType) {
      assets.push({ ref, error: "unsupported" });
      continue;
    }
    remainingBytes -= read.buffer.length;
    assets.push({ ref, mimeType, content: read.buffer.toString("base64") });
  }
  return { assets };
}
