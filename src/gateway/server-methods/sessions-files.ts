// Gateway methods expose files referenced by one session transcript.
import fs from "node:fs";
import path from "node:path";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionFileBrowserEntry,
  type SessionFileBrowserResult,
  type SessionFileEntry,
  type SessionFileRelevance,
  type SessionsFilesGetParams,
  validateSessionsFilesGetParams,
  validateSessionsFilesListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { root as fsSafeRoot, FsSafeError, type ReadResult } from "../../infra/fs-safe.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { visitSessionMessagesAsync } from "../session-transcript-readers.js";
import { loadSessionEntry } from "../session-utils.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

type FileKind = "modified" | "read";

type TouchedFile = {
  path: string;
  kind: FileKind;
};

type WorkspaceRoot = Awaited<ReturnType<typeof fsSafeRoot>>;
type WorkspacePathStat = Awaited<ReturnType<WorkspaceRoot["stat"]>>;
type WorkspaceDirEntry = WorkspacePathStat & { name: string };
type LoadedSessionFiles = {
  root?: string;
  fileRoot?: string;
  files: TouchedFile[];
};

const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_BROWSER_ENTRIES = 250;
const MAX_SEARCH_ENTRIES = 500;
const MAX_SEARCH_VISITED_ENTRIES = 5_000;
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

function sessionFilesError(type: string, message: string, details?: Record<string, unknown>) {
  return errorShape(ErrorCodes.INVALID_REQUEST, message, {
    details: {
      type,
      ...details,
    },
  });
}

function normalizePathValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readPathArg(args: Record<string, unknown>): string | undefined {
  return (
    normalizePathValue(args.path) ??
    normalizePathValue(args.file_path) ??
    normalizePathValue(args.filePath) ??
    normalizePathValue(args.file)
  );
}

function addTouchedFile(
  files: Map<string, TouchedFile>,
  filePath: string | undefined,
  kind: FileKind,
) {
  if (!filePath) {
    return;
  }
  const existing = files.get(filePath);
  if (existing?.kind === "modified" || (existing && kind === "read")) {
    return;
  }
  files.set(filePath, { path: filePath, kind });
}

function addRawPatchFiles(files: Map<string, TouchedFile>, input: unknown) {
  if (typeof input !== "string") {
    return;
  }
  const fileLinePattern = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  for (const match of input.matchAll(fileLinePattern)) {
    addTouchedFile(files, match[1]?.trim(), "modified");
  }
  const moveLinePattern = /^\*\*\* Move to: (.+)$/gm;
  for (const match of input.matchAll(moveLinePattern)) {
    addTouchedFile(files, match[1]?.trim(), "modified");
  }
}

function addStructuredPatchFiles(files: Map<string, TouchedFile>, changes: unknown) {
  if (!Array.isArray(changes)) {
    return;
  }
  for (const changeValue of changes) {
    const change = asOptionalObjectRecord(changeValue);
    addTouchedFile(files, normalizePathValue(change?.path), "modified");
    const kind = asOptionalObjectRecord(change?.kind);
    addTouchedFile(
      files,
      normalizePathValue(kind?.move_path) ?? normalizePathValue(kind?.movePath),
      "modified",
    );
  }
}

function addPatchFiles(files: Map<string, TouchedFile>, args: Record<string, unknown>) {
  addRawPatchFiles(files, args.input);
  addStructuredPatchFiles(files, args.changes);
}

function isToolCallBlockType(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.toLowerCase().replace(/[_-]/g, "");
  return normalized === "toolcall" || normalized === "tooluse";
}

function collectTouchedFilesFromMessage(message: unknown, files: Map<string, TouchedFile>) {
  const record = asOptionalObjectRecord(message);
  if (record?.role !== "assistant" || !Array.isArray(record.content)) {
    return;
  }
  for (const blockValue of record.content) {
    const block = asOptionalObjectRecord(blockValue);
    if (!block || !isToolCallBlockType(block.type)) {
      continue;
    }
    const toolName = normalizeOptionalString(block.name)?.toLowerCase();
    const args =
      asOptionalObjectRecord(block.arguments) ??
      asOptionalObjectRecord(block.input) ??
      asOptionalObjectRecord(block.args);
    if (!toolName || !args) {
      continue;
    }
    if (toolName === "read") {
      addTouchedFile(files, readPathArg(args), "read");
    } else if (toolName === "write" || toolName === "edit") {
      addTouchedFile(files, readPathArg(args), "modified");
    } else if (toolName === "apply_patch") {
      addPatchFiles(files, args);
    }
  }
}

