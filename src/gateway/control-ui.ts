import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import {
  isPackageProvenControlUiRootSync,
  resolveControlUiRootSync,
} from "../infra/control-ui-assets.js";
import { isWithinDir } from "../infra/path-safety.js";
import { openVerifiedFileSync } from "../infra/safe-open-sync.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-policy.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  CONTROL_UI_GROWTH_FOUNDATION_PATH,
  CONTROL_UI_GROWTH_FILE_PATH,
  CONTROL_UI_GROWTH_REVIEW_ACTION_PATH,
  type ControlUiBootstrapConfig,
  type ControlUiGrowthCodexReviewBackfillItem,
  type ControlUiGrowthIssueFlowRun,
  type ControlUiGrowthCodexSmokeBackfillItem,
  type ControlUiGrowthFoundationSnapshot,
  type ControlUiGrowthCompletionEntry,
  type ControlUiGrowthNotificationItem,
  type ControlUiGrowthReviewAction,
  type ControlUiGrowthReviewActionResponse,
  type ControlUiGrowthReviewItem,
} from "./control-ui-contract.js";
import { buildControlUiCspHeader } from "./control-ui-csp.js";
import {
  isReadHttpMethod,
  respondNotFound as respondControlUiNotFound,
  respondPlainText,
} from "./control-ui-http-utils.js";
import { classifyControlUiRequest } from "./control-ui-routing.js";
import {
  buildControlUiAvatarUrl,
  CONTROL_UI_AVATAR_PREFIX,
  normalizeControlUiBasePath,
  resolveAssistantAvatarUrl,
} from "./control-ui-shared.js";

const ROOT_PREFIX = "/";
const CONTROL_UI_ASSETS_MISSING_MESSAGE =
  "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.";
const CONTROL_UI_GROWTH_MAX_BYTES = 64 * 1024;
const CONTROL_UI_GROWTH_FILE_MAX_BYTES = 256 * 1024;
const CONTROL_UI_GROWTH_ACTION_MAX_BYTES = 8 * 1024;
const CONTROL_UI_GROWTH_READABLE_EXTENSIONS = new Set([".json", ".md", ".patch", ".txt"]);

export type ControlUiRequestOptions = {
  basePath?: string;
  config?: OpenClawConfig;
  agentId?: string;
  root?: ControlUiRootState;
};

export type ControlUiRootState =
  | { kind: "bundled"; path: string }
  | { kind: "resolved"; path: string }
  | { kind: "invalid"; path: string }
  | { kind: "missing" };

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".patch":
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/**
 * Extensions recognised as static assets.  Missing files with these extensions
 * return 404 instead of the SPA index.html fallback.  `.html` is intentionally
 * excluded — actual HTML files on disk are served earlier, and missing `.html`
 * paths should fall through to the SPA router (client-side routers may use
 * `.html`-suffixed routes).
 */
const STATIC_ASSET_EXTENSIONS = new Set([
  ".js",
  ".css",
  ".json",
  ".map",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".txt",
]);

export type ControlUiAvatarResolution =
  | { kind: "none"; reason: string }
  | { kind: "local"; filePath: string }
  | { kind: "remote"; url: string }
  | { kind: "data"; url: string };

type ControlUiAvatarMeta = {
  avatarUrl: string | null;
};

function applyControlUiSecurityHeaders(res: ServerResponse) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", buildControlUiCspHeader());
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(JSON.stringify(body));
}

function respondControlUiAssetsUnavailable(
  res: ServerResponse,
  options?: { configuredRootPath?: string },
) {
  if (options?.configuredRootPath) {
    respondPlainText(
      res,
      503,
      `Control UI assets not found at ${options.configuredRootPath}. Build them with \`pnpm ui:build\` (auto-installs UI deps), or update gateway.controlUi.root.`,
    );
    return;
  }
  respondPlainText(res, 503, CONTROL_UI_ASSETS_MISSING_MESSAGE);
}

function respondHeadForFile(req: IncomingMessage, res: ServerResponse, filePath: string): boolean {
  if (req.method !== "HEAD") {
    return false;
  }
  res.statusCode = 200;
  setStaticFileHeaders(res, filePath);
  res.end();
  return true;
}

function isValidAgentId(agentId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId);
}

export function handleControlUiAvatarRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { basePath?: string; resolveAvatar: (agentId: string) => ControlUiAvatarResolution },
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  if (!isReadHttpMethod(req.method)) {
    return false;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts.basePath);
  const pathname = url.pathname;
  const pathWithBase = basePath
    ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/`
    : `${CONTROL_UI_AVATAR_PREFIX}/`;
  if (!pathname.startsWith(pathWithBase)) {
    return false;
  }

  applyControlUiSecurityHeaders(res);

  const agentIdParts = pathname.slice(pathWithBase.length).split("/").filter(Boolean);
  const agentId = agentIdParts[0] ?? "";
  if (agentIdParts.length !== 1 || !agentId || !isValidAgentId(agentId)) {
    respondControlUiNotFound(res);
    return true;
  }

  if (url.searchParams.get("meta") === "1") {
    const resolved = opts.resolveAvatar(agentId);
    const avatarUrl =
      resolved.kind === "local"
        ? buildControlUiAvatarUrl(basePath, agentId)
        : resolved.kind === "remote" || resolved.kind === "data"
          ? resolved.url
          : null;
    sendJson(res, 200, { avatarUrl } satisfies ControlUiAvatarMeta);
    return true;
  }

  const resolved = opts.resolveAvatar(agentId);
  if (resolved.kind !== "local") {
    respondControlUiNotFound(res);
    return true;
  }

  const safeAvatar = resolveSafeAvatarFile(resolved.filePath);
  if (!safeAvatar) {
    respondControlUiNotFound(res);
    return true;
  }
  try {
    if (respondHeadForFile(req, res, safeAvatar.path)) {
      return true;
    }

    serveResolvedFile(res, safeAvatar.path, fs.readFileSync(safeAvatar.fd));
    return true;
  } finally {
    fs.closeSync(safeAvatar.fd);
  }
}

function setStaticFileHeaders(res: ServerResponse, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader("Content-Type", contentTypeForExt(ext));
  // Static UI should never be cached aggressively while iterating; allow the
  // browser to revalidate.
  res.setHeader("Cache-Control", "no-cache");
}

function serveResolvedFile(res: ServerResponse, filePath: string, body: Buffer) {
  setStaticFileHeaders(res, filePath);
  res.end(body);
}

function serveResolvedIndexHtml(res: ServerResponse, body: string) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(body);
}

function isExpectedSafePathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function resolveSafeAvatarFile(filePath: string): { path: string; fd: number } | null {
  const opened = openVerifiedFileSync({
    filePath,
    rejectPathSymlink: true,
    maxBytes: AVATAR_MAX_BYTES,
  });
  if (!opened.ok) {
    return null;
  }
  return { path: opened.path, fd: opened.fd };
}

function resolveSafeControlUiFile(
  rootReal: string,
  filePath: string,
  rejectHardlinks: boolean,
): { path: string; fd: number } | null {
  const opened = openBoundaryFileSync({
    absolutePath: filePath,
    rootPath: rootReal,
    rootRealPath: rootReal,
    boundaryLabel: "control ui root",
    skipLexicalRootCheck: true,
    rejectHardlinks,
  });
  if (!opened.ok) {
    if (opened.reason === "io") {
      throw opened.error;
    }
    return null;
  }
  return { path: opened.path, fd: opened.fd };
}

function isSafeRelativePath(relPath: string) {
  if (!relPath) {
    return false;
  }
  const normalized = path.posix.normalize(relPath);
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    return false;
  }
  if (normalized.startsWith("../") || normalized === "..") {
    return false;
  }
  if (normalized.includes("\0")) {
    return false;
  }
  return true;
}

function isWithinRelativePrefix(relPath: string, prefix: string): boolean {
  return relPath === prefix || relPath.startsWith(`${prefix}/`);
}

function stripWrappingBackticks(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("`") && trimmed.endsWith("`") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeMarkdownBullet(value: string): string {
  return stripWrappingBackticks(value.trim().replace(/^\[(?: |x)\]\s*/i, ""))
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function growthReviewItemKey(value: string): string {
  const normalized = value.replace(/`/g, "").trim().split(/\s+/).join(" ");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

function parseMarkdownKeyValueList(text: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^- ([^:]+):\s*(.+)$/);
    if (!match) {
      continue;
    }
    output[match[1].trim().toLowerCase()] = normalizeMarkdownBullet(match[2]);
  }
  return output;
}

function parseMarkdownSectionReviewItems(
  text: string,
  heading: string,
): ControlUiGrowthReviewItem[] {
  return parseMarkdownSectionItems(text, heading).map((item) => ({
    key: growthReviewItemKey(item),
    text: item,
    display: item,
    completedAt: null,
    source: null,
  }));
}

function parseMarkdownSectionItems(text: string, heading: string): string[] {
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line === `## ${heading}`) {
      inSection = true;
      continue;
    }
    if (!inSection) {
      continue;
    }
    if (line.startsWith("## ")) {
      break;
    }
    const match = line.match(/^- (.+)$/);
    if (!match) {
      continue;
    }
    const item = normalizeMarkdownBullet(match[1]);
    if (!item || item.toLowerCase() === "none") {
      continue;
    }
    output.push(item);
  }
  return output;
}

