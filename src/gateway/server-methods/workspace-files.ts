import path from "node:path";
import { detectMime } from "@openclaw/media-core/mime";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionFileBrowserEntry,
  SessionFileBrowserResult,
  SessionFileEntry,
  SessionFileRelevance,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveToCwd as resolveSessionToolPathToCwd } from "../../agents/sessions/tools/path-utils.js";
import { insideGitCheckout } from "../../agents/worktrees/git.js";
import { FsSafeError } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import { BROWSER_IMAGE_MIME_TYPES } from "../../shared/browser-image-mime-types.js";
import { WORKSPACE_PREVIEW_MAX_BYTES } from "../workspace-file-limits.js";
import { resolveSessionFileReadTarget, type SessionFileReadBoundary } from "./session-file-read.js";
import {
  decodeUtf8Strict,
  listWorkspacePath,
  normalizeRelativePath,
  openWorkspaceRoot,
  readWorkspaceFile,
  readWorkspaceFilePrefix,
  resolveWorkspacePath,
  sortDirents,
  sortWorkspaceEntries,
  statWorkspacePath,
  toUpdatedAtMs,
  type WorkspaceDirEntry,
  type WorkspaceRoot,
  updateWorkspaceFile,
  type WorkspaceFileUpdateResult,
} from "./workspace-fs.js";

export type TouchedFile = { path: string; kind: "modified" | "read" };
export type LoadedSessionFiles = SessionFileReadBoundary & {
  diffCwd?: string;
  files: TouchedFile[];
};
const MAX_BROWSER_ENTRIES = 250;
const MAX_SEARCH_ENTRIES = 500;
const MAX_SEARCH_VISITED_ENTRIES = 5_000;
// Matches file-type's documented default buffer sample while keeping metadata
// classification independent from the 256 KiB inline-content cap.
const MIME_SNIFF_PREFIX_BYTES = 4_100;
const DETECTED_TEXT_MIME_TYPES = new Set([
  "application/rtf",
  "application/xml",
  "application/x-ms-regedit",
  "model/stl",
]);
const SEARCH_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".next",
  ".turbo",
  ".yarn",
  "coverage",
  "dist",
  "node_modules",
]);

function toDisplayPath(root: string, resolved: string): string {
  return path.relative(root, resolved).split(path.sep).join("/");
}

function resolveTouchedFilePath(params: {
  root: string | undefined;
  fileRoot: string | undefined;
  filePath: string;
}): string | undefined {
  if (!params.root) {
    return undefined;
  }
  const base = params.fileRoot ?? params.root;
  const resolved = resolveSessionToolPathToCwd(params.filePath, base);
  if (!isPathInside(params.root, resolved)) {
    return undefined;
  }
  return resolved;
}

export function resolveFileRoot(params: {
  root: string | undefined;
  spawnedCwd: string | undefined;
}): string | undefined {
  if (!params.root) {
    return undefined;
  }
  if (!params.spawnedCwd) {
    return params.root;
  }
  const resolvedCwd = path.resolve(params.spawnedCwd);
  const resolvedRoot = path.resolve(params.root);
  return isPathInside(resolvedRoot, resolvedCwd) ? params.spawnedCwd : params.root;
}

function mergeRelevance(
  current: SessionFileRelevance | undefined,
  next: SessionFileRelevance | undefined,
): SessionFileRelevance | undefined {
  if (!current) {
    return next;
  }
  if (!next || current === next) {
    return current;
  }
  return "mixed";
}

function buildSessionRelevanceMap(
  files: readonly TouchedFile[],
  root: string | undefined,
  fileRoot: string | undefined,
): Map<string, SessionFileRelevance> {
  const relevance = new Map<string, SessionFileRelevance>();
  if (!root) {
    for (const file of files) {
      relevance.set(normalizeRelativePath(file.path), file.kind);
    }
    return relevance;
  }
  for (const file of files) {
    const resolved = resolveTouchedFilePath({ root, fileRoot, filePath: file.path });
    if (!resolved) {
      continue;
    }
    relevance.set(toDisplayPath(root, resolved), file.kind);
  }
  return relevance;
}