function toDisplayPath(root: string, resolved: string): string {
  const relative = path.relative(root, resolved);
  if (!relative) {
    return "";
  }
  return relative.split(path.sep).join("/");
}

function normalizeRelativePath(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return value
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

function resolveWorkspacePath(root: string | undefined, filePath: string): string | undefined {
  if (!root) {
    return undefined;
  }
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return resolved;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
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
  const resolved = path.isAbsolute(params.filePath)
    ? path.resolve(params.filePath)
    : path.resolve(base, params.filePath);
  if (!isInsideRoot(params.root, resolved)) {
    return undefined;
  }
  return resolved;
}

function resolveFileRoot(params: {
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
  return isInsideRoot(resolvedRoot, resolvedCwd) ? params.spawnedCwd : params.root;
}

async function openSessionWorkspaceRoot(rootDir: string): Promise<WorkspaceRoot | undefined> {
  try {
    return await fsSafeRoot(rootDir, {
      hardlinks: "reject",
      maxBytes: MAX_PREVIEW_BYTES,
      nonBlockingRead: true,
      symlinks: "reject",
    });
  } catch {
    return undefined;
  }
}

async function statWorkspacePath(
  rootDir: string,
  browserPath: string,
): Promise<WorkspacePathStat | undefined> {
  const workspaceRoot = await openSessionWorkspaceRoot(rootDir);
  if (!workspaceRoot) {
    return undefined;
  }
  try {
    return await workspaceRoot.stat(browserPath || ".");
  } catch {
    return undefined;
  }
}

async function listWorkspacePath(
  rootDir: string,
  browserPath: string,
): Promise<WorkspaceDirEntry[] | undefined> {
  const workspaceRoot = await openSessionWorkspaceRoot(rootDir);
  if (!workspaceRoot) {
    return undefined;
  }
  try {
    return await workspaceRoot.list(browserPath || ".", { withFileTypes: true });
  } catch {
    return undefined;
  }
}

async function readWorkspaceFile(
  rootDir: string,
  browserPath: string,
): Promise<ReadResult | undefined | "too-large"> {
  const workspaceRoot = await openSessionWorkspaceRoot(rootDir);
  if (!workspaceRoot) {
    return undefined;
  }
  try {
    return await workspaceRoot.read(browserPath, {
      hardlinks: "reject",
      maxBytes: MAX_PREVIEW_BYTES,
      nonBlockingRead: true,
      symlinks: "reject",
    });
  } catch (err) {
    if (err instanceof FsSafeError && err.code === "too-large") {
      return "too-large";
    }
    return undefined;
  }
}

function relevanceForKind(kind: FileKind): SessionFileRelevance {
  return kind;
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
      relevance.set(normalizeRelativePath(file.path), relevanceForKind(file.kind));
    }
    return relevance;
  }
  for (const file of files) {
    const resolved = resolveTouchedFilePath({ root, fileRoot, filePath: file.path });
    if (!resolved) {
      continue;
    }
    relevance.set(toDisplayPath(root, resolved), relevanceForKind(file.kind));
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
  const base = path.basename(filePath);
  return base || filePath;
}

function toUpdatedAtMs(mtimeMs: number): number {
  return Math.floor(mtimeMs);
}

function workspaceStatKind(stat: WorkspacePathStat): "file" | "directory" | "symlink" | undefined {
  const kind = (stat as { kind?: unknown }).kind;
  if (kind === "file" || kind === "directory" || kind === "symlink") {
    return kind;
  }
  const nodeStat = stat as {
    isDirectory?: boolean | (() => boolean);
    isFile?: boolean | (() => boolean);
    isSymbolicLink?: boolean | (() => boolean);
  };
  const isFile = typeof nodeStat.isFile === "function" ? nodeStat.isFile() : nodeStat.isFile;
  if (isFile) {
    return "file";
  }
  const isDirectory =
    typeof nodeStat.isDirectory === "function" ? nodeStat.isDirectory() : nodeStat.isDirectory;
  if (isDirectory) {
    return "directory";
  }
  const isSymbolicLink =
    typeof nodeStat.isSymbolicLink === "function"
      ? nodeStat.isSymbolicLink()
      : nodeStat.isSymbolicLink;
  return isSymbolicLink ? "symlink" : undefined;
}

async function toSessionFileEntry(
  touched: TouchedFile,
  root: string | undefined,
  fileRoot: string | undefined,
  opts: { includeContent?: boolean } = {},
): Promise<SessionFileEntry> {
  const resolved = resolveTouchedFilePath({ root, fileRoot, filePath: touched.path });
  const base = {
    path: touched.path,
    name: displayNameForPath(touched.path),
    kind: touched.kind,
  } satisfies Pick<SessionFileEntry, "path" | "name" | "kind">;

  // Best-effort direct stat when the workspace sandbox cannot resolve the
  // path — still-existing files outside the workspace root (e.g. /tmp/foo)
  // should not be reported as missing.
  const directStat = (absolutePath: string): SessionFileEntry | undefined => {
    if (!fs.existsSync(absolutePath)) {
      return undefined;
    }
    try {
      const stat = fs.statSync(absolutePath);
      if (!stat.isFile()) {
        return undefined;
      }
      return {
        ...base,
        missing: false,
        size: stat.size,
        updatedAtMs: Math.floor(stat.mtimeMs),
      };
    } catch {
      return undefined;
    }
  };

  if (!resolved) {
    // Files outside the workspace root may still exist — try the original
    // path directly (handles Unix-style /tmp/foo on Windows too).
    // When content is requested, we can never serve it for paths outside the
    // workspace sandbox: return missing so the caller produces
    // session_file_not_found rather than session_file_too_large.
    if (opts.includeContent) {
      return { ...base, missing: true };
    }
    const entry = directStat(touched.path);
    if (entry) {
      return entry;
    }
    return { ...base, missing: true };
  }
  const browserPath = toDisplayPath(root!, resolved);
  const stat = await statWorkspacePath(root!, browserPath);
  if (!stat || workspaceStatKind(stat) !== "file") {
    // Workspace sandbox could not resolve the path; try the original path
    // and the resolved path directly before declaring missing.
    // When content is requested, directStat cannot provide it (we rely on
    // the sandbox for safe reads); return missing so the caller produces
    // session_file_not_found rather than session_file_too_large.
    if (!opts.includeContent) {
      const entry =
        directStat(touched.path) ?? (resolved !== touched.path ? directStat(resolved) : undefined);
      if (entry) {
        return entry;
      }
    }
    return { ...base, missing: true };
  }
  const entry: SessionFileEntry = {
    ...base,
    missing: false,
    size: stat.size,
    updatedAtMs: toUpdatedAtMs(stat.mtimeMs),
  };
  if (opts.includeContent && stat.size <= MAX_PREVIEW_BYTES) {
    const read = await readWorkspaceFile(root!, browserPath);
    if (!read) {
      return { ...base, missing: true };
    }
    if (read !== "too-large") {
      entry.size = read.stat.size;
      entry.updatedAtMs = toUpdatedAtMs(read.stat.mtimeMs);
      entry.content = read.buffer.toString("utf8");
    }
  }
  return entry;
}

async function toBrowserEntry(
  browserPath: string,
  dirent: WorkspaceDirEntry,
  relevance: ReadonlyMap<string, SessionFileRelevance>,
): Promise<SessionFileBrowserEntry | undefined> {
  const statKind = workspaceStatKind(dirent);
  const kind = statKind === "directory" ? "directory" : statKind === "file" ? "file" : null;
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

function sortBrowserEntries(
  entries: readonly SessionFileBrowserEntry[],
): SessionFileBrowserEntry[] {
  return entries.toSorted((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

function sortDirents<T extends { name: string }>(dirents: readonly T[]): T[] {
  return dirents.toSorted((a, b) => a.name.localeCompare(b.name));
}

function matchesSearch(entryPath: string, name: string, query: string): boolean {
  const normalizedQuery = query.toLowerCase();
  return (
    name.toLowerCase().includes(normalizedQuery) ||
    entryPath.toLowerCase().includes(normalizedQuery)
  );
}

async function searchBrowserEntries(params: {
  root: string;
  query: string;
  relevance: ReadonlyMap<string, SessionFileRelevance>;
}): Promise<{ entries: SessionFileBrowserEntry[]; truncated?: boolean }> {
  const entries: SessionFileBrowserEntry[] = [];
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
    const dirents = await listWorkspacePath(params.root, dir);
    if (!dirents) {
      return;
    }
    for (const dirent of sortDirents(dirents)) {
      if (shouldStop()) {
        return;
      }
      visitedEntries += 1;
      const browserPath = dir ? `${dir}/${dirent.name}` : dirent.name;
      if (matchesSearch(browserPath, dirent.name, params.query)) {
        const entry = await toBrowserEntry(browserPath, dirent, params.relevance);
        if (entry) {
          entries.push(entry);
        }
      }
      if (workspaceStatKind(dirent) === "directory" && !SEARCH_SKIP_DIRS.has(dirent.name)) {
        await visit(browserPath);
      }
    }
  };
  await visit("");
  return { entries: sortBrowserEntries(entries), ...(truncated ? { truncated } : {}) };
}

async function buildBrowserResult(params: {
  root: string | undefined;
  fileRoot: string | undefined;
  path?: string;
  search?: string;
  files: readonly TouchedFile[];
}): Promise<SessionFileBrowserResult | undefined> {
  if (!params.root) {
    return undefined;
  }
  const search = normalizePathValue(params.search);
  const relevance = buildSessionRelevanceMap(params.files, params.root, params.fileRoot);
  if (search) {
    const result = await searchBrowserEntries({
      root: params.root,
      query: search,
      relevance,
    });
    return {
      path: "",
      search,
      entries: result.entries,
      ...(result.truncated ? { truncated: result.truncated } : {}),
    };
  }
  const browserPath = normalizeRelativePath(params.path);
  const resolved = resolveWorkspacePath(params.root, browserPath);
  if (!resolved) {
    return undefined;
  }
  const stat = await statWorkspacePath(params.root, browserPath);
  if (!stat || workspaceStatKind(stat) !== "directory") {
    return undefined;
  }
  const dirents = await listWorkspacePath(params.root, browserPath);
  if (!dirents) {
    return undefined;
  }
  const entries = (
    await Promise.all(
      sortDirents(dirents)
        .slice(0, MAX_BROWSER_ENTRIES + 1)
        .map((dirent) => {
          const entryPath = browserPath ? `${browserPath}/${dirent.name}` : dirent.name;
          return toBrowserEntry(entryPath, dirent, relevance);
        }),
    )
  ).filter((entry): entry is SessionFileBrowserEntry => Boolean(entry));
  const parent = path.dirname(browserPath);
  return {
    path: browserPath,
    ...(browserPath ? { parentPath: parent === "." ? "" : parent } : {}),
    entries: sortBrowserEntries(entries.slice(0, MAX_BROWSER_ENTRIES)),
    ...(entries.length > MAX_BROWSER_ENTRIES ? { truncated: true } : {}),
  };
}

async function loadSessionFiles(params: {
  sessionKey: string;
  agentId?: string;
}): Promise<LoadedSessionFiles> {
  const { cfg, storePath, entry, canonicalKey } = loadSessionEntry(params.sessionKey, {
    agentId: params.agentId,
  });
  if (!entry?.sessionId || !storePath) {
    return { files: [] };
  }
  const agentId = normalizeAgentId(
    parseAgentSessionKey(canonicalKey)?.agentId ??
      params.agentId ??
      parseAgentSessionKey(params.sessionKey)?.agentId ??
      resolveDefaultAgentId(cfg),
  );
  const spawnedCwd = normalizePathValue(entry.spawnedCwd);
  const root =
    normalizePathValue(entry.spawnedWorkspaceDir) ??
    spawnedCwd ??
    normalizePathValue(resolveAgentWorkspaceDir(cfg, agentId));
  const fileRoot = resolveFileRoot({ root, spawnedCwd });
  const files = new Map<string, TouchedFile>();
  await visitSessionMessagesAsync(
    {
      agentId,
      sessionEntry: entry,
      sessionId: entry.sessionId,
      sessionKey: canonicalKey,
      storePath,
    },
    (message) => collectTouchedFilesFromMessage(message, files),
    {
      mode: "full",
      reason: "session files transcript scan",
      cache: "reuse",
    },
  );
  return {
    root,
    fileRoot,
    files: [...files.values()].toSorted((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "modified" ? -1 : 1;
      }
      return a.path.localeCompare(b.path);
    }),
  };
}

async function buildListResult(params: {
  sessionKey: string;
  agentId?: string;
  path?: string;
  search?: string;
}): Promise<{ root?: string; files: SessionFileEntry[]; browser?: SessionFileBrowserResult }> {
  const loaded = await loadSessionFiles(params);
  const files = await Promise.all(
    loaded.files.map((file) => toSessionFileEntry(file, loaded.root, loaded.fileRoot)),
  );
  const browser = await buildBrowserResult({
    root: loaded.root,
    fileRoot: loaded.fileRoot,
    path: params.path,
    search: params.search,
    files: loaded.files,
  });
  return {
    ...(loaded.root ? { root: loaded.root } : {}),
    files,
    ...(browser ? { browser } : {}),
  };
}

async function findSessionFile(
  params: SessionsFilesGetParams,
): Promise<{ root?: string; file?: SessionFileEntry }> {
  const loaded = await loadSessionFiles(params);
  const exactTouched = loaded.files.find((file) => file.path === params.path);
  if (exactTouched) {
    return {
      ...(loaded.root ? { root: loaded.root } : {}),
      file: await toSessionFileEntry(exactTouched, loaded.root, loaded.fileRoot, {
        includeContent: true,
      }),
    };
  }
  const resolved = resolveWorkspacePath(loaded.root, params.path);
  if (!resolved || !loaded.root) {
    return loaded.root ? { root: loaded.root } : {};
  }
  const relevance = buildSessionRelevanceMap(loaded.files, loaded.root, loaded.fileRoot);
  const browserPath = toDisplayPath(loaded.root, resolved);
  const sessionKind = relevance.get(browserPath);
  if (!sessionKind) {
    return loaded.root ? { root: loaded.root } : {};
  }
  const touched: TouchedFile = {
    path: browserPath,
    kind: sessionKind === "modified" ? "modified" : "read",
  };
  return {
    ...(loaded.root ? { root: loaded.root } : {}),
    file: await toSessionFileEntry(touched, loaded.root, loaded.root, {
      includeContent: true,
    }),
  };
}

function respondSessionFileNotFound(respond: RespondFn, filePath: string) {
  respond(
    false,
    undefined,
    sessionFilesError("session_file_not_found", "session file not found", { path: filePath }),
  );
}

function respondSessionFileTooLarge(respond: RespondFn, file: SessionFileEntry, filePath: string) {
  respond(
    false,
    undefined,
    sessionFilesError("session_file_too_large", "session file is too large to preview", {
      maxPreviewBytes: MAX_PREVIEW_BYTES,
      path: file.path || filePath,
      size: file.size,
    }),
  );
}

/** Gateway handlers for files referenced by session transcripts. */
export const sessionsFilesHandlers: GatewayRequestHandlers = {
  "sessions.files.list": async ({ params, respond }) => {
    if (
      !assertValidParams(params, validateSessionsFilesListParams, "sessions.files.list", respond)
    ) {
      return;
    }
    const result = await buildListResult(params);
    respond(true, {
      sessionKey: params.sessionKey,
      ...result,
    });
  },
  "sessions.files.get": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsFilesGetParams, "sessions.files.get", respond)) {
      return;
    }
    const result = await findSessionFile(params);
    if (typeof result.file?.content !== "string") {
      if (result.file && !result.file.missing) {
        respondSessionFileTooLarge(respond, result.file, params.path);
        return;
      }
      respondSessionFileNotFound(respond, params.path);
      return;
    }
    respond(true, {
      sessionKey: params.sessionKey,
      ...result,
    });
  },
};