function latestWorkspaceMarkdownPath(workspaceRoot: string, relDir: string): string | null {
  if (!isSafeRelativePath(relDir)) {
    return null;
  }
  const absDir = path.resolve(workspaceRoot, relDir);
  try {
    if (!isWithinDir(workspaceRoot, absDir)) {
      return null;
    }
    const entries = fs
      .readdirSync(absDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .toSorted();
    const latest = entries.at(-1);
    return latest ? path.posix.join(relDir, latest) : null;
  } catch {
    return null;
  }
}

function latestWorkspaceJsonPath(workspaceRoot: string, relDir: string): string | null {
  if (!isSafeRelativePath(relDir)) {
    return null;
  }
  const absDir = path.resolve(workspaceRoot, relDir);
  try {
    if (!isWithinDir(workspaceRoot, absDir)) {
      return null;
    }
    const entries = fs
      .readdirSync(absDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .toSorted();
    const latest = entries.at(-1);
    return latest ? path.posix.join(relDir, latest) : null;
  } catch {
    return null;
  }
}

function parseCompletedHistoryItems(text: string): ControlUiGrowthCompletionEntry[] {
  const entries: ControlUiGrowthCompletionEntry[] = [];
  let current: ControlUiGrowthCompletionEntry | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) {
      if (current && current.text) {
        entries.push(current);
      }
      current = {
        timestamp: line.slice(3).trim(),
        action: "",
        itemKey: "",
        weekly: "",
        weeklyPath: null,
        source: "",
        text: "",
      };
      continue;
    }
    if (!current) {
      continue;
    }
    const match = line.match(/^- ([^:]+):\s*(.+)$/);
    if (!match) {
      continue;
    }
    const key = match[1].trim().toLowerCase();
    const value = normalizeMarkdownBullet(match[2]);
    switch (key) {
      case "action":
        current.action = value;
        break;
      case "item-key":
        current.itemKey = value;
        break;
      case "weekly":
        current.weekly = value;
        break;
      case "source":
        current.source = value;
        break;
      case "text":
        current.text = value;
        break;
      default:
        break;
    }
  }
  if (current && current.text) {
    entries.push(current);
  }
  return entries
    .toSorted((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 5);
}

function resolveWorkspaceRoot(config?: OpenClawConfig): string | null {
  const home = process.env.HOME?.trim();
  const configured = config?.agents?.defaults?.workspace?.trim();
  if (configured) {
    if (configured === "~") {
      return home ?? null;
    }
    if (configured.startsWith("~/") && home) {
      return path.join(home, configured.slice(2));
    }
    return configured;
  }
  if (!home) {
    return null;
  }
  return path.join(home, ".openclaw", "workspace");
}

function readWorkspaceTextFile(
  workspaceRoot: string,
  relPath: string,
  maxBytes = CONTROL_UI_GROWTH_MAX_BYTES,
): string | null {
  if (!isSafeRelativePath(relPath)) {
    return null;
  }
  const workspaceReal = (() => {
    try {
      return fs.realpathSync(workspaceRoot);
    } catch {
      return null;
    }
  })();
  if (!workspaceReal) {
    return null;
  }
  const filePath = path.resolve(workspaceRoot, relPath);
  const opened = openBoundaryFileSync({
    absolutePath: filePath,
    rootPath: workspaceRoot,
    rootRealPath: workspaceReal,
    boundaryLabel: "workspace root",
    maxBytes,
  });
  if (!opened.ok) {
    return null;
  }
  try {
    return fs.readFileSync(opened.fd, "utf8");
  } finally {
    fs.closeSync(opened.fd);
  }
}

function resolveGrowthProjectMarkdownPath(
  workspaceRoot: string,
  projectId: string,
  relPath: string,
): string | null {
  if (!isSafeRelativePath(relPath) || !relPath.endsWith(".md")) {
    return null;
  }
  const prefix = path.posix.join("memory", "projects", projectId);
  if (!(relPath === prefix || relPath.startsWith(`${prefix}/`))) {
    return null;
  }
  return readWorkspaceTextFile(workspaceRoot, relPath) ? relPath : null;
}

function isReadableGrowthArtifactPath(projectId: string, relPath: string): boolean {
  if (!isSafeRelativePath(relPath)) {
    return false;
  }
  const normalized = path.posix.normalize(relPath);
  const ext = path.posix.extname(normalized).toLowerCase();
  if (!CONTROL_UI_GROWTH_READABLE_EXTENSIONS.has(ext)) {
    return false;
  }
  return (
    isWithinRelativePrefix(normalized, path.posix.join("memory", "projects", projectId)) ||
    isWithinRelativePrefix(normalized, path.posix.join("projects", projectId, "evidence")) ||
    isWithinRelativePrefix(normalized, path.posix.join("queue", "results"))
  );
}

// Only serve text artifacts that the summary already surfaced to the overview panel.
function collectGrowthReadableFilePaths(snapshot: ControlUiGrowthFoundationSnapshot): Set<string> {
  const readable = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = path.posix.normalize(value.trim());
    if (!normalized) {
      return;
    }
    readable.add(normalized);
  };

  add(snapshot.alertsPath);
  add(snapshot.actionsPath);
  add(snapshot.completedHistoryPath);
  add(snapshot.heartbeatPath);
  add(snapshot.weeklyReviewPath);
  add(snapshot.codexSmokeStatePath);
  add(snapshot.codexReviewSmokeStatePath);
  add(snapshot.codexReviewSmokeDiffPath);
  add(snapshot.codexReviewSmokeBackfillStatePath);
  add(snapshot.codexSmokeBackfillStatePath);
  add(snapshot.githubSyncCurrentPath);
  add(snapshot.githubWritebackProposalPath);
  add(snapshot.githubWritebackReceiptPath);
  add(snapshot.issueFlowDirectoryPath);
  add(snapshot.issueFlowPreflightPath);
  add(snapshot.issueFlowDraftPath);
  add(snapshot.issueFlowProposalPath);
  add(snapshot.issueFlowReceiptPath);
  add(snapshot.issueFlowOutcomePath);
  add(snapshot.issueFlowPrimaryResultPath);
  add(snapshot.issueFlowArchiveRootPath);
  add(snapshot.issueFlowArchivedLatestPath);
  add(snapshot.issueFlowArchivedLatestReceiptPath);
  add(snapshot.relayCurrentPath);

  for (const item of snapshot.notificationItems) {
    add(item.path);
  }
  for (const item of snapshot.completedHistoryItems) {
    add(item.weeklyPath);
  }
  for (const item of snapshot.codexReviewSmokeBackfillItems) {
    add(item.diffRelpath);
  }
  for (const item of snapshot.issueFlowRecentItems ?? []) {
    add(item.directoryPath);
    add(item.preflightPath);
    add(item.draftPath);
    add(item.proposalPath);
    add(item.receiptPath);
    add(item.outcomePath);
    add(item.primaryResultPath);
  }

  return readable;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readRecordString(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  return readTrimmedString(record?.[key]);
}

function readWorkspaceJsonFile(workspaceRoot: string, relPath: string): unknown {
  const text = readWorkspaceTextFile(workspaceRoot, relPath);
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolveGrowthProjectFilePath(
  workspaceRoot: string,
  projectId: string,
  relPath: string,
  expectedExt: ".json" | ".md",
): string | null {
  if (!isSafeRelativePath(relPath) || !relPath.endsWith(expectedExt)) {
    return null;
  }
  const prefix = path.posix.join("memory", "projects", projectId);
  if (!(relPath === prefix || relPath.startsWith(`${prefix}/`))) {
    return null;
  }
  return readWorkspaceTextFile(workspaceRoot, relPath) ? relPath : null;
}

function normalizeGrowthProjectArtifactPath(
  relPath: string | null | undefined,
  params: { displayProjectId: string | null; workspaceProjectId: string },
): string | null {
  if (typeof relPath !== "string") {
    return null;
  }
  const normalized = path.posix.normalize(relPath.trim());
  if (!normalized) {
    return null;
  }
  const displayProjectId = params.displayProjectId?.trim() || null;
  if (!displayProjectId || displayProjectId === params.workspaceProjectId) {
    return normalized;
  }
  const rewrites: Array<[string, string]> = [
    [
      path.posix.join("memory", "projects", displayProjectId),
      path.posix.join("memory", "projects", params.workspaceProjectId),
    ],
    [
      path.posix.join("projects", displayProjectId, "evidence"),
      path.posix.join("projects", params.workspaceProjectId, "evidence"),
    ],
  ];
  for (const [fromPrefix, toPrefix] of rewrites) {
    if (normalized === fromPrefix || normalized.startsWith(`${fromPrefix}/`)) {
      return `${toPrefix}${normalized.slice(fromPrefix.length)}`;
    }
  }
  return normalized;
}

function readGrowthAutomationPayload(
  workspaceRoot: string,
  projectId: string,
  filename: string,
): { path: string | null; payload: Record<string, unknown> | null } {
  const relPath = path.posix.join("memory", "projects", projectId, "automation", filename);
  const safePath = resolveGrowthProjectFilePath(workspaceRoot, projectId, relPath, ".json");
  if (!safePath) {
    return { path: null, payload: null };
  }
  const payload = readWorkspaceJsonFile(workspaceRoot, safePath);
  return {
    path: safePath,
    payload: payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null,
  };
}

function readGrowthProjectStatePayload(
  workspaceRoot: string,
  projectId: string,
  lane: string,
): { path: string | null; payload: Record<string, unknown> | null } {
  const relPath = path.posix.join("memory", "projects", projectId, lane, "state.json");
  const safePath = resolveGrowthProjectFilePath(workspaceRoot, projectId, relPath, ".json");
  if (!safePath) {
    return { path: null, payload: null };
  }
  const payload = readWorkspaceJsonFile(workspaceRoot, safePath);
  return {
    path: safePath,
    payload: payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null,
  };
}

function resolveGrowthLaneMarkdownPath(
  workspaceRoot: string,
  projectId: string,
  lane: string,
  filename: string,
): string | null {
  const relPath = path.posix.join("memory", "projects", projectId, lane, filename);
  return resolveGrowthProjectMarkdownPath(workspaceRoot, projectId, relPath);
}

function parseGrowthBackfillItems<
  T extends ControlUiGrowthCodexSmokeBackfillItem | ControlUiGrowthCodexReviewBackfillItem,
>(
  payload: Record<string, unknown> | null,
  mapItem: (period: string, value: Record<string, unknown>, requestedAt: string | null) => T,
): { count: number; items: T[] } {
  const entries = payload?.entries;
  if (!entries || typeof entries !== "object") {
    return { count: 0, items: [] };
  }
  const items = Object.entries(entries)
    .flatMap(([period, rawValue]) => {
      const value = readRecord(rawValue);
      if (!value) {
        return [];
      }
      const requestedAt = readRecordString(value, "requested_at");
      return [mapItem(period, value, requestedAt)];
    })
    .toSorted((left, right) =>
      `${right.requestedAt ?? ""}|${right.period}`.localeCompare(
        `${left.requestedAt ?? ""}|${left.period}`,
      ),
    )
    .slice(0, 5);
  return { count: Object.keys(entries).length, items };
}

function summarizeGrowthWriteback(params: {
  proposalPayload: Record<string, unknown> | null;
  receiptPayload: Record<string, unknown> | null;
}) {
  const proposalIssueRef = readRecordString(params.proposalPayload, "issue_ref");
  const receiptIssueRef = readRecordString(params.receiptPayload, "issue_ref");
  const proposalUpdatedAt = readRecordString(params.proposalPayload, "generated_at");
  const receiptAppliedAt = readRecordString(params.receiptPayload, "applied_at");
  const actionsSource = Array.isArray(params.proposalPayload?.planned_actions)
    ? params.proposalPayload?.planned_actions
    : Array.isArray(params.receiptPayload?.actions)
      ? params.receiptPayload?.actions
      : [];
  const actions = actionsSource
    .map((item) => readTrimmedString(item) ?? "")
    .filter((item) => item.length > 0);
  const closeIssue = Boolean(
    params.proposalPayload?.close_issue ?? params.receiptPayload?.close_issue ?? false,
  );
  const operator = readRecordString(params.receiptPayload, "operator");

  let status = "missing";
  if (params.proposalPayload && proposalIssueRef) {
    status = "proposal-ready";
  }
  if (
    params.proposalPayload &&
    params.receiptPayload &&
    proposalIssueRef &&
    receiptIssueRef &&
    proposalIssueRef === receiptIssueRef &&
    proposalUpdatedAt &&
    receiptAppliedAt &&
    receiptAppliedAt >= proposalUpdatedAt
  ) {
    status = "applied";
  } else if (params.receiptPayload && receiptIssueRef && status === "missing") {
    status = "receipt-only";
  }

  return {
    status,
    issueRef: proposalIssueRef ?? receiptIssueRef,
    actions,
    closeIssue,
    operator,
    proposalUpdatedAt,
    receiptAppliedAt,
  };
}

function summarizeGrowthIssueFlowVisibility(params: {
  issueFlow: {
    issueFlowIssueRef: string | null;
  };
  githubSyncPayload: Record<string, unknown> | null;
  githubWriteback: {
    issueRef: string | null;
    closeIssue: boolean;
    receiptAppliedAt: string | null;
  };
}) {
  const issueRef = params.issueFlow.issueFlowIssueRef;
  const githubSyncStatus = readRecordString(params.githubSyncPayload, "status") ?? "missing";
  const githubSyncUpdatedAt = readRecordString(params.githubSyncPayload, "updated_at");
  if (!issueRef) {
    return {
      issueFlowVisibilityStatus: "missing",
      issueFlowVisibilityReason: "No live issue-flow chain is present yet.",
      issueFlowVisibilityOpenIssue: null,
      issueFlowVisibilityGithubSyncUpdatedAt: githubSyncUpdatedAt,
    };
  }
  if (
    githubSyncStatus === "missing" ||
    githubSyncStatus === "disabled" ||
    githubSyncStatus === "error"
  ) {
    return {
      issueFlowVisibilityStatus: "sync-missing",
      issueFlowVisibilityReason:
        "GitHub sync is unavailable, so issue-flow visibility cannot be compared.",
      issueFlowVisibilityOpenIssue: null,
      issueFlowVisibilityGithubSyncUpdatedAt: githubSyncUpdatedAt,
    };
  }

  const issues = Array.isArray(params.githubSyncPayload?.issues)
    ? params.githubSyncPayload.issues
    : [];
  const openIssueRefs = new Set(
    issues
      .map((item) => readRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .flatMap((item) => {
        const repo = readRecordString(item, "repo") ?? "";
        const number = Number(item.number ?? 0);
        const state = (readRecordString(item, "state") ?? "").toLowerCase();
        if (!repo || !Number.isFinite(number) || number <= 0) {
          return [];
        }
        if (state && state !== "open") {
          return [];
        }
        return [`${repo}#${number}`];
      }),
  );

  const issueOpen = openIssueRefs.has(issueRef);
  const receiptAppliedAt = params.githubWriteback.receiptAppliedAt;
  const receiptAppliedMs = receiptAppliedAt ? Date.parse(receiptAppliedAt) : Number.NaN;
  const githubSyncUpdatedMs = githubSyncUpdatedAt ? Date.parse(githubSyncUpdatedAt) : Number.NaN;

  let issueFlowVisibilityStatus = "aligned";
  let issueFlowVisibilityReason = "The latest issue-flow chain matches the current GitHub sync.";
  if (
    params.githubWriteback.issueRef === issueRef &&
    Number.isFinite(receiptAppliedMs) &&
    Number.isFinite(githubSyncUpdatedMs) &&
    githubSyncUpdatedMs < receiptAppliedMs
  ) {
    issueFlowVisibilityStatus = "pending-sync";
    issueFlowVisibilityReason =
      "GitHub write-back receipt is newer than the latest GitHub sync snapshot.";
  } else if (!issueOpen) {
    if (
      params.githubWriteback.issueRef === issueRef &&
      Number.isFinite(receiptAppliedMs) &&
      params.githubWriteback.closeIssue
    ) {
      issueFlowVisibilityStatus = "aligned";
      issueFlowVisibilityReason = "The issue is no longer open after an applied close write-back.";
    } else {
      issueFlowVisibilityStatus = "state-drift";
      issueFlowVisibilityReason =
        "The latest issue-flow issue is absent from the current open-issue sync.";
    }
  } else if (
    params.githubWriteback.issueRef === issueRef &&
    Number.isFinite(receiptAppliedMs) &&
    params.githubWriteback.closeIssue
  ) {
    issueFlowVisibilityStatus = "state-drift";
    issueFlowVisibilityReason =
      "A close write-back was applied, but the issue still appears open in GitHub sync.";
  }

  return {
    issueFlowVisibilityStatus,
    issueFlowVisibilityReason,
    issueFlowVisibilityOpenIssue: issueOpen,
    issueFlowVisibilityGithubSyncUpdatedAt: githubSyncUpdatedAt,
  };
}

function resolveGrowthProjectFiles(
  workspaceRoot: string,
): { projectId: string; actionsPath: string; alertsPath: string } | null {
  const projectsDir = path.join(workspaceRoot, "memory", "projects");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let best: { projectId: string; actionsPath: string; alertsPath: string; score: number } | null =
    null;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const projectId = entry.name;
    const actionsPath = path.join("memory", "projects", projectId, "actions", "current.md");
    const alertsPath = path.join("memory", "projects", projectId, "alerts", "current.md");
    try {
      const actionsStat = fs.statSync(path.join(workspaceRoot, actionsPath));
      const alertsStat = fs.statSync(path.join(workspaceRoot, alertsPath));
      const score = Math.max(actionsStat.mtimeMs, alertsStat.mtimeMs);
      if (!best || score > best.score) {
        best = { projectId, actionsPath, alertsPath, score };
      }
    } catch {
      continue;
    }
  }
  return best
    ? {
        projectId: best.projectId,
        actionsPath: best.actionsPath,
        alertsPath: best.alertsPath,
      }
    : null;
}

function completedGrowthReviewItems(params: {
  workspaceRoot: string;
  projectId: string;
  weeklyReviewPath: string | null;
}): ControlUiGrowthReviewItem[] {
  const { workspaceRoot, projectId, weeklyReviewPath } = params;
  const weeklyName = weeklyReviewPath ? path.posix.basename(weeklyReviewPath) : "";
  if (!weeklyName) {
    return [];
  }
  const manualStatePath = path.join(
    "memory",
    "projects",
    projectId,
    "actions",
    "manual-state.json",
  );
  const payload = readWorkspaceJsonFile(workspaceRoot, manualStatePath);
  if (!payload || typeof payload !== "object" || !("completed" in payload)) {
    return [];
  }
  const completed = (payload as { completed?: unknown }).completed;
  if (!completed || typeof completed !== "object") {
    return [];
  }
  const items: ControlUiGrowthReviewItem[] = [];
  for (const [key, rawValue] of Object.entries(completed)) {
    const value = readRecord(rawValue);
    if (!value) {
      continue;
    }
    if (readRecordString(value, "status") !== "completed") {
      continue;
    }
    if (readRecordString(value, "section") !== "this_week") {
      continue;
    }
    if (readRecordString(value, "weekly") !== weeklyName) {
      continue;
    }
    const text = readRecordString(value, "text") ?? "";
    if (!text) {
      continue;
    }
    items.push({
      key,
      text,
      display: normalizeMarkdownBullet(text),
      completedAt: readRecordString(value, "completed_at"),
      source: readRecordString(value, "source"),
    });
  }
  return items.toSorted((left, right) =>
    `${left.completedAt ?? ""}|${left.display}`.localeCompare(
      `${right.completedAt ?? ""}|${right.display}`,
    ),
  );
}

function completedGrowthHistory(params: { workspaceRoot: string; projectId: string }): {
  path: string | null;
  items: ControlUiGrowthCompletionEntry[];
} {
  const relPath = path.posix.join("memory", "projects", params.projectId, "actions", "completed");
  const latestPath = latestWorkspaceMarkdownPath(params.workspaceRoot, relPath);
  if (!latestPath) {
    return { path: null, items: [] };
  }
  const text = readWorkspaceTextFile(params.workspaceRoot, latestPath);
  if (!text) {
    return { path: latestPath, items: [] };
  }
  const items = parseCompletedHistoryItems(text).map((item) => {
    const weeklyPath = item.weekly
      ? resolveGrowthProjectMarkdownPath(
          params.workspaceRoot,
          params.projectId,
          path.posix.join("memory", "projects", params.projectId, "weekly", item.weekly),
        )
      : null;
    return { ...item, weeklyPath };
  });
  return { path: latestPath, items };
}

function buildGrowthIssueFlowSummary(params: { workspaceRoot: string; projectId: string }): {
  issueFlowStatus: string;
  issueFlowStage: string | null;
  issueFlowIssueNumber: number | null;
  issueFlowIssueRef: string | null;
  issueFlowUpdatedAt: string | null;
  issueFlowDirectoryPath: string | null;
  issueFlowPreflightStatus: string;
  issueFlowDraftStatus: string;
  issueFlowProposalStatus: string;
  issueFlowEnqueueStatus: string;
  issueFlowOutcomeStatus: string;
  issueFlowPreflightPath: string | null;
  issueFlowDraftPath: string | null;
  issueFlowProposalPath: string | null;
  issueFlowReceiptPath: string | null;
  issueFlowOutcomePath: string | null;
  issueFlowPrimaryResultPath: string | null;
  issueFlowActiveCount: number;
  issueFlowRecentCount: number;
  issueFlowRecentItems: ControlUiGrowthIssueFlowRun[];
  issueFlowArchivedCount: number;
  issueFlowArchiveRootPath: string | null;
  issueFlowArchivedLatestIssueRef: string | null;
  issueFlowArchivedLatestArchivedAt: string | null;
  issueFlowArchivedLatestPath: string | null;
  issueFlowArchivedLatestReceiptPath: string | null;
  issueFlowVisibilityStatus: string;
  issueFlowVisibilityReason: string | null;
  issueFlowVisibilityOpenIssue: boolean | null;
  issueFlowVisibilityGithubSyncUpdatedAt: string | null;
} {
  const empty = {
    issueFlowStatus: "missing",
    issueFlowStage: null,
    issueFlowIssueNumber: null,
    issueFlowIssueRef: null,
    issueFlowUpdatedAt: null,
    issueFlowDirectoryPath: null,
    issueFlowPreflightStatus: "missing",
    issueFlowDraftStatus: "missing",
    issueFlowProposalStatus: "missing",
    issueFlowEnqueueStatus: "missing",
    issueFlowOutcomeStatus: "missing",
    issueFlowPreflightPath: null,
    issueFlowDraftPath: null,
    issueFlowProposalPath: null,
    issueFlowReceiptPath: null,
    issueFlowOutcomePath: null,
    issueFlowPrimaryResultPath: null,
    issueFlowActiveCount: 0,
    issueFlowRecentCount: 0,
    issueFlowRecentItems: [],
    issueFlowArchivedCount: 0,
    issueFlowArchiveRootPath: null,
    issueFlowArchivedLatestIssueRef: null,
    issueFlowArchivedLatestArchivedAt: null,
    issueFlowArchivedLatestPath: null,
    issueFlowArchivedLatestReceiptPath: null,
    issueFlowVisibilityStatus: "missing",
    issueFlowVisibilityReason: null,
    issueFlowVisibilityOpenIssue: null,
    issueFlowVisibilityGithubSyncUpdatedAt: null,
  };
  const workspaceRoot = params.workspaceRoot;
  const issueFlowRoot = path.join(
    workspaceRoot,
    "memory",
    "projects",
    params.projectId,
    "issue-flow",
  );
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(issueFlowRoot, { withFileTypes: true });
  } catch {
    return empty;
  }

  const runs: Array<ControlUiGrowthIssueFlowRun & { score: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const match = /^issue-(\d+)$/.exec(entry.name);
    if (!match) {
      continue;
    }
    const issueNumber = Number(match[1]);
    if (!Number.isFinite(issueNumber)) {
      continue;
    }
    const relDir = path.posix.join(
      "memory",
      "projects",
      params.projectId,
      "issue-flow",
      entry.name,
    );
    const preflightPath = path.posix.join(relDir, "preflight.json");
    const draftPath = path.posix.join(relDir, "orchestrator-draft.json");
    const proposalPath = path.posix.join(relDir, "queue-proposal.json");
    const receiptPath = path.posix.join(relDir, "enqueue-receipt.json");
    const outcomePath = path.posix.join(relDir, "outcome-bundle.json");
    const artifactPaths = [preflightPath, draftPath, proposalPath, receiptPath, outcomePath];
    const scores = artifactPaths
      .map((relPath) => {
        try {
          return fs.statSync(path.join(workspaceRoot, relPath)).mtimeMs;
        } catch {
          return null;
        }
      })
      .filter((value): value is number => value !== null);
    if (scores.length === 0) {
      continue;
    }

    const preflightRecord = readRecord(readWorkspaceJsonFile(workspaceRoot, preflightPath));
    const draftRecord = readRecord(readWorkspaceJsonFile(workspaceRoot, draftPath));
    const proposalRecord = readRecord(readWorkspaceJsonFile(workspaceRoot, proposalPath));
    const receiptRecord = readRecord(readWorkspaceJsonFile(workspaceRoot, receiptPath));
    const outcomeRecord = readRecord(readWorkspaceJsonFile(workspaceRoot, outcomePath));
    const issueRef =
      readRecordString(outcomeRecord, "issue_ref") ||
      readRecordString(receiptRecord, "issue_ref") ||
      readRecordString(proposalRecord, "issue_ref") ||
      readRecordString(draftRecord, "issue_ref") ||
      readRecordString(preflightRecord, "issue_ref") ||
      null;

    let issueFlowStage: string | null = null;
    let issueFlowStatus = "missing";
    let issueFlowUpdatedAt: string | null = null;
    if (outcomeRecord) {
      issueFlowStage = "outcome";
      issueFlowStatus = readRecordString(outcomeRecord, "outcome_status") || "outcome-ready";
      issueFlowUpdatedAt = readRecordString(outcomeRecord, "generated_at");
    } else if (receiptRecord) {
      issueFlowStage = "enqueue";
      issueFlowStatus = "enqueued";
      issueFlowUpdatedAt = readRecordString(receiptRecord, "enqueued_at");
    } else if (proposalRecord) {
      issueFlowStage = "proposal";
      issueFlowStatus = readRecordString(proposalRecord, "proposal_status") || "proposal-ready";
      issueFlowUpdatedAt = readRecordString(proposalRecord, "generated_at");
    } else if (draftRecord) {
      issueFlowStage = "draft";
      issueFlowStatus = readRecordString(draftRecord, "draft_status") || "draft-ready";
      issueFlowUpdatedAt = readRecordString(draftRecord, "generated_at");
    } else if (preflightRecord) {
      issueFlowStage = "preflight";
      issueFlowStatus = readRecordString(preflightRecord, "status") || "preflight-ready";
      issueFlowUpdatedAt = readRecordString(preflightRecord, "generated_at");
    }

    runs.push({
      score: Math.max(...scores),
      issueNumber,
      issueRef,
      stage: issueFlowStage,
      status: issueFlowStatus,
      updatedAt: issueFlowUpdatedAt,
      directoryPath: relDir,
      preflightStatus:
        readRecordString(preflightRecord, "status") ||
        (preflightRecord ? "preflight-ready" : "missing"),
      draftStatus:
        readRecordString(draftRecord, "draft_status") || (draftRecord ? "draft-ready" : "missing"),
      proposalStatus:
        readRecordString(proposalRecord, "proposal_status") ||
        (proposalRecord ? "proposal-ready" : "missing"),
      enqueueStatus: receiptRecord ? "enqueued" : "missing",
      outcomeStatus:
        readRecordString(outcomeRecord, "outcome_status") ||
        (outcomeRecord ? "outcome-ready" : "missing"),
      preflightPath: preflightRecord ? preflightPath : null,
      draftPath: draftRecord ? draftPath : null,
      proposalPath: proposalRecord ? proposalPath : null,
      receiptPath: receiptRecord ? receiptPath : null,
      outcomePath: outcomeRecord ? outcomePath : null,
      primaryResultPath: readRecordString(outcomeRecord, "primary_result_relpath"),
    });
  }

  const archiveRoot = path.join(issueFlowRoot, "archive");
  const archivedRuns: Array<{
    score: number;
    issueRef: string | null;
    archivedAt: string | null;
    directoryPath: string;
    receiptPath: string | null;
  }> = [];
  let archiveRootExists = false;
  try {
    archiveRootExists = fs.statSync(archiveRoot).isDirectory();
  } catch {
    archiveRootExists = false;
  }
  if (archiveRootExists) {
    let archivedEntries: fs.Dirent[] = [];
    try {
      archivedEntries = fs.readdirSync(archiveRoot, { withFileTypes: true });
    } catch {
      archivedEntries = [];
    }
    for (const entry of archivedEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const relDir = path.posix.join(
        "memory",
        "projects",
        params.projectId,
        "issue-flow",
        "archive",
        entry.name,
      );
      const receiptPath = path.posix.join(relDir, "archive-receipt.json");
      const receiptData = readRecord(readWorkspaceJsonFile(workspaceRoot, receiptPath));
      const issueRef = readRecordString(receiptData, "issue_ref");
      const archivedAt = readRecordString(receiptData, "archived_at");
      let score: number | null = null;
      try {
        score = fs.statSync(path.join(workspaceRoot, receiptPath)).mtimeMs;
      } catch {
        const entryRoot = path.join(archiveRoot, entry.name);
        try {
          const files = fs
            .readdirSync(entryRoot, { withFileTypes: true })
            .filter((child) => child.isFile())
            .map((child) => fs.statSync(path.join(entryRoot, child.name)).mtimeMs);
          if (files.length > 0) {
            score = Math.max(...files);
          }
        } catch {
          score = null;
        }
      }
      if (score === null) {
        continue;
      }
      archivedRuns.push({
        score,
        issueRef,
        archivedAt,
        directoryPath: relDir,
        receiptPath: receiptData ? receiptPath : null,
      });
    }
  }

  archivedRuns.sort((left, right) => right.score - left.score);
  const archivedLatest = archivedRuns[0] ?? null;
  const archiveFields = {
    issueFlowArchivedCount: archivedRuns.length,
    issueFlowArchiveRootPath: archiveRootExists
      ? path.posix.join("memory", "projects", params.projectId, "issue-flow", "archive")
      : null,
    issueFlowArchivedLatestIssueRef: archivedLatest?.issueRef ?? null,
    issueFlowArchivedLatestArchivedAt: archivedLatest?.archivedAt ?? null,
    issueFlowArchivedLatestPath: archivedLatest?.directoryPath ?? null,
    issueFlowArchivedLatestReceiptPath: archivedLatest?.receiptPath ?? null,
  };

  if (runs.length === 0) {
    return {
      ...empty,
      ...archiveFields,
    };
  }

  runs.sort((left, right) => right.score - left.score || right.issueNumber - left.issueNumber);
  const latest = runs[0];
  if (!latest) {
    return empty;
  }
  const recentItems = runs.slice(1, 6).map(({ score: _score, ...item }) => item);

  return {
    issueFlowStatus: latest.status,
    issueFlowStage: latest.stage,
    issueFlowIssueNumber: latest.issueNumber,
    issueFlowIssueRef: latest.issueRef,
    issueFlowUpdatedAt: latest.updatedAt,
    issueFlowDirectoryPath: latest.directoryPath,
    issueFlowPreflightStatus: latest.preflightStatus,
    issueFlowDraftStatus: latest.draftStatus,
    issueFlowProposalStatus: latest.proposalStatus,
    issueFlowEnqueueStatus: latest.enqueueStatus,
    issueFlowOutcomeStatus: latest.outcomeStatus,
    issueFlowPreflightPath: latest.preflightPath,
    issueFlowDraftPath: latest.draftPath,
    issueFlowProposalPath: latest.proposalPath,
    issueFlowReceiptPath: latest.receiptPath,
    issueFlowOutcomePath: latest.outcomePath,
    issueFlowPrimaryResultPath: latest.primaryResultPath,
    issueFlowActiveCount: runs.length,
    issueFlowRecentCount: recentItems.length,
    issueFlowRecentItems: recentItems,
    ...archiveFields,
    issueFlowVisibilityStatus: "missing",
    issueFlowVisibilityReason: null,
    issueFlowVisibilityOpenIssue: null,
    issueFlowVisibilityGithubSyncUpdatedAt: null,
  };
}

function buildGrowthNotificationItems(params: {
  alertStatus: string;
  alertAction: string | null;
  priorityNow: string[];
  thisWeekItems: ControlUiGrowthReviewItem[];
  watch: string[];
  alertsPath: string | null;
  actionsPath: string | null;
  weeklyReviewPath: string | null;
}): ControlUiGrowthNotificationItem[] {
  const items: ControlUiGrowthNotificationItem[] = [];
  if (params.alertStatus === "active") {
    items.push({
      id: "alert-active",
      severity: "danger",
      title: "Heartbeat alert active",
      detail: params.alertAction || "Growth heartbeat requires human review.",
      path: params.alertsPath,
      source: "alerts",
    });
  }
  if (params.priorityNow.length > 0) {
    items.push({
      id: "priority-open",
      severity: "warning",
      title: `${params.priorityNow.length} priority item(s) pending`,
      detail: params.priorityNow[0] ?? "",
      path: params.actionsPath,
      source: "actions",
    });
  }
  if (params.thisWeekItems.length > 0) {
    items.push({
      id: "reviews-open",
      severity: "warning",
      title: `${params.thisWeekItems.length} review item(s) pending`,
      detail: params.thisWeekItems[0]?.display ?? "",
      path: params.weeklyReviewPath ?? params.actionsPath,
      source: "weekly",
    });
  }
  if (params.watch.length > 0) {
    items.push({
      id: "watch-open",
      severity: "info",
      title: `${params.watch.length} watch item(s) open`,
      detail: params.watch[0] ?? "",
      path: params.actionsPath,
      source: "actions",
    });
  }
  return items;
}

function runGrowthReviewAction(params: {
  workspaceRoot: string;
  projectId: string;
  itemKey: string;
  action: ControlUiGrowthReviewAction;
}):
  | { ok: true; snapshot: ControlUiGrowthFoundationSnapshot }
  | { ok: false; status: number; error: string } {
  const scriptPath = path.join(
    params.workspaceRoot,
    "projects",
    params.projectId,
    "scripts",
    "complete_growth_action.py",
  );
  try {
    const scriptStat = fs.statSync(scriptPath);
    if (!scriptStat.isFile()) {
      return { ok: false, status: 409, error: `growth action script not found: ${scriptPath}` };
    }
  } catch {
    return { ok: false, status: 409, error: `growth action script not found: ${scriptPath}` };
  }
  const result = spawnSync(
    "python3",
    [
      scriptPath,
      "--workspace-root",
      params.workspaceRoot,
      "--project",
      params.projectId,
      "--item-key",
      params.itemKey,
      "--action",
      params.action,
      "--source",
      "control-ui",
    ],
    {
      encoding: "utf8",
      timeout: 45_000,
    },
  );
  if (result.error) {
    return { ok: false, status: 500, error: result.error.message };
  }
  if (result.status !== 0) {
    const errorText = (result.stderr || result.stdout || "growth review action failed").trim();
    let status = 500;
    if (errorText.includes("item-key not found")) {
      status = 404;
    } else if (
      errorText.includes("weekly review missing") ||
      errorText.includes("current action file not found") ||
      errorText.includes("weekly mismatch")
    ) {
      status = 409;
    }
    return { ok: false, status, error: errorText };
  }
  return { ok: true, snapshot: buildGrowthFoundationSnapshot(undefined, params.workspaceRoot) };
}

function buildGrowthFoundationSnapshot(
  config?: OpenClawConfig,
  workspaceRootOverride?: string,
): ControlUiGrowthFoundationSnapshot {
  const empty: ControlUiGrowthFoundationSnapshot = {
    available: false,
    projectId: null,
    workspaceProjectId: null,
    alertStatus: "missing",
    alertTransition: null,
    alertUpdatedAt: null,
    actionsStatus: "missing",
    actionsUpdatedAt: null,
    priorityNow: [],
    thisWeek: [],
    thisWeekItems: [],
    completedThisWeekItems: [],
    completedHistoryItems: [],
    notificationStatus: "clear",
    notificationCount: 0,
    notificationItems: [],
    watch: [],
    reviewCount: 0,
    completedReviewCount: 0,
    alertsPath: null,
    actionsPath: null,
    completedHistoryPath: null,
    heartbeatPath: null,
    weeklyReviewPath: null,
    codexSmokeStatus: "missing",
    codexSmokePeriod: null,
    codexSmokeJobId: null,
    codexSmokeUpdatedAt: null,
    codexSmokeStatePath: null,
    codexReviewSmokeStatus: "missing",
    codexReviewSmokePeriod: null,
    codexReviewSmokeJobId: null,
    codexReviewSmokeSourceJobId: null,
    codexReviewSmokeUpdatedAt: null,
    codexReviewSmokeStatePath: null,
    codexReviewSmokeDiffPath: null,
    codexReviewSmokeBackfillCount: 0,
    codexReviewSmokeBackfillItems: [],
    codexReviewSmokeBackfillStatePath: null,
    codexSmokeBackfillCount: 0,
    codexSmokeBackfillItems: [],
    codexSmokeBackfillStatePath: null,
    githubSyncStatus: "missing",
    githubSyncIssueCount: 0,
    githubSyncUpdatedAt: null,
    githubSyncCurrentPath: null,
    githubProjectStatus: "missing",
    githubProjectTitle: null,
    githubProjectUrl: null,
    githubProjectItemCount: 0,
    githubWritebackStatus: "missing",
    githubWritebackIssueRef: null,
    githubWritebackActions: [],
    githubWritebackCloseIssue: false,
    githubWritebackOperator: null,
    githubWritebackProposalUpdatedAt: null,
    githubWritebackReceiptAppliedAt: null,
    githubWritebackProposalPath: null,
    githubWritebackReceiptPath: null,
    issueFlowStatus: "missing",
    issueFlowStage: null,
    issueFlowIssueNumber: null,
    issueFlowIssueRef: null,
    issueFlowUpdatedAt: null,
    issueFlowDirectoryPath: null,
    issueFlowPreflightStatus: "missing",
    issueFlowDraftStatus: "missing",
    issueFlowProposalStatus: "missing",
    issueFlowEnqueueStatus: "missing",
    issueFlowOutcomeStatus: "missing",
    issueFlowPreflightPath: null,
    issueFlowDraftPath: null,
    issueFlowProposalPath: null,
    issueFlowReceiptPath: null,
    issueFlowOutcomePath: null,
    issueFlowPrimaryResultPath: null,
    issueFlowActiveCount: 0,
    issueFlowRecentCount: 0,
    issueFlowRecentItems: [],
    issueFlowArchivedCount: 0,
    issueFlowArchiveRootPath: null,
    issueFlowArchivedLatestIssueRef: null,
    issueFlowArchivedLatestArchivedAt: null,
    issueFlowArchivedLatestPath: null,
    issueFlowArchivedLatestReceiptPath: null,
    issueFlowVisibilityStatus: "missing",
    issueFlowVisibilityReason: null,
    issueFlowVisibilityOpenIssue: null,
    issueFlowVisibilityGithubSyncUpdatedAt: null,
    relayStatus: "missing",
    relayChannel: null,
    relayMode: null,
    relayCandidateCount: 0,
    relayUpdatedAt: null,
    relayCurrentPath: null,
  };

  const workspaceRoot = workspaceRootOverride ?? resolveWorkspaceRoot(config);
  if (!workspaceRoot) {
    return empty;
  }
  const projectFiles = resolveGrowthProjectFiles(workspaceRoot);
  if (!projectFiles) {
    return empty;
  }

  const actionsText = readWorkspaceTextFile(workspaceRoot, projectFiles.actionsPath);
  const alertsText = readWorkspaceTextFile(workspaceRoot, projectFiles.alertsPath);
  if (!actionsText || !alertsText) {
    return empty;
  }

  const actionsFields = parseMarkdownKeyValueList(actionsText);
  const alertsFields = parseMarkdownKeyValueList(alertsText);
  const displayProjectId = actionsFields.project?.trim() || alertsFields.project?.trim() || null;
  const normalizeProjectArtifactPath = (value: string | null | undefined) =>
    normalizeGrowthProjectArtifactPath(value, {
      displayProjectId,
      workspaceProjectId: projectFiles.projectId,
    });
  const weeklyReviewPath = normalizeProjectArtifactPath(
    alertsFields["weekly-review"] ?? actionsFields["latest-weekly"] ?? null,
  );
  const priorityNow = parseMarkdownSectionItems(actionsText, "Priority Now");
  const thisWeekItems = parseMarkdownSectionReviewItems(actionsText, "This Week");
  const watch = parseMarkdownSectionItems(actionsText, "Watch");
  const completedThisWeekItems = completedGrowthReviewItems({
    workspaceRoot,
    projectId: projectFiles.projectId,
    weeklyReviewPath,
  });
  const completedHistory = completedGrowthHistory({
    workspaceRoot,
    projectId: projectFiles.projectId,
  });
  const codexSmokeState = readGrowthAutomationPayload(
    workspaceRoot,
    projectFiles.projectId,
    "codex-patch-smoke-state.json",
  );
  const codexSmokeBackfillState = readGrowthAutomationPayload(
    workspaceRoot,
    projectFiles.projectId,
    "codex-patch-smoke-backfill-state.json",
  );
  const codexReviewSmokeState = readGrowthAutomationPayload(
    workspaceRoot,
    projectFiles.projectId,
    "codex-patch-smoke-review-state.json",
  );
  const githubSyncState = readGrowthProjectStatePayload(
    workspaceRoot,
    projectFiles.projectId,
    "github",
  );
  const githubWritebackProposalPath = resolveGrowthProjectFilePath(
    workspaceRoot,
    projectFiles.projectId,
    path.posix.join(
      "memory",
      "projects",
      projectFiles.projectId,
      "github-writeback",
      "current-proposal.json",
    ),
    ".json",
  );
  const githubWritebackProposalRaw = githubWritebackProposalPath
    ? readWorkspaceJsonFile(workspaceRoot, githubWritebackProposalPath)
    : null;
  const githubWritebackProposalPayload =
    githubWritebackProposalRaw && typeof githubWritebackProposalRaw === "object"
      ? (githubWritebackProposalRaw as Record<string, unknown>)
      : null;
  const githubWritebackReceiptPath = latestWorkspaceJsonPath(
    workspaceRoot,
    path.posix.join("memory", "projects", projectFiles.projectId, "github-writeback", "receipts"),
  );
  const githubWritebackReceiptRaw = githubWritebackReceiptPath
    ? readWorkspaceJsonFile(workspaceRoot, githubWritebackReceiptPath)
    : null;
  const githubWritebackReceiptPayload =
    githubWritebackReceiptRaw && typeof githubWritebackReceiptRaw === "object"
      ? (githubWritebackReceiptRaw as Record<string, unknown>)
      : null;
  const relayState = readGrowthProjectStatePayload(workspaceRoot, projectFiles.projectId, "relay");
  const codexReviewSmokeBackfillState = readGrowthAutomationPayload(
    workspaceRoot,
    projectFiles.projectId,
    "codex-patch-smoke-review-backfill-state.json",
  );
  const codexSmokePeriod = readRecordString(codexSmokeState.payload, "last_enqueued_period");
  const codexSmokeJobId = readRecordString(codexSmokeState.payload, "last_job_id");
  const codexSmokeUpdatedAt = readRecordString(codexSmokeState.payload, "updated_at");
  const codexReviewSmokePeriod = readRecordString(
    codexReviewSmokeState.payload,
    "last_enqueued_period",
  );
  const codexReviewSmokeJobId = readRecordString(codexReviewSmokeState.payload, "last_job_id");
  const codexReviewSmokeSourceJobId = readRecordString(
    codexReviewSmokeState.payload,
    "source_job_id",
  );
  const codexReviewSmokeUpdatedAt = readRecordString(codexReviewSmokeState.payload, "updated_at");
  const codexReviewSmokeDiffPath = normalizeProjectArtifactPath(
    readRecordString(codexReviewSmokeState.payload, "last_diff_relpath"),
  );
  const codexSmokeBackfills = parseGrowthBackfillItems(
    codexSmokeBackfillState.payload,
    (period, value, requestedAt) => ({
      period,
      jobId: readRecordString(value, "job_id"),
      requestedAt,
      reason: readRecordString(value, "reason"),
      jobPath: normalizeProjectArtifactPath(readRecordString(value, "job_path")),
      evidencePath: normalizeProjectArtifactPath(readRecordString(value, "evidence_path")),
    }),
  );
  const codexReviewSmokeBackfills = parseGrowthBackfillItems(
    codexReviewSmokeBackfillState.payload,
    (period, value, requestedAt) => ({
      period,
      jobId: readRecordString(value, "job_id"),
      requestedAt,
      reason: readRecordString(value, "reason"),
      sourceJobId: readRecordString(value, "source_job_id"),
      sourceOrigin: readRecordString(value, "source_origin"),
      diffRelpath: normalizeProjectArtifactPath(readRecordString(value, "diff_relpath")),
      jobPath: normalizeProjectArtifactPath(readRecordString(value, "job_path")),
      evidencePath: normalizeProjectArtifactPath(readRecordString(value, "evidence_path")),
    }),
  );
  const githubProjectSync =
    githubSyncState.payload?.project_sync &&
    typeof githubSyncState.payload.project_sync === "object"
      ? (githubSyncState.payload.project_sync as Record<string, unknown>)
      : null;
  const githubWriteback = summarizeGrowthWriteback({
    proposalPayload: githubWritebackProposalPayload,
    receiptPayload: githubWritebackReceiptPayload,
  });
  const issueFlowBase = buildGrowthIssueFlowSummary({
    workspaceRoot,
    projectId: projectFiles.projectId,
  });
  const issueFlow = {
    ...issueFlowBase,
    ...summarizeGrowthIssueFlowVisibility({
      issueFlow: issueFlowBase,
      githubSyncPayload:
        githubSyncState.payload && typeof githubSyncState.payload === "object"
          ? githubSyncState.payload
          : null,
      githubWriteback,
    }),
  };
  const alertsPath =
    normalizeProjectArtifactPath(actionsFields["latest-alert"] ?? null) ?? projectFiles.alertsPath;
  const notificationItems = buildGrowthNotificationItems({
    alertStatus: alertsFields.status ?? "missing",
    alertAction: alertsFields.action ?? null,
    priorityNow,
    thisWeekItems,
    watch,
    alertsPath,
    actionsPath: projectFiles.actionsPath,
    weeklyReviewPath,
  });

  return {
    available: true,
    projectId: displayProjectId ?? projectFiles.projectId,
    workspaceProjectId: projectFiles.projectId,
    alertStatus: alertsFields.status ?? "missing",
    alertTransition: alertsFields.transition ?? null,
    alertUpdatedAt: alertsFields.updated_at ?? null,
    actionsStatus: actionsFields.status ?? "missing",
    actionsUpdatedAt: actionsFields.updated_at ?? null,
    priorityNow,
    thisWeek: thisWeekItems.map((item) => item.display),
    thisWeekItems,
    completedThisWeekItems,
    completedHistoryItems: completedHistory.items,
    notificationStatus: notificationItems.length > 0 ? "attention" : "clear",
    notificationCount: notificationItems.length,
    notificationItems,
    watch,
    reviewCount: thisWeekItems.length,
    completedReviewCount: completedThisWeekItems.length,
    alertsPath,
    actionsPath: projectFiles.actionsPath,
    completedHistoryPath: completedHistory.path,
    heartbeatPath: normalizeProjectArtifactPath(alertsFields.heartbeat ?? null),
    weeklyReviewPath,
    codexSmokeStatus: codexSmokePeriod || codexSmokeJobId ? "scheduled" : "missing",
    codexSmokePeriod,
    codexSmokeJobId,
    codexSmokeUpdatedAt,
    codexSmokeStatePath: codexSmokeState.path,
    codexReviewSmokeStatus:
      codexReviewSmokePeriod || codexReviewSmokeJobId ? "scheduled" : "missing",
    codexReviewSmokePeriod,
    codexReviewSmokeJobId,
    codexReviewSmokeSourceJobId,
    codexReviewSmokeUpdatedAt,
    codexReviewSmokeStatePath: codexReviewSmokeState.path,
    codexReviewSmokeDiffPath,
    codexReviewSmokeBackfillCount: codexReviewSmokeBackfills.count,
    codexReviewSmokeBackfillItems: codexReviewSmokeBackfills.items,
    codexReviewSmokeBackfillStatePath: codexReviewSmokeBackfillState.path,
    codexSmokeBackfillCount: codexSmokeBackfills.count,
    codexSmokeBackfillItems: codexSmokeBackfills.items,
    codexSmokeBackfillStatePath: codexSmokeBackfillState.path,
    githubSyncStatus: readRecordString(githubSyncState.payload, "status") || "missing",
    githubSyncIssueCount: Number(githubSyncState.payload?.issue_count ?? 0) || 0,
    githubSyncUpdatedAt: readRecordString(githubSyncState.payload, "updated_at"),
    githubSyncCurrentPath: resolveGrowthLaneMarkdownPath(
      workspaceRoot,
      projectFiles.projectId,
      "github",
      "current.md",
    ),
    githubProjectStatus: readRecordString(githubProjectSync, "status") || "missing",
    githubProjectTitle: readRecordString(githubProjectSync, "title"),
    githubProjectUrl: readRecordString(githubProjectSync, "url"),
    githubProjectItemCount: Array.isArray(githubProjectSync?.items)
      ? githubProjectSync.items.length
      : 0,
    githubWritebackStatus: githubWriteback.status,
    githubWritebackIssueRef: githubWriteback.issueRef,
    githubWritebackActions: githubWriteback.actions,
    githubWritebackCloseIssue: githubWriteback.closeIssue,
    githubWritebackOperator: githubWriteback.operator,
    githubWritebackProposalUpdatedAt: githubWriteback.proposalUpdatedAt,
    githubWritebackReceiptAppliedAt: githubWriteback.receiptAppliedAt,
    githubWritebackProposalPath,
    githubWritebackReceiptPath,
    issueFlowStatus: issueFlow.issueFlowStatus,
    issueFlowStage: issueFlow.issueFlowStage,
    issueFlowIssueNumber: issueFlow.issueFlowIssueNumber,
    issueFlowIssueRef: issueFlow.issueFlowIssueRef,
    issueFlowUpdatedAt: issueFlow.issueFlowUpdatedAt,
    issueFlowDirectoryPath: issueFlow.issueFlowDirectoryPath,
    issueFlowPreflightStatus: issueFlow.issueFlowPreflightStatus,
    issueFlowDraftStatus: issueFlow.issueFlowDraftStatus,
    issueFlowProposalStatus: issueFlow.issueFlowProposalStatus,
    issueFlowEnqueueStatus: issueFlow.issueFlowEnqueueStatus,
    issueFlowOutcomeStatus: issueFlow.issueFlowOutcomeStatus,
    issueFlowPreflightPath: issueFlow.issueFlowPreflightPath,
    issueFlowDraftPath: issueFlow.issueFlowDraftPath,
    issueFlowProposalPath: issueFlow.issueFlowProposalPath,
    issueFlowReceiptPath: issueFlow.issueFlowReceiptPath,
    issueFlowOutcomePath: issueFlow.issueFlowOutcomePath,
    issueFlowPrimaryResultPath: issueFlow.issueFlowPrimaryResultPath,
    issueFlowActiveCount: issueFlow.issueFlowActiveCount,
    issueFlowRecentCount: issueFlow.issueFlowRecentCount,
    issueFlowRecentItems: issueFlow.issueFlowRecentItems,
    issueFlowArchivedCount: issueFlow.issueFlowArchivedCount,
    issueFlowArchiveRootPath: issueFlow.issueFlowArchiveRootPath,
    issueFlowArchivedLatestIssueRef: issueFlow.issueFlowArchivedLatestIssueRef,
    issueFlowArchivedLatestArchivedAt: issueFlow.issueFlowArchivedLatestArchivedAt,
    issueFlowArchivedLatestPath: issueFlow.issueFlowArchivedLatestPath,
    issueFlowArchivedLatestReceiptPath: issueFlow.issueFlowArchivedLatestReceiptPath,
    issueFlowVisibilityStatus: issueFlow.issueFlowVisibilityStatus,
    issueFlowVisibilityReason: issueFlow.issueFlowVisibilityReason,
    issueFlowVisibilityOpenIssue: issueFlow.issueFlowVisibilityOpenIssue,
    issueFlowVisibilityGithubSyncUpdatedAt: issueFlow.issueFlowVisibilityGithubSyncUpdatedAt,
    relayStatus: readRecordString(relayState.payload, "status") || "missing",
    relayChannel: readRecordString(relayState.payload, "channel"),
    relayMode: readRecordString(relayState.payload, "mode"),
    relayCandidateCount: Number(relayState.payload?.candidate_count ?? 0) || 0,
    relayUpdatedAt: readRecordString(relayState.payload, "updated_at"),
    relayCurrentPath: resolveGrowthLaneMarkdownPath(
      workspaceRoot,
      projectFiles.projectId,
      "relay",
      "current.md",
    ),
  };
}

function readControlUiJsonBody(
  req: IncomingMessage,
  maxBytes: number,
  onDone: (err: string | null, payload: Record<string, unknown> | null) => void,
) {
  req.setEncoding("utf8");
  let size = 0;
  let body = "";
  req.on("data", (chunk: string) => {
    size += Buffer.byteLength(chunk, "utf8");
    if (size > maxBytes) {
      return;
    }
    body += chunk;
  });
  req.on("end", () => {
    if (size > maxBytes) {
      onDone("request body too large", null);
      return;
    }
    try {
      onDone(null, JSON.parse(body || "{}") as Record<string, unknown>);
    } catch {
      onDone("invalid json", null);
    }
  });
  req.on("error", () => {
    onDone("request body read failed", null);
  });
}

function handleGrowthReviewActionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  params: {
    pathname: string;
    basePath: string;
    config?: OpenClawConfig;
  },
): boolean {
  const actionPath = params.basePath
    ? `${params.basePath}${CONTROL_UI_GROWTH_REVIEW_ACTION_PATH}`
    : CONTROL_UI_GROWTH_REVIEW_ACTION_PATH;
  if (params.pathname !== actionPath) {
    return false;
  }
  applyControlUiSecurityHeaders(res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    respondPlainText(res, 405, "Method Not Allowed");
    return true;
  }

  readControlUiJsonBody(req, CONTROL_UI_GROWTH_ACTION_MAX_BYTES, (err, payload) => {
    if (res.writableEnded) {
      return;
    }
    if (err) {
      sendJson(res, err === "request body too large" ? 413 : 400, {
        success: false,
        action: "complete",
        itemKey: "",
        snapshot: null,
        error: err,
      } satisfies ControlUiGrowthReviewActionResponse);
      return;
    }

    const payloadRecord = readRecord(payload);
    const action = (readRecordString(payloadRecord, "action") ?? "") as ControlUiGrowthReviewAction;
    const itemKey = readRecordString(payloadRecord, "itemKey") ?? "";
    const projectId = readRecordString(payloadRecord, "projectId") ?? "";
    if (action !== "complete" && action !== "reopen") {
      sendJson(res, 400, {
        success: false,
        action: "complete",
        itemKey,
        snapshot: null,
        error: "invalid action",
      } satisfies ControlUiGrowthReviewActionResponse);
      return;
    }
    if (!itemKey) {
      sendJson(res, 400, {
        success: false,
        action,
        itemKey,
        snapshot: null,
        error: "itemKey is required",
      } satisfies ControlUiGrowthReviewActionResponse);
      return;
    }

    const workspaceRoot = resolveWorkspaceRoot(params.config);
    if (!workspaceRoot) {
      sendJson(res, 409, {
        success: false,
        action,
        itemKey,
        snapshot: null,
        error: "workspace root missing",
      } satisfies ControlUiGrowthReviewActionResponse);
      return;
    }
    const snapshot = buildGrowthFoundationSnapshot(params.config, workspaceRoot);
    const workspaceProjectId = snapshot.workspaceProjectId ?? snapshot.projectId;
    if (!snapshot.available || !workspaceProjectId) {
      sendJson(res, 409, {
        success: false,
        action,
        itemKey,
        snapshot: null,
        error: "growth foundation snapshot unavailable",
      } satisfies ControlUiGrowthReviewActionResponse);
      return;
    }
    if (projectId && projectId !== workspaceProjectId) {
      sendJson(res, 400, {
        success: false,
        action,
        itemKey,
        snapshot,
        error: `project mismatch: ${projectId}`,
      } satisfies ControlUiGrowthReviewActionResponse);
      return;
    }

    const result = runGrowthReviewAction({
      workspaceRoot,
      projectId: workspaceProjectId,
      itemKey,
      action,
    });
    if (!result.ok) {
      sendJson(res, result.status, {
        success: false,
        action,
        itemKey,
        snapshot,
        error: result.error,
      } satisfies ControlUiGrowthReviewActionResponse);
      return;
    }
    sendJson(res, 200, {
      success: true,
      action,
      itemKey,
      snapshot: result.snapshot,
    } satisfies ControlUiGrowthReviewActionResponse);
  });
  return true;
}