function relevanceForBrowserPath(
  browserPath: string,
  kind: "file" | "directory",
  relevance: ReadonlyMap<string, SessionFileRelevance>,
): SessionFileRelevance | undefined {
  if (kind === "file") {
    return relevance.get(browserPath);
  }
  const prefix = browserPath ? `${browserPath}/` : "";
  let aggregate: SessionFileRelevance | undefined;
  for (const [filePath, sessionKind] of relevance) {
    if (filePath.startsWith(prefix) && filePath !== browserPath) {
      aggregate = mergeRelevance(aggregate, sessionKind);
    }
  }
  return aggregate;
}

function displayNameForPath(filePath: string): string {
  return path.basename(filePath) || filePath;
}

function isDetectedTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType.endsWith("+xml") ||
    DETECTED_TEXT_MIME_TYPES.has(mimeType)
  );
}

function applyInlineFilePreview(entry: SessionFileEntry, buffer: Buffer, mimeType?: string): void {
  if (mimeType && BROWSER_IMAGE_MIME_TYPES.has(mimeType)) {
    entry.mimeType = mimeType;
    entry.contentEncoding = "base64";
    entry.previewKind = "image";
    entry.content = buffer.toString("base64");
    return;
  }
  const text = decodeUtf8Strict(buffer);
  if ((!mimeType || isDetectedTextMime(mimeType)) && text !== undefined) {
    entry.mimeType = mimeType ?? "text/plain";
    entry.contentEncoding = "utf8";
    entry.previewKind = "text";
    entry.content = text;
    // The hash doubles as the sessions.files.set CAS token. Binary files
    // never receive one, so replacement characters cannot be saved back.
    entry.hash = sha256Hex(buffer);
    return;
  }
  entry.previewKind = "unsupported";
  if (mimeType) {
    entry.mimeType = mimeType;
  }
}

export async function populateSessionFilePreview(
  entry: SessionFileEntry,
  buffer: Buffer,
): Promise<void> {
  applyInlineFilePreview(entry, buffer, await detectMime({ buffer }));
}

function applyOversizedFileMetadata(
  entry: SessionFileEntry,
  buffer: Buffer,
  mimeType?: string,
): void {
  const prefixIsText = decodeUtf8Strict(buffer) !== undefined;
  if ((!mimeType && prefixIsText) || (mimeType && isDetectedTextMime(mimeType) && prefixIsText)) {
    return;
  }
  entry.previewKind = "unsupported";
  if (mimeType) {
    entry.mimeType = mimeType;
  }
}

async function toSessionFileEntry(
  touched: TouchedFile,
  root: string | undefined,
  fileRoot: string | undefined,
  opts: {
    includeContent?: boolean;
    workspaceRoot?: WorkspaceRoot;
    assertCurrent?: () => void;
    authorizeHostRead?: () => Promise<boolean>;
    onOutsideBoundary?: () => void;
  } = {},
): Promise<SessionFileEntry> {
  const target = await resolveSessionFileReadTarget(
    { root, fileRoot, authorizeHostRead: opts.authorizeHostRead },
    touched.path,
  );
  const base = {
    path: touched.path,
    name: displayNameForPath(touched.path),
    kind: touched.kind,
  } satisfies Pick<SessionFileEntry, "path" | "name" | "kind">;
  if (!target || target === "outside_session_boundary") {
    if (target === "outside_session_boundary") {
      opts.onOutsideBoundary?.();
    }
    return { ...base, missing: true };
  }
  const browserPath = target.path;
  const readRoot = target.outside ? target.root : (opts.workspaceRoot ?? target.root);
  const stat = await statWorkspacePath(readRoot, browserPath, opts.assertCurrent);
  if (!stat?.isFile) {
    return { ...base, missing: true };
  }
  const entry: SessionFileEntry = {
    ...base,
    ...(target.outside ? { path: target.absolutePath } : {}),
    workspacePath: target.outside ? target.absolutePath : browserPath,
    missing: false,
    size: stat.size,
    updatedAtMs: toUpdatedAtMs(stat.mtimeMs),
  };
  if (!opts.includeContent) {
    return entry;
  }
  const inline = stat.size <= WORKSPACE_PREVIEW_MAX_BYTES;
  const read = inline
    ? await readWorkspaceFile(readRoot, browserPath, { assertCurrent: opts.assertCurrent })
    : await readWorkspaceFilePrefix(readRoot, browserPath, MIME_SNIFF_PREFIX_BYTES);
  if (!read) {
    return { ...base, missing: true };
  }
  if (read === "too-large" || read === "unsupported") {
    return entry;
  }
  entry.workspacePath = target.outside ? target.absolutePath : read.canonicalPath;
  entry.size = read.stat.size;
  entry.updatedAtMs = toUpdatedAtMs(read.stat.mtimeMs);
  if (inline) {
    await populateSessionFilePreview(entry, read.buffer);
    if (read.readOnly || target.outside) {
      delete entry.hash;
    }
  } else {
    applyOversizedFileMetadata(entry, read.buffer, await detectMime({ buffer: read.buffer }));
  }
  return entry;
}

