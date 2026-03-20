import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

function sanitizePrefix(prefix: string): string {
  const normalized = prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "tmp";
}

function sanitizeExtension(extension?: string): string {
  if (!extension) {
    return "";
  }
  const normalized = extension.startsWith(".") ? extension : `.${extension}`;
  const suffix = normalized.match(/[a-zA-Z0-9._-]+$/)?.[0] ?? "";
  const token = suffix.replace(/^[._-]+/, "");
  if (!token) {
    return "";
  }
  return `.${token}`;
}

function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const normalized = base.replace(/^-+|-+$/g, "");
  return normalized || "download.bin";
}

function sanitizeWorkspacePathSegment(segment: string): string {
  const normalized = segment
    .normalize("NFKC")
    .replace(/[\\/]+/g, "-")
    .replace(/\p{Cc}/gu, "")
    .trim();
  if (normalized === "." || normalized === "..") {
    return "artifact";
  }
  return normalized || "artifact";
}

function resolveTempRoot(tmpDir?: string): string {
  return tmpDir ?? resolvePreferredOpenClawTmpDir();
}

function isNodeErrorWithCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === code
  );
}

/** Build a unique temp file path with sanitized prefix/extension parts. */
export function buildRandomTempFilePath(params: {
  prefix: string;
  extension?: string;
  tmpDir?: string;
  now?: number;
  uuid?: string;
}): string {
  const prefix = sanitizePrefix(params.prefix);
  const extension = sanitizeExtension(params.extension);
  const nowCandidate = params.now;
  const now =
    typeof nowCandidate === "number" && Number.isFinite(nowCandidate)
      ? Math.trunc(nowCandidate)
      : Date.now();
  const uuid = params.uuid?.trim() || crypto.randomUUID();
  return path.join(resolveTempRoot(params.tmpDir), `${prefix}-${now}-${uuid}${extension}`);
}

export type WorkspaceArtifactPath = {
  workspaceDir: string;
  absolutePath: string;
  workspacePath?: string;
};

function toWorkspaceRelativePath(workspaceDir: string, absolutePath: string): string | undefined {
  const relativePath = path.relative(workspaceDir, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return undefined;
  }
  return relativePath.split(path.sep).join(path.posix.sep);
}

function normalizeWorkspaceExtension(params: {
  extension?: string;
  preferredFileName?: string;
}): string {
  if (params.extension) {
    return sanitizeExtension(params.extension);
  }
  const preferredExt = params.preferredFileName ? path.extname(params.preferredFileName) : "";
  return sanitizeExtension(preferredExt);
}

function buildWorkspaceArtifactFileName(params: {
  prefix: string;
  extension?: string;
  preferredFileName?: string;
  now?: number;
  uuid?: string;
}): string {
  const baseName = params.preferredFileName
    ? path.basename(params.preferredFileName, path.extname(params.preferredFileName))
    : params.prefix;
  const normalizedBase = sanitizeWorkspacePathSegment(baseName);
  const nowCandidate = params.now;
  const now =
    typeof nowCandidate === "number" && Number.isFinite(nowCandidate)
      ? Math.trunc(nowCandidate)
      : Date.now();
  const uuid = params.uuid?.trim() || crypto.randomUUID();
  return `${normalizedBase}-${now}-${uuid}${normalizeWorkspaceExtension(params)}`;
}

function normalizeArtifactSegments(segments?: string[]): string[] {
  const normalized = (segments ?? [".openclaw", "artifacts", "downloads"])
    .map((segment) => sanitizeWorkspacePathSegment(segment))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : [".openclaw", "artifacts", "downloads"];
}

export function buildAgentWorkspaceArtifactPath(params: {
  cfg: OpenClawConfig;
  agentId: string;
  prefix: string;
  extension?: string;
  preferredFileName?: string;
  pathSegments?: string[];
  now?: number;
  uuid?: string;
}): WorkspaceArtifactPath {
  const workspaceDir = path.resolve(resolveAgentWorkspaceDir(params.cfg, params.agentId));
  const fileName = buildWorkspaceArtifactFileName(params);
  const absolutePath = path.join(
    workspaceDir,
    ...normalizeArtifactSegments(params.pathSegments),
    fileName,
  );
  const workspacePath = toWorkspaceRelativePath(workspaceDir, absolutePath);
  if (!workspacePath) {
    throw new Error("artifact path must stay within the current workspace");
  }
  return {
    workspaceDir,
    absolutePath,
    workspacePath,
  };
}

export function resolveAgentWorkspaceOutputPath(params: {
  cfg: OpenClawConfig;
  agentId: string;
  outputPath?: string;
  prefix: string;
  extension?: string;
  preferredFileName?: string;
  pathSegments?: string[];
  now?: number;
  uuid?: string;
}): WorkspaceArtifactPath {
  if (!params.outputPath?.trim()) {
    return buildAgentWorkspaceArtifactPath(params);
  }

  const workspaceDir = path.resolve(resolveAgentWorkspaceDir(params.cfg, params.agentId));
  const rawOutputPath = params.outputPath.trim();
  const absolutePath = path.isAbsolute(rawOutputPath)
    ? rawOutputPath
    : path.resolve(workspaceDir, rawOutputPath);
  const workspacePath = toWorkspaceRelativePath(workspaceDir, absolutePath);

  if (!workspacePath) {
    throw new Error("output_path must stay within the current workspace");
  }

  return {
    workspaceDir,
    absolutePath,
    workspacePath,
  };
}

/** Create a temporary download directory, run the callback, then clean it up best-effort. */
export async function withTempDownloadPath<T>(
  params: {
    prefix: string;
    fileName?: string;
    tmpDir?: string;
  },
  fn: (tmpPath: string) => Promise<T>,
): Promise<T> {
  const tempRoot = resolveTempRoot(params.tmpDir);
  const prefix = `${sanitizePrefix(params.prefix)}-`;
  const dir = await mkdtemp(path.join(tempRoot, prefix));
  const tmpPath = path.join(dir, sanitizeFileName(params.fileName ?? "download.bin"));
  try {
    return await fn(tmpPath);
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      if (!isNodeErrorWithCode(err, "ENOENT")) {
        console.warn(`temp-path cleanup failed for ${dir}: ${String(err)}`);
      }
    }
  }
}