function handleGrowthFileRequest(
  req: IncomingMessage,
  res: ServerResponse,
  params: {
    pathname: string;
    basePath: string;
    searchParams: URLSearchParams;
    config?: OpenClawConfig;
  },
): boolean {
  const filePath = params.basePath
    ? `${params.basePath}${CONTROL_UI_GROWTH_FILE_PATH}`
    : CONTROL_UI_GROWTH_FILE_PATH;
  if (params.pathname !== filePath) {
    return false;
  }
  applyControlUiSecurityHeaders(res);
  if (!isReadHttpMethod(req.method)) {
    res.setHeader("Allow", "GET, HEAD");
    respondPlainText(res, 405, "Method Not Allowed");
    return true;
  }
  const workspaceRoot = resolveWorkspaceRoot(params.config);
  const relPath = params.searchParams.get("path")?.trim() ?? "";
  if (!workspaceRoot || !relPath) {
    respondControlUiNotFound(res);
    return true;
  }
  const snapshot = buildGrowthFoundationSnapshot(params.config, workspaceRoot);
  const workspaceProjectId = snapshot.workspaceProjectId ?? snapshot.projectId;
  if (!snapshot.available || !workspaceProjectId) {
    respondControlUiNotFound(res);
    return true;
  }
  const normalizedRelPath = path.posix.normalize(relPath);
  const readablePaths = collectGrowthReadableFilePaths(snapshot);
  const safeRelPath =
    readablePaths.has(normalizedRelPath) &&
    isReadableGrowthArtifactPath(workspaceProjectId, normalizedRelPath)
      ? normalizedRelPath
      : null;
  const text = safeRelPath
    ? readWorkspaceTextFile(workspaceRoot, safeRelPath, CONTROL_UI_GROWTH_FILE_MAX_BYTES)
    : null;
  if (!safeRelPath || text == null) {
    respondControlUiNotFound(res);
    return true;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypeForExt(path.posix.extname(safeRelPath).toLowerCase()));
  res.setHeader("Cache-Control", "no-cache");
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  res.end(text);
  return true;
}