function resolveSessionFileCandidates(params: {
  root: string;
  fileRoot: string | undefined;
  filePath: string;
}): string[] {
  return [
    resolveTouchedFilePath(params),
    resolveWorkspacePath(params.root, params.filePath),
  ].filter((candidate, index, all): candidate is string => {
    return candidate !== undefined && all.indexOf(candidate) === index;
  });
}

function toBrowserEntry(
  browserPath: string,
  dirent: WorkspaceDirEntry,
  relevance: ReadonlyMap<string, SessionFileRelevance>,
): SessionFileBrowserEntry | undefined {
  const kind = dirent.isFile ? "file" : dirent.isDirectory ? "directory" : null;
  if (!kind) {
    return undefined;
  }
  const sessionKind = relevanceForBrowserPath(browserPath, kind, relevance);
  return {
    path: browserPath,
    name: dirent.name,
    kind,
    ...(kind === "file" ? { size: dirent.size } : {}),
    updatedAtMs: toUpdatedAtMs(dirent.mtimeMs),
    ...(sessionKind ? { sessionKind } : {}),
  };
}

async function searchBrowserEntries(params: {
  assertCurrent?: () => void;
  root: string | WorkspaceRoot;
  query: string;
  relevance: ReadonlyMap<string, SessionFileRelevance>;
}): Promise<{ entries: SessionFileBrowserEntry[]; truncated?: true }> {
  const entries: SessionFileBrowserEntry[] = [];
  const query = params.query.toLowerCase();
  let visitedEntries = 0;
  let truncated = false;
  const shouldStop = (): boolean => {
    if (entries.length >= MAX_SEARCH_ENTRIES || visitedEntries >= MAX_SEARCH_VISITED_ENTRIES) {
      truncated = true;
      return true;
    }
    return false;
  };
  const visit = async (dir: string): Promise<void> => {
    if (shouldStop()) {
      return;
    }
    const dirents = await listWorkspacePath(params.root, dir, params.assertCurrent);
    if (!dirents) {
      return;
    }
    for (const dirent of sortDirents(dirents)) {
      if (shouldStop()) {
        return;
      }
      visitedEntries += 1;
      const browserPath = dir ? `${dir}/${dirent.name}` : dirent.name;
      if (browserPath.toLowerCase().includes(query)) {
        const entry = toBrowserEntry(browserPath, dirent, params.relevance);
        if (entry) {
          entries.push(entry);
        }
      }
      if (dirent.isDirectory && !SEARCH_SKIP_DIRS.has(dirent.name)) {
        await visit(browserPath);
      }
    }
  };
  await visit("");
  return { entries: sortWorkspaceEntries(entries), ...(truncated ? { truncated } : {}) };
}

async function buildBrowserResult(params: {
  assertCurrent?: () => void;
  root: string | undefined;
  workspaceRoot?: WorkspaceRoot;
  fileRoot: string | undefined;
  path?: string;
  search?: string;
  files: readonly TouchedFile[];
}): Promise<SessionFileBrowserResult | undefined> {
  if (!params.root) {
    return undefined;
  }
  const search = normalizeOptionalString(params.search);
  const relevance = buildSessionRelevanceMap(params.files, params.root, params.fileRoot);
  if (search) {
    const result = await searchBrowserEntries({
      root: params.workspaceRoot ?? params.root,
      query: search,
      relevance,
      assertCurrent: params.assertCurrent,
    });
    return {
      path: "",
      search,
      ...result,
    };
  }
  const browserPath = normalizeRelativePath(params.path);
  const resolved = resolveWorkspacePath(params.root, browserPath);
  if (!resolved) {
    return undefined;
  }
  const stat = await statWorkspacePath(
    params.workspaceRoot ?? params.root,
    browserPath,
    params.assertCurrent,
  );
  if (!stat?.isDirectory) {
    return undefined;
  }
  const dirents = await listWorkspacePath(
    params.workspaceRoot ?? params.root,
    browserPath,
    params.assertCurrent,
  );
  if (!dirents) {
    return undefined;
  }
  const entries = sortDirents(dirents)
    .slice(0, MAX_BROWSER_ENTRIES + 1)
    .map((dirent) => {
      const entryPath = browserPath ? `${browserPath}/${dirent.name}` : dirent.name;
      return toBrowserEntry(entryPath, dirent, relevance);
    })
    .filter((entry): entry is SessionFileBrowserEntry => Boolean(entry));
  const parent = path.dirname(browserPath);
  return {
    path: browserPath,
    ...(browserPath ? { parentPath: parent === "." ? "" : parent } : {}),
    entries: sortWorkspaceEntries(entries.slice(0, MAX_BROWSER_ENTRIES)),
    ...(entries.length > MAX_BROWSER_ENTRIES ? { truncated: true } : {}),
  };
}

export async function listSessionWorkspaceFiles(
  params: LoadedSessionFiles & {
    path?: string;
    search?: string;
    assertCurrent?: () => void;
  },
): Promise<{
  root?: string;
  gitCheckout?: boolean;
  files: SessionFileEntry[];
  browser?: SessionFileBrowserResult;
}> {
  const root = params.root;
  const workspaceRoot = root ? await openWorkspaceRoot(root) : undefined;
  const gitCheckout =
    workspaceRoot && "access" in workspaceRoot
      ? undefined
      : params.diffCwd
        ? insideGitCheckout(params.diffCwd)
        : undefined;
  const allowOutside =
    root &&
    params.files.some(
      (file) => !resolveTouchedFilePath({ root, fileRoot: params.fileRoot, filePath: file.path }),
    ) &&
    (await params.authorizeHostRead?.());
  const workspaceFiles =
    root && !allowOutside
      ? params.files.filter((file) =>
          Boolean(resolveTouchedFilePath({ root, fileRoot: params.fileRoot, filePath: file.path })),
        )
      : params.files;
  const files = await Promise.all(
    workspaceFiles.map((file) =>
      toSessionFileEntry(file, params.root, params.fileRoot, {
        workspaceRoot,
        assertCurrent: params.assertCurrent,
        authorizeHostRead: params.authorizeHostRead,
      }),
    ),
  );
  const browser = await buildBrowserResult({
    root,
    workspaceRoot,
    fileRoot: params.fileRoot,
    path: params.path,
    search: params.search,
    files: workspaceFiles,
    assertCurrent: params.assertCurrent,
  });
  return {
    ...(root ? { root } : {}),
    ...(gitCheckout === undefined ? {} : { gitCheckout }),
    files,
    ...(browser ? { browser } : {}),
  };
}