export function handleControlUiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: ControlUiRequestOptions,
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts?.basePath);
  const pathname = url.pathname;
  if (
    handleGrowthFileRequest(req, res, {
      pathname,
      basePath,
      searchParams: url.searchParams,
      config: opts?.config,
    })
  ) {
    return true;
  }
  if (handleGrowthReviewActionRequest(req, res, { pathname, basePath, config: opts?.config })) {
    return true;
  }
  const route = classifyControlUiRequest({
    basePath,
    pathname,
    search: url.search,
    method: req.method,
  });
  if (route.kind === "not-control-ui") {
    return false;
  }
  if (route.kind === "not-found") {
    applyControlUiSecurityHeaders(res);
    respondControlUiNotFound(res);
    return true;
  }
  if (route.kind === "redirect") {
    applyControlUiSecurityHeaders(res);
    res.statusCode = 302;
    res.setHeader("Location", route.location);
    res.end();
    return true;
  }

  applyControlUiSecurityHeaders(res);

  const bootstrapConfigPath = basePath
    ? `${basePath}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`
    : CONTROL_UI_BOOTSTRAP_CONFIG_PATH;
  const growthFoundationPath = basePath
    ? `${basePath}${CONTROL_UI_GROWTH_FOUNDATION_PATH}`
    : CONTROL_UI_GROWTH_FOUNDATION_PATH;
  if (pathname === bootstrapConfigPath) {
    const config = opts?.config;
    const identity = config
      ? resolveAssistantIdentity({ cfg: config, agentId: opts?.agentId })
      : DEFAULT_ASSISTANT_IDENTITY;
    const avatarValue = resolveAssistantAvatarUrl({
      avatar: identity.avatar,
      agentId: identity.agentId,
      basePath,
    });
    if (req.method === "HEAD") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.end();
      return true;
    }
    sendJson(res, 200, {
      basePath,
      assistantName: identity.name,
      assistantAvatar: avatarValue ?? identity.avatar,
      assistantAgentId: identity.agentId,
      serverVersion: resolveRuntimeServiceVersion(process.env),
    } satisfies ControlUiBootstrapConfig);
    return true;
  }
  if (pathname === growthFoundationPath) {
    if (req.method === "HEAD") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.end();
      return true;
    }
    sendJson(res, 200, buildGrowthFoundationSnapshot(opts?.config));
    return true;
  }

  const rootState = opts?.root;
  if (rootState?.kind === "invalid") {
    respondControlUiAssetsUnavailable(res, { configuredRootPath: rootState.path });
    return true;
  }
  if (rootState?.kind === "missing") {
    respondControlUiAssetsUnavailable(res);
    return true;
  }

  const root =
    rootState?.kind === "resolved" || rootState?.kind === "bundled"
      ? rootState.path
      : resolveControlUiRootSync({
          moduleUrl: import.meta.url,
          argv1: process.argv[1],
          cwd: process.cwd(),
        });
  if (!root) {
    respondControlUiAssetsUnavailable(res);
    return true;
  }

  const rootReal = (() => {
    try {
      return fs.realpathSync(root);
    } catch (error) {
      if (isExpectedSafePathError(error)) {
        return null;
      }
      throw error;
    }
  })();
  if (!rootReal) {
    respondControlUiAssetsUnavailable(res);
    return true;
  }

  const uiPath =
    basePath && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
  const rel = (() => {
    if (uiPath === ROOT_PREFIX) {
      return "";
    }
    const assetsIndex = uiPath.indexOf("/assets/");
    if (assetsIndex >= 0) {
      return uiPath.slice(assetsIndex + 1);
    }
    return uiPath.slice(1);
  })();
  const requested = rel && !rel.endsWith("/") ? rel : `${rel}index.html`;
  const fileRel = requested || "index.html";
  if (!isSafeRelativePath(fileRel)) {
    respondControlUiNotFound(res);
    return true;
  }

  const filePath = path.resolve(root, fileRel);
  if (!isWithinDir(root, filePath)) {
    respondControlUiNotFound(res);
    return true;
  }

  const isBundledRoot =
    rootState?.kind === "bundled" ||
    (rootState === undefined &&
      isPackageProvenControlUiRootSync(root, {
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
        cwd: process.cwd(),
      }));
  const rejectHardlinks = !isBundledRoot;
  const safeFile = resolveSafeControlUiFile(rootReal, filePath, rejectHardlinks);
  if (safeFile) {
    try {
      if (respondHeadForFile(req, res, safeFile.path)) {
        return true;
      }
      if (path.basename(safeFile.path) === "index.html") {
        serveResolvedIndexHtml(res, fs.readFileSync(safeFile.fd, "utf8"));
        return true;
      }
      serveResolvedFile(res, safeFile.path, fs.readFileSync(safeFile.fd));
      return true;
    } finally {
      fs.closeSync(safeFile.fd);
    }
  }

  // If the requested path looks like a static asset (known extension), return
  // 404 rather than falling through to the SPA index.html fallback.  We check
  // against the same set of extensions that contentTypeForExt() recognises so
  // that dotted SPA routes (e.g. /user/jane.doe, /v2.0) still get the
  // client-side router fallback.
  if (STATIC_ASSET_EXTENSIONS.has(path.extname(fileRel).toLowerCase())) {
    respondControlUiNotFound(res);
    return true;
  }

  // SPA fallback (client-side router): serve index.html for unknown paths.
  const indexPath = path.join(root, "index.html");
  const safeIndex = resolveSafeControlUiFile(rootReal, indexPath, rejectHardlinks);
  if (safeIndex) {
    try {
      if (respondHeadForFile(req, res, safeIndex.path)) {
        return true;
      }
      serveResolvedIndexHtml(res, fs.readFileSync(safeIndex.fd, "utf8"));
      return true;
    } finally {
      fs.closeSync(safeIndex.fd);
    }
  }

  respondControlUiNotFound(res);
  return true;
}