export async function getSessionWorkspaceFile(
  params: LoadedSessionFiles & { path: string; assertCurrent?: () => void },
): Promise<{ root?: string; file?: SessionFileEntry; reason?: "outside_session_boundary" }> {
  let outsideBoundary = false;
  const options = {
    includeContent: true,
    assertCurrent: params.assertCurrent,
    authorizeHostRead: params.authorizeHostRead,
    onOutsideBoundary: () => {
      outsideBoundary = true;
    },
  };
  const exactTouched = params.files.find((file) => file.path === params.path);
  if (exactTouched) {
    const file = await toSessionFileEntry(exactTouched, params.root, params.fileRoot, options);
    return {
      ...(params.root ? { root: params.root } : {}),
      file,
      ...(outsideBoundary ? { reason: "outside_session_boundary" as const } : {}),
    };
  }
  if (!params.root) {
    return {};
  }
  // Any in-root file is previewable; fs-safe root enforces containment, symlink/hardlink
  // rejection, and the 256 KB cap.
  const candidates = resolveSessionFileCandidates({
    root: params.root,
    fileRoot: params.fileRoot,
    filePath: params.path,
  });
  if (
    candidates.length === 0 ||
    !resolveTouchedFilePath({ root: params.root, fileRoot: params.fileRoot, filePath: params.path })
  ) {
    const file = await toSessionFileEntry(
      { path: params.path, kind: "read" },
      params.root,
      params.fileRoot,
      options,
    );
    return {
      root: params.root,
      file,
      ...(outsideBoundary ? { reason: "outside_session_boundary" as const } : {}),
    };
  }
  const relevance = buildSessionRelevanceMap(params.files, params.root, params.fileRoot);
  for (const candidate of candidates) {
    const browserPath = toDisplayPath(params.root, candidate);
    const sessionKind = relevance.get(browserPath);
    const touched: TouchedFile = {
      path: browserPath,
      kind: sessionKind === "modified" ? "modified" : "read",
    };
    const file = await toSessionFileEntry(touched, params.root, params.root, options);
    if (!file.missing) {
      return { root: params.root, file };
    }
  }
  return { root: params.root };
}

export type SessionWorkspaceWriteResult =
  | { status: "updated"; root: string; file: SessionFileEntry }
  | { status: "conflict"; currentHash: string }
  | { status: "unsafe" }
  | { status: "missing" }
  | { status: "too-large"; size: number };

export async function setSessionWorkspaceFile(params: {
  root?: string;
  fileRoot?: string;
  path: string;
  content: string;
  expectedHash: string;
  assertCurrent?: () => void;
}): Promise<SessionWorkspaceWriteResult> {
  // Reject content the preview cannot round-trip, before encoding oversized input.
  if (params.content.includes("\0")) {
    return { status: "unsafe" };
  }
  const size = Buffer.byteLength(params.content, "utf8");
  if (size > WORKSPACE_PREVIEW_MAX_BYTES) {
    return { status: "too-large", size };
  }
  if (Buffer.from(params.content, "utf8").toString("utf8") !== params.content) {
    return { status: "unsafe" };
  }
  if (!params.root) {
    return { status: "missing" };
  }
  const candidates = resolveSessionFileCandidates({
    root: params.root,
    fileRoot: params.fileRoot,
    filePath: params.path,
  });
  let browserPath: string | undefined;
  for (const candidate of candidates) {
    const candidatePath = toDisplayPath(params.root, candidate);
    const stat = await statWorkspacePath(params.root, candidatePath);
    if (stat?.isFile) {
      browserPath = candidatePath;
      break;
    }
  }
  if (!browserPath) {
    return { status: "missing" };
  }
  let update: WorkspaceFileUpdateResult;
  try {
    update = await updateWorkspaceFile(
      params.root,
      browserPath,
      params.content,
      params.expectedHash,
      params.assertCurrent,
    );
  } catch (error) {
    if (!(error instanceof FsSafeError)) {
      throw error;
    }
    return { status: "unsafe" };
  }
  if (update.status !== "updated") {
    return update;
  }
  return {
    status: "updated",
    root: params.root,
    file: {
      path: params.path,
      workspacePath: update.canonicalPath,
      name: displayNameForPath(update.canonicalPath),
      kind: "modified",
      missing: false,
      size: update.stat.size,
      updatedAtMs: toUpdatedAtMs(update.stat.mtimeMs),
      hash: update.hash,
    },
  };
}
