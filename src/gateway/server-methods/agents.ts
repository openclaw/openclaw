import fs from "node:fs/promises";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../../agents/memory-search.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
  isWorkspaceOnboardingCompleted,
} from "../../agents/workspace.js";
import { movePathToTrash } from "../../browser/trash.js";
import {
  applyAgentConfig,
  findAgentEntryIndex,
  listAgentEntries,
  pruneAgentConfig,
} from "../../commands/agents.config.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import {
  resolveSessionTranscriptsDirForAgent,
  resolveStorePath,
} from "../../config/sessions/paths.js";
import { loadSessionStore, saveSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { CronJob, CronJobCreate } from "../../cron/types.js";
import { sameFileIdentity } from "../../infra/file-identity.js";
import { SafeOpenError, readLocalFileSafely, writeFileWithinRoot } from "../../infra/fs-safe.js";
import { assertNoPathAliasEscape } from "../../infra/path-alias-guards.js";
import { isNotFoundPathError } from "../../infra/path-guards.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentsCloneParams,
  validateAgentsCreateParams,
  validateAgentsDeleteParams,
  validateAgentsFilesGetParams,
  validateAgentsFilesListParams,
  validateAgentsFilesSetParams,
  validateAgentsListParams,
  validateAgentsUpdateParams,
} from "../protocol/index.js";
import { listAgentsForGateway } from "../session-utils.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";

const BOOTSTRAP_FILE_NAMES = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
] as const;
const BOOTSTRAP_FILE_NAMES_POST_ONBOARDING = BOOTSTRAP_FILE_NAMES.filter(
  (name) => name !== DEFAULT_BOOTSTRAP_FILENAME,
);

const MEMORY_FILE_NAMES = [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME] as const;

const ALLOWED_FILE_NAMES = new Set<string>([
  ...BOOTSTRAP_FILE_NAMES,
  ...MEMORY_FILE_NAMES,
  "company-config.json",
]);

function resolveAgentWorkspaceFileOrRespondError(
  params: Record<string, unknown>,
  respond: RespondFn,
): {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  workspaceDir: string;
  name: string;
} | null {
  const cfg = loadConfig();
  const rawAgentId = params.agentId;
  const agentId = resolveAgentIdOrError(
    typeof rawAgentId === "string" || typeof rawAgentId === "number" ? String(rawAgentId) : "",
    cfg,
  );
  if (!agentId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
    return null;
  }
  const rawName = params.name;
  const name = (
    typeof rawName === "string" || typeof rawName === "number" ? String(rawName) : ""
  ).trim();

  const isSafeExtension = /^[a-zA-Z0-9_\-.]+\.(txt|md|json|js|ts|csv|yaml|yml|log)$/i.test(name);
  if (!ALLOWED_FILE_NAMES.has(name) && !isSafeExtension) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unsupported file "${name}"`));
    return null;
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  return { cfg, agentId, workspaceDir, name };
}

type FileMeta = {
  size: number;
  updatedAtMs: number;
};

type ResolvedAgentWorkspaceFilePath =
  | {
      kind: "ready";
      requestPath: string;
      ioPath: string;
      workspaceReal: string;
    }
  | {
      kind: "missing";
      requestPath: string;
      ioPath: string;
      workspaceReal: string;
    }
  | {
      kind: "invalid";
      requestPath: string;
      reason: string;
    };

type ResolvedWorkspaceFilePath = Exclude<ResolvedAgentWorkspaceFilePath, { kind: "invalid" }>;

function resolveNotFoundWorkspaceFilePathResult(params: {
  error: unknown;
  allowMissing: boolean;
  requestPath: string;
  ioPath: string;
  workspaceReal: string;
}): Extract<ResolvedAgentWorkspaceFilePath, { kind: "missing" | "invalid" }> | undefined {
  if (!isNotFoundPathError(params.error)) {
    return undefined;
  }
  if (params.allowMissing) {
    return {
      kind: "missing",
      requestPath: params.requestPath,
      ioPath: params.ioPath,
      workspaceReal: params.workspaceReal,
    };
  }
  return { kind: "invalid", requestPath: params.requestPath, reason: "file not found" };
}

function resolveWorkspaceFilePathResultOrThrow(params: {
  error: unknown;
  allowMissing: boolean;
  requestPath: string;
  ioPath: string;
  workspaceReal: string;
}): Extract<ResolvedAgentWorkspaceFilePath, { kind: "missing" | "invalid" }> {
  const notFoundResult = resolveNotFoundWorkspaceFilePathResult(params);
  if (notFoundResult) {
    return notFoundResult;
  }
  throw params.error;
}

async function resolveWorkspaceRealPath(workspaceDir: string): Promise<string> {
  try {
    return await fs.realpath(workspaceDir);
  } catch {
    return path.resolve(workspaceDir);
  }
}

async function resolveAgentWorkspaceFilePath(params: {
  workspaceDir: string;
  name: string;
  allowMissing: boolean;
}): Promise<ResolvedAgentWorkspaceFilePath> {
  const requestPath = path.join(params.workspaceDir, params.name);
  const workspaceReal = await resolveWorkspaceRealPath(params.workspaceDir);
  const candidatePath = path.resolve(workspaceReal, params.name);

  try {
    await assertNoPathAliasEscape({
      absolutePath: candidatePath,
      rootPath: workspaceReal,
      boundaryLabel: "workspace root",
    });
  } catch (error) {
    return {
      kind: "invalid",
      requestPath,
      reason: error instanceof Error ? error.message : "path escapes workspace root",
    };
  }

  const notFoundContext = {
    allowMissing: params.allowMissing,
    requestPath,
    workspaceReal,
  } as const;

  let candidateLstat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    candidateLstat = await fs.lstat(candidatePath);
  } catch (err) {
    return resolveWorkspaceFilePathResultOrThrow({
      error: err,
      ...notFoundContext,
      ioPath: candidatePath,
    });
  }

  if (candidateLstat.isSymbolicLink()) {
    let targetReal: string;
    try {
      targetReal = await fs.realpath(candidatePath);
    } catch (err) {
      return resolveWorkspaceFilePathResultOrThrow({
        error: err,
        ...notFoundContext,
        ioPath: candidatePath,
      });
    }
    let targetStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      targetStat = await fs.stat(targetReal);
    } catch (err) {
      return resolveWorkspaceFilePathResultOrThrow({
        error: err,
        ...notFoundContext,
        ioPath: targetReal,
      });
    }
    if (!targetStat.isFile()) {
      return { kind: "invalid", requestPath, reason: "path is not a regular file" };
    }
    if (targetStat.nlink > 1) {
      return { kind: "invalid", requestPath, reason: "hardlinked file path not allowed" };
    }
    return { kind: "ready", requestPath, ioPath: targetReal, workspaceReal };
  }

  if (!candidateLstat.isFile()) {
    return { kind: "invalid", requestPath, reason: "path is not a regular file" };
  }
  if (candidateLstat.nlink > 1) {
    return { kind: "invalid", requestPath, reason: "hardlinked file path not allowed" };
  }

  const targetReal = await fs.realpath(candidatePath).catch(() => candidatePath);
  return { kind: "ready", requestPath, ioPath: targetReal, workspaceReal };
}

async function statFileSafely(filePath: string): Promise<FileMeta | null> {
  try {
    const [stat, lstat] = await Promise.all([fs.stat(filePath), fs.lstat(filePath)]);
    if (lstat.isSymbolicLink() || !stat.isFile()) {
      return null;
    }
    if (stat.nlink > 1) {
      return null;
    }
    if (!sameFileIdentity(stat, lstat)) {
      return null;
    }
    return {
      size: stat.size,
      updatedAtMs: Math.floor(stat.mtimeMs),
    };
  } catch {
    return null;
  }
}

async function listAgentFiles(workspaceDir: string, options?: { hideBootstrap?: boolean }) {
  const files: Array<{
    name: string;
    path: string;
    missing: boolean;
    size?: number;
    updatedAtMs?: number;
  }> = [];

  const bootstrapFileNames = options?.hideBootstrap
    ? BOOTSTRAP_FILE_NAMES_POST_ONBOARDING
    : BOOTSTRAP_FILE_NAMES;
  for (const name of bootstrapFileNames) {
    const resolved = await resolveAgentWorkspaceFilePath({
      workspaceDir,
      name,
      allowMissing: true,
    });
    const filePath = resolved.requestPath;
    const meta =
      resolved.kind === "ready"
        ? await statFileSafely(resolved.ioPath)
        : resolved.kind === "missing"
          ? null
          : null;
    if (meta) {
      files.push({
        name,
        path: filePath,
        missing: false,
        size: meta.size,
        updatedAtMs: meta.updatedAtMs,
      });
    } else {
      files.push({ name, path: filePath, missing: true });
    }
  }

  const primaryResolved = await resolveAgentWorkspaceFilePath({
    workspaceDir,
    name: DEFAULT_MEMORY_FILENAME,
    allowMissing: true,
  });
  const primaryMeta =
    primaryResolved.kind === "ready" ? await statFileSafely(primaryResolved.ioPath) : null;
  if (primaryMeta) {
    files.push({
      name: DEFAULT_MEMORY_FILENAME,
      path: primaryResolved.requestPath,
      missing: false,
      size: primaryMeta.size,
      updatedAtMs: primaryMeta.updatedAtMs,
    });
  } else {
    const altMemoryResolved = await resolveAgentWorkspaceFilePath({
      workspaceDir,
      name: DEFAULT_MEMORY_ALT_FILENAME,
      allowMissing: true,
    });
    const altMeta =
      altMemoryResolved.kind === "ready" ? await statFileSafely(altMemoryResolved.ioPath) : null;
    if (altMeta) {
      files.push({
        name: DEFAULT_MEMORY_ALT_FILENAME,
        path: altMemoryResolved.requestPath,
        missing: false,
        size: altMeta.size,
        updatedAtMs: altMeta.updatedAtMs,
      });
    } else {
      files.push({
        name: DEFAULT_MEMORY_FILENAME,
        path: primaryResolved.requestPath,
        missing: true,
      });
    }
  }

  return files;
}

function resolveAgentIdOrError(agentIdRaw: string, cfg: ReturnType<typeof loadConfig>) {
  const agentId = normalizeAgentId(agentIdRaw);
  const allowed = new Set(listAgentIds(cfg));
  if (!allowed.has(agentId)) {
    return null;
  }
  return agentId;
}

function sanitizeIdentityLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function resolveOptionalStringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function respondInvalidMethodParams(
  respond: RespondFn,
  method: string,
  errors: Parameters<typeof formatValidationErrors>[0],
): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(errors)}`,
    ),
  );
}

function isConfiguredAgent(cfg: ReturnType<typeof loadConfig>, agentId: string): boolean {
  return findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0;
}

function respondAgentNotFound(respond: RespondFn, agentId: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`));
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await fs.access(pathname);
    return true;
  } catch {
    return false;
  }
}

function sameResolvedPath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function resolveUniqueCloneName(baseName: string, existingNames: Set<string>): string {
  const base = sanitizeIdentityLine(baseName) || "Agent Copy";
  if (!existingNames.has(base.toLowerCase())) {
    return base;
  }
  for (let idx = 2; idx < 5000; idx += 1) {
    const candidate = `${base} ${idx}`;
    if (!existingNames.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return `${base} ${Date.now()}`;
}

function resolveUniqueCloneAgentId(params: {
  baseName: string;
  sourceAgentId: string;
  existingIds: Set<string>;
}): string {
  const baseFromName = normalizeAgentId(params.baseName);
  const preferred =
    baseFromName && baseFromName !== DEFAULT_AGENT_ID
      ? baseFromName
      : normalizeAgentId(`${params.sourceAgentId}-copy`);
  if (!params.existingIds.has(preferred) && preferred !== DEFAULT_AGENT_ID) {
    return preferred;
  }
  const root = normalizeAgentId(`${params.sourceAgentId}-copy`);
  if (!params.existingIds.has(root) && root !== DEFAULT_AGENT_ID) {
    return root;
  }
  for (let idx = 2; idx < 5000; idx += 1) {
    const candidate = normalizeAgentId(`${root}-${idx}`);
    if (!params.existingIds.has(candidate) && candidate !== DEFAULT_AGENT_ID) {
      return candidate;
    }
  }
  return normalizeAgentId(`${root}-${Date.now()}`);
}

async function resolveUniqueClonePath(basePath: string, takenPaths: Set<string>): Promise<string> {
  const baseResolved = path.resolve(basePath);
  if (!takenPaths.has(baseResolved) && !(await pathExists(baseResolved))) {
    takenPaths.add(baseResolved);
    return baseResolved;
  }
  for (let idx = 2; idx < 5000; idx += 1) {
    const candidate = `${baseResolved}-${idx}`;
    const resolved = path.resolve(candidate);
    if (takenPaths.has(resolved)) {
      continue;
    }
    if (await pathExists(resolved)) {
      continue;
    }
    takenPaths.add(resolved);
    return resolved;
  }
  const fallback = `${baseResolved}-${Date.now()}`;
  const resolvedFallback = path.resolve(fallback);
  takenPaths.add(resolvedFallback);
  return resolvedFallback;
}

async function copyDirectoryIfExists(sourceDir: string, targetDir: string): Promise<boolean> {
  if (!(await pathExists(sourceDir))) {
    return false;
  }
  if (await pathExists(targetDir)) {
    throw new Error(`target already exists: ${targetDir}`);
  }
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(sourceDir, targetDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
  });
  return true;
}

async function copyFileIfExists(sourceFile: string, targetFile: string): Promise<boolean> {
  if (!(await pathExists(sourceFile))) {
    return false;
  }
  if (await pathExists(targetFile)) {
    throw new Error(`target already exists: ${targetFile}`);
  }
  await fs.mkdir(path.dirname(targetFile), { recursive: true });
  await fs.copyFile(sourceFile, targetFile);
  return true;
}

function rewriteSessionKeyForClone(sessionKey: string | undefined, targetAgentId: string): string {
  const raw = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (!raw) {
    return toAgentStoreSessionKey({ agentId: targetAgentId, requestKey: "main" });
  }
  const parsed = parseAgentSessionKey(raw);
  const requestKey = parsed?.rest?.trim() || raw;
  return toAgentStoreSessionKey({ agentId: targetAgentId, requestKey });
}

function mergeSessionEntriesByRecency(
  existing: SessionEntry | undefined,
  candidate: SessionEntry,
): SessionEntry {
  if (!existing) {
    return candidate;
  }
  return (candidate.updatedAt ?? 0) >= (existing.updatedAt ?? 0) ? candidate : existing;
}

async function rewriteClonedSessionStore(params: {
  targetStorePath: string;
  targetAgentId: string;
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
  targetSessionsDir: string;
}): Promise<number> {
  const store = loadSessionStore(params.targetStorePath, { skipCache: true });
  if (Object.keys(store).length === 0) {
    return 0;
  }

  const rewritten: Record<string, SessionEntry> = {};
  let changedEntries = 0;

  for (const [sessionKey, entry] of Object.entries(store)) {
    const nextKey = rewriteSessionKeyForClone(sessionKey, params.targetAgentId);
    const rawSessionFile = typeof entry.sessionFile === "string" ? entry.sessionFile.trim() : "";
    const nextSessionFile = rawSessionFile
      ? path.join(params.targetSessionsDir, path.basename(rawSessionFile))
      : undefined;
    const nextReport = entry.systemPromptReport
      ? {
          ...entry.systemPromptReport,
          sessionKey: rewriteSessionKeyForClone(
            entry.systemPromptReport.sessionKey,
            params.targetAgentId,
          ),
          workspaceDir:
            entry.systemPromptReport.workspaceDir === params.sourceWorkspaceDir
              ? params.targetWorkspaceDir
              : entry.systemPromptReport.workspaceDir,
        }
      : undefined;
    const nextEntry: SessionEntry = {
      ...entry,
      ...(nextSessionFile ? { sessionFile: nextSessionFile } : {}),
      ...(nextReport ? { systemPromptReport: nextReport } : {}),
    };

    if (
      nextKey !== sessionKey ||
      nextEntry.sessionFile !== entry.sessionFile ||
      nextEntry.systemPromptReport?.sessionKey !== entry.systemPromptReport?.sessionKey ||
      nextEntry.systemPromptReport?.workspaceDir !== entry.systemPromptReport?.workspaceDir
    ) {
      changedEntries += 1;
    }

    rewritten[nextKey] = mergeSessionEntriesByRecency(rewritten[nextKey], nextEntry);
  }

  if (changedEntries > 0) {
    await saveSessionStore(params.targetStorePath, rewritten);
  }
  return changedEntries;
}

function normalizeCronFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeCronFingerprintValue(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, normalizeCronFingerprintValue(entryValue)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

function buildClonedCronJobInput(job: CronJob, targetAgentId: string): CronJobCreate {
  return {
    agentId: targetAgentId,
    sessionKey: rewriteSessionKeyForClone(job.sessionKey, targetAgentId),
    name: job.name,
    description: job.description,
    enabled: job.enabled,
    deleteAfterRun: job.deleteAfterRun,
    schedule: structuredClone(job.schedule),
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload: structuredClone(job.payload),
    ...(job.delivery ? { delivery: structuredClone(job.delivery) } : {}),
  };
}

function fingerprintClonedCronJob(input: CronJobCreate): string {
  const canonical = normalizeCronFingerprintValue({
    agentId: normalizeAgentId(input.agentId ?? DEFAULT_AGENT_ID),
    sessionKey: input.sessionKey,
    name: input.name,
    description: input.description ?? null,
    enabled: input.enabled,
    deleteAfterRun: input.deleteAfterRun === true,
    schedule: input.schedule,
    sessionTarget: input.sessionTarget,
    wakeMode: input.wakeMode,
    payload: input.payload,
    delivery: input.delivery ?? null,
  });
  return JSON.stringify(canonical);
}

async function cloneAgentCronJobs(params: {
  context: GatewayRequestContext;
  sourceAgentId: string;
  targetAgentId: string;
}): Promise<{ cloned: number; skippedDuplicates: number }> {
  const jobs = await params.context.cron.list({ includeDisabled: true });
  const sourceJobs = jobs.filter(
    (job) => normalizeAgentId(job.agentId ?? DEFAULT_AGENT_ID) === params.sourceAgentId,
  );
  const existingTargetFingerprints = new Set(
    jobs
      .filter((job) => normalizeAgentId(job.agentId ?? DEFAULT_AGENT_ID) === params.targetAgentId)
      .map((job) => fingerprintClonedCronJob(buildClonedCronJobInput(job, params.targetAgentId))),
  );
  let cloned = 0;
  let skippedDuplicates = 0;
  for (const job of sourceJobs) {
    const clonedInput = buildClonedCronJobInput(job, params.targetAgentId);
    const fingerprint = fingerprintClonedCronJob(clonedInput);
    if (existingTargetFingerprints.has(fingerprint)) {
      skippedDuplicates += 1;
      continue;
    }
    await params.context.cron.add(clonedInput);
    existingTargetFingerprints.add(fingerprint);
    cloned += 1;
  }
  return { cloned, skippedDuplicates };
}

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const rootResolved = path.resolve(rootPath);
  const candidateResolved = path.resolve(candidatePath);
  const relative = path.relative(rootResolved, candidateResolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function removeAgentSessionsFromStore(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  sessionsDir: string;
}): Promise<number> {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  let removed = 0;
  const nextStore: Record<string, SessionEntry> = {};
  for (const [key, entry] of Object.entries(store)) {
    const parsed = parseAgentSessionKey(key);
    const keyAgentId = parsed?.agentId ? normalizeAgentId(parsed.agentId) : "";
    const sessionFile = typeof entry?.sessionFile === "string" ? entry.sessionFile.trim() : "";
    const belongsToAgentByKey = keyAgentId === params.agentId;
    const belongsToAgentByFile = sessionFile
      ? isPathInsideRoot(params.sessionsDir, sessionFile)
      : false;
    if (belongsToAgentByKey || belongsToAgentByFile) {
      removed += 1;
      continue;
    }
    nextStore[key] = entry;
  }
  if (removed > 0) {
    await saveSessionStore(storePath, nextStore);
  }
  return removed;
}

async function removeAgentCronJobs(params: {
  context: GatewayRequestContext;
  agentId: string;
}): Promise<number> {
  const jobs = await params.context.cron.list({ includeDisabled: true });
  let removed = 0;
  for (const job of jobs) {
    if (normalizeAgentId(job.agentId ?? DEFAULT_AGENT_ID) !== params.agentId) {
      continue;
    }
    const result = await params.context.cron.remove(job.id);
    if (result.removed) {
      removed += 1;
    }
  }
  return removed;
}

async function moveToTrashBestEffort(pathname: string): Promise<void> {
  if (!pathname) {
    return;
  }
  try {
    await fs.access(pathname);
  } catch {
    return;
  }
  try {
    await movePathToTrash(pathname);
  } catch {
    // Best-effort: path may already be gone or trash unavailable.
  }
}

function respondWorkspaceFileInvalid(respond: RespondFn, name: string, reason: string): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `unsafe workspace file "${name}" (${reason})`),
  );
}

async function resolveWorkspaceFilePathOrRespond(params: {
  respond: RespondFn;
  workspaceDir: string;
  name: string;
}): Promise<ResolvedWorkspaceFilePath | undefined> {
  const resolvedPath = await resolveAgentWorkspaceFilePath({
    workspaceDir: params.workspaceDir,
    name: params.name,
    allowMissing: true,
  });
  if (resolvedPath.kind === "invalid") {
    respondWorkspaceFileInvalid(params.respond, params.name, resolvedPath.reason);
    return undefined;
  }
  return resolvedPath;
}

function respondWorkspaceFileUnsafe(respond: RespondFn, name: string): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `unsafe workspace file "${name}"`),
  );
}

function respondWorkspaceFileMissing(params: {
  respond: RespondFn;
  agentId: string;
  workspaceDir: string;
  name: string;
  filePath: string;
}): void {
  params.respond(
    true,
    {
      agentId: params.agentId,
      workspace: params.workspaceDir,
      file: { name: params.name, path: params.filePath, missing: true },
    },
    undefined,
  );
}

export const agentsHandlers: GatewayRequestHandlers = {
  "agents.list": ({ params, respond }) => {
    if (!validateAgentsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.list params: ${formatValidationErrors(validateAgentsListParams.errors)}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const result = listAgentsForGateway(cfg);
    respond(true, result, undefined);
  },
  "agents.clone": async ({ params, respond, context }) => {
    if (!validateAgentsCloneParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.clone params: ${formatValidationErrors(validateAgentsCloneParams.errors)}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const sourceAgentIdRaw = typeof params.sourceAgentId === "string" ? params.sourceAgentId : "";
    const sourceAgentId = normalizeAgentId(sourceAgentIdRaw);
    const existingIds = new Set(listAgentIds(cfg).map((id) => normalizeAgentId(id)));
    if (!existingIds.has(sourceAgentId)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${sourceAgentId}" not found`),
      );
      return;
    }

    const entries = listAgentEntries(cfg);
    const sourceEntryIndex = findAgentEntryIndex(entries, sourceAgentId);
    const sourceEntry = sourceEntryIndex >= 0 ? entries[sourceEntryIndex] : undefined;
    const sourceName = sourceEntry?.name?.trim() || sourceAgentId;
    const requestedName = resolveOptionalStringParam(params.name);
    const existingNames = new Set(
      entries
        .map((entry) => entry?.name?.trim())
        .filter((name): name is string => Boolean(name))
        .map((name) => name.toLowerCase()),
    );
    const cloneName = resolveUniqueCloneName(requestedName ?? `${sourceName} Copy`, existingNames);
    const targetAgentId = resolveUniqueCloneAgentId({
      baseName: cloneName,
      sourceAgentId,
      existingIds,
    });

    const sourceWorkspaceDir = resolveAgentWorkspaceDir(cfg, sourceAgentId);
    const sourceAgentDir = resolveAgentDir(cfg, sourceAgentId);
    const requestedWorkspace = resolveOptionalStringParam(params.workspace);
    const workspaceBase = requestedWorkspace
      ? resolveUserPath(requestedWorkspace)
      : `${sourceWorkspaceDir}-copy`;

    const takenWorkspacePaths = new Set(
      [...existingIds].map((agentId) => path.resolve(resolveAgentWorkspaceDir(cfg, agentId))),
    );
    const targetWorkspaceDir = await resolveUniqueClonePath(workspaceBase, takenWorkspacePaths);

    const takenAgentDirPaths = new Set(
      [...existingIds].map((agentId) => path.resolve(resolveAgentDir(cfg, agentId))),
    );
    const targetAgentDir = await resolveUniqueClonePath(
      `${sourceAgentDir}-copy`,
      takenAgentDirPaths,
    );

    const clonedAgentEntry = {
      ...(sourceEntry ? structuredClone(sourceEntry) : {}),
      id: targetAgentId,
      default: false,
      name: cloneName,
      workspace: targetWorkspaceDir,
      agentDir: targetAgentDir,
    };

    const nextAgents = entries.length > 0 ? [...entries] : [{ id: DEFAULT_AGENT_ID }];
    nextAgents.push(clonedAgentEntry);

    const sourceBindings = (cfg.bindings ?? []).filter(
      (binding) => normalizeAgentId(binding.agentId) === sourceAgentId,
    );
    const clonedBindings = sourceBindings.map((binding) => ({
      ...structuredClone(binding),
      agentId: targetAgentId,
    }));
    const nextBindings =
      clonedBindings.length > 0 ? [...(cfg.bindings ?? []), ...clonedBindings] : cfg.bindings;

    const allowList = cfg.tools?.agentToAgent?.allow ?? [];
    const allowHasSource = allowList.some((id) => normalizeAgentId(id) === sourceAgentId);
    const allowHasTarget = allowList.some((id) => normalizeAgentId(id) === targetAgentId);
    const nextTools =
      allowHasSource && !allowHasTarget
        ? {
            ...cfg.tools,
            agentToAgent: {
              ...cfg.tools?.agentToAgent,
              allow: [...allowList, targetAgentId],
            },
          }
        : cfg.tools;

    const nextConfig = {
      ...cfg,
      agents: {
        ...cfg.agents,
        list: nextAgents,
      },
      bindings: nextBindings,
      tools: nextTools,
    };

    const sourceSessionsStorePath = resolveStorePath(cfg.session?.store, {
      agentId: sourceAgentId,
    });
    const targetSessionsStorePath = resolveStorePath(cfg.session?.store, {
      agentId: targetAgentId,
    });
    const sourceSessionsDir = resolveSessionTranscriptsDirForAgent(sourceAgentId);
    const targetSessionsDir = resolveSessionTranscriptsDirForAgent(targetAgentId);

    const sourceMemoryStorePath = resolveMemorySearchConfig(cfg, sourceAgentId)?.store.path;
    const targetMemoryStorePath = resolveMemorySearchConfig(nextConfig, targetAgentId)?.store.path;

    const copied = {
      workspace: false,
      agentDir: false,
      sessionsStore: false,
      sessionsTranscripts: false,
      memoryStore: false,
      cronJobs: 0,
      bindings: clonedBindings.length,
    };
    const warnings: string[] = [];

    copied.workspace = await copyDirectoryIfExists(sourceWorkspaceDir, targetWorkspaceDir);
    if (!copied.workspace) {
      const skipBootstrap = Boolean(nextConfig.agents?.defaults?.skipBootstrap);
      await ensureAgentWorkspace({
        dir: targetWorkspaceDir,
        ensureBootstrapFiles: !skipBootstrap,
      });
    }

    copied.agentDir = await copyDirectoryIfExists(sourceAgentDir, targetAgentDir);
    if (!copied.agentDir) {
      await fs.mkdir(targetAgentDir, { recursive: true });
    }

    if (sameResolvedPath(sourceSessionsDir, targetSessionsDir)) {
      warnings.push(
        "session transcript directory is shared by configuration; skipped directory copy",
      );
    } else if (await pathExists(targetSessionsDir)) {
      copied.sessionsTranscripts = true;
      warnings.push("session transcript directory already present; skipped directory copy");
    } else {
      copied.sessionsTranscripts = await copyDirectoryIfExists(
        sourceSessionsDir,
        targetSessionsDir,
      );
    }
    if (!copied.sessionsTranscripts) {
      await fs.mkdir(targetSessionsDir, { recursive: true });
    }

    if (sameResolvedPath(sourceSessionsStorePath, targetSessionsStorePath)) {
      warnings.push("session store path is shared by configuration; skipped dedicated store copy");
    } else if (await pathExists(targetSessionsStorePath)) {
      copied.sessionsStore = true;
      warnings.push("session store already present after transcript copy; skipped file copy");
    } else {
      copied.sessionsStore = await copyFileIfExists(
        sourceSessionsStorePath,
        targetSessionsStorePath,
      );
    }

    if (sourceMemoryStorePath && targetMemoryStorePath) {
      if (sameResolvedPath(sourceMemoryStorePath, targetMemoryStorePath)) {
        warnings.push(
          "memory store path is shared by configuration; skipped dedicated memory copy",
        );
      } else {
        copied.memoryStore = await copyFileIfExists(sourceMemoryStorePath, targetMemoryStorePath);
      }
    }

    const rewrittenSessionEntries = await rewriteClonedSessionStore({
      targetStorePath: targetSessionsStorePath,
      targetAgentId,
      sourceWorkspaceDir,
      targetWorkspaceDir,
      targetSessionsDir,
    });
    if (rewrittenSessionEntries > 0) {
      warnings.push(
        `rewrote ${rewrittenSessionEntries} cloned session store entr${rewrittenSessionEntries === 1 ? "y" : "ies"} for agent "${targetAgentId}"`,
      );
    }

    await writeConfigFile(nextConfig);

    try {
      const cronClone = await cloneAgentCronJobs({
        context,
        sourceAgentId,
        targetAgentId,
      });
      copied.cronJobs = cronClone.cloned;
      if (cronClone.skippedDuplicates > 0) {
        warnings.push(
          `skipped ${cronClone.skippedDuplicates} duplicate cron job${
            cronClone.skippedDuplicates === 1 ? "" : "s"
          } for agent "${targetAgentId}"`,
        );
      }
    } catch (err) {
      warnings.push(`failed to clone cron jobs: ${String(err)}`);
    }

    respond(
      true,
      {
        ok: true,
        sourceAgentId,
        agentId: targetAgentId,
        name: cloneName,
        workspace: targetWorkspaceDir,
        copied,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      undefined,
    );
  },
  "agents.create": async ({ params, respond }) => {
    if (!validateAgentsCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.create params: ${formatValidationErrors(
            validateAgentsCreateParams.errors,
          )}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const rawName = String(params.name ?? "").trim();
    const agentId = normalizeAgentId(rawName);
    if (agentId === DEFAULT_AGENT_ID) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `"${DEFAULT_AGENT_ID}" is reserved`),
      );
      return;
    }

    if (findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" already exists`),
      );
      return;
    }

    const workspaceDir = resolveUserPath(String(params.workspace ?? "").trim());

    // Resolve agentDir against the config we're about to persist (vs the pre-write config),
    // so subsequent resolutions can't disagree about the agent's directory.
    let nextConfig = applyAgentConfig(cfg, {
      agentId,
      name: rawName,
      workspace: workspaceDir,
    });
    const agentDir = resolveAgentDir(nextConfig, agentId);
    nextConfig = applyAgentConfig(nextConfig, { agentId, agentDir });

    // Ensure workspace & transcripts exist BEFORE writing config so a failure
    // here does not leave a broken config entry behind.
    const skipBootstrap = Boolean(nextConfig.agents?.defaults?.skipBootstrap);
    await ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: !skipBootstrap });
    await fs.mkdir(resolveSessionTranscriptsDirForAgent(agentId), { recursive: true });

    await writeConfigFile(nextConfig);

    // Always write Name to IDENTITY.md; optionally include emoji/avatar.
    const safeName = sanitizeIdentityLine(rawName);
    const emoji = resolveOptionalStringParam(params.emoji);
    const avatar = resolveOptionalStringParam(params.avatar);
    const identityPath = path.join(workspaceDir, DEFAULT_IDENTITY_FILENAME);
    const lines = [
      "",
      `- Name: ${safeName}`,
      ...(emoji ? [`- Emoji: ${sanitizeIdentityLine(emoji)}`] : []),
      ...(avatar ? [`- Avatar: ${sanitizeIdentityLine(avatar)}`] : []),
      "",
    ];
    await fs.appendFile(identityPath, lines.join("\n"), "utf-8");

    respond(true, { ok: true, agentId, name: rawName, workspace: workspaceDir }, undefined);
  },
  "agents.update": async ({ params, respond }) => {
    if (!validateAgentsUpdateParams(params)) {
      respondInvalidMethodParams(respond, "agents.update", validateAgentsUpdateParams.errors);
      return;
    }

    const cfg = loadConfig();
    const agentId = normalizeAgentId(String(params.agentId ?? ""));
    if (!isConfiguredAgent(cfg, agentId)) {
      respondAgentNotFound(respond, agentId);
      return;
    }

    const workspaceDir =
      typeof params.workspace === "string" && params.workspace.trim()
        ? resolveUserPath(params.workspace.trim())
        : undefined;

    const model = resolveOptionalStringParam(params.model);
    const avatar = resolveOptionalStringParam(params.avatar);

    const nextConfig = applyAgentConfig(cfg, {
      agentId,
      ...(typeof params.name === "string" && params.name.trim()
        ? { name: params.name.trim() }
        : {}),
      ...(workspaceDir ? { workspace: workspaceDir } : {}),
      ...(model ? { model } : {}),
    });

    await writeConfigFile(nextConfig);

    if (workspaceDir) {
      const skipBootstrap = Boolean(nextConfig.agents?.defaults?.skipBootstrap);
      await ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: !skipBootstrap });
    }

    if (avatar) {
      const workspace = workspaceDir ?? resolveAgentWorkspaceDir(nextConfig, agentId);
      await fs.mkdir(workspace, { recursive: true });
      const identityPath = path.join(workspace, DEFAULT_IDENTITY_FILENAME);
      await fs.appendFile(identityPath, `\n- Avatar: ${sanitizeIdentityLine(avatar)}\n`, "utf-8");
    }

    respond(true, { ok: true, agentId }, undefined);
  },
  "agents.delete": async ({ params, respond, context }) => {
    if (!validateAgentsDeleteParams(params)) {
      respondInvalidMethodParams(respond, "agents.delete", validateAgentsDeleteParams.errors);
      return;
    }

    const cfg = loadConfig();
    const agentIdRaw = typeof params.agentId === "string" ? params.agentId : "";
    const agentId = normalizeAgentId(agentIdRaw);
    if (agentId === DEFAULT_AGENT_ID) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `"${DEFAULT_AGENT_ID}" cannot be deleted`),
      );
      return;
    }
    if (!isConfiguredAgent(cfg, agentId)) {
      respondAgentNotFound(respond, agentId);
      return;
    }

    const deleteFiles = typeof params.deleteFiles === "boolean" ? params.deleteFiles : true;
    const purgeState = typeof params.purgeState === "boolean" ? params.purgeState : true;
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const agentDir = resolveAgentDir(cfg, agentId);
    const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
    const agentStateRootDir = path.join(resolveStateDir(process.env), "agents", agentId);

    const result = pruneAgentConfig(cfg, agentId);
    let removedSessions = 0;
    let removedCronJobs = 0;
    if (purgeState) {
      removedSessions = await removeAgentSessionsFromStore({
        cfg,
        agentId,
        sessionsDir,
      });
      removedCronJobs = await removeAgentCronJobs({ context, agentId });
    }
    await writeConfigFile(result.config);

    if (deleteFiles) {
      const memoryStorePath = resolveMemorySearchConfig(cfg, agentId)?.store.path;
      const remainingAgentIds = listAgentIds(result.config).map((id) => normalizeAgentId(id));
      const memoryStoreUsedByOtherAgent =
        typeof memoryStorePath === "string" &&
        remainingAgentIds.some((remainingAgentId) => {
          const remainingStorePath = resolveMemorySearchConfig(result.config, remainingAgentId)
            ?.store.path;
          return (
            typeof remainingStorePath === "string" &&
            sameResolvedPath(remainingStorePath, memoryStorePath)
          );
        });

      const deletePaths = [
        workspaceDir,
        agentStateRootDir,
        agentDir,
        sessionsDir,
        typeof memoryStorePath === "string" && !memoryStoreUsedByOtherAgent
          ? memoryStorePath
          : undefined,
      ]
        .filter((pathname): pathname is string => Boolean(pathname))
        .map((pathname) => path.resolve(pathname));
      const uniqueDeletePaths = Array.from(new Set(deletePaths));
      await Promise.all(uniqueDeletePaths.map((pathname) => moveToTrashBestEffort(pathname)));
    }

    respond(
      true,
      {
        ok: true,
        agentId,
        removedBindings: result.removedBindings,
        removedAllow: result.removedAllow,
        ...(purgeState ? { removedSessions, removedCronJobs } : {}),
      },
      undefined,
    );
  },
  "agents.files.list": async ({ params, respond }) => {
    if (!validateAgentsFilesListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agents.files.list params: ${formatValidationErrors(
            validateAgentsFilesListParams.errors,
          )}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentId = resolveAgentIdOrError(String(params.agentId ?? ""), cfg);
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    let hideBootstrap = false;
    try {
      hideBootstrap = await isWorkspaceOnboardingCompleted(workspaceDir);
    } catch {
      // Fall back to showing BOOTSTRAP if workspace state cannot be read.
    }
    const files = await listAgentFiles(workspaceDir, { hideBootstrap });
    respond(true, { agentId, workspace: workspaceDir, files }, undefined);
  },
  "agents.files.get": async ({ params, respond }) => {
    if (!validateAgentsFilesGetParams(params)) {
      respondInvalidMethodParams(respond, "agents.files.get", validateAgentsFilesGetParams.errors);
      return;
    }
    const resolved = resolveAgentWorkspaceFileOrRespondError(params, respond);
    if (!resolved) {
      return;
    }
    const { agentId, workspaceDir, name } = resolved;
    const filePath = path.join(workspaceDir, name);
    const resolvedPath = await resolveWorkspaceFilePathOrRespond({
      respond,
      workspaceDir,
      name,
    });
    if (!resolvedPath) {
      return;
    }
    if (resolvedPath.kind === "missing") {
      respondWorkspaceFileMissing({ respond, agentId, workspaceDir, name, filePath });
      return;
    }
    let safeRead: Awaited<ReturnType<typeof readLocalFileSafely>>;
    try {
      safeRead = await readLocalFileSafely({ filePath: resolvedPath.ioPath });
    } catch (err) {
      if (err instanceof SafeOpenError && err.code === "not-found") {
        respondWorkspaceFileMissing({ respond, agentId, workspaceDir, name, filePath });
        return;
      }
      respondWorkspaceFileUnsafe(respond, name);
      return;
    }
    respond(
      true,
      {
        agentId,
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          missing: false,
          size: safeRead.stat.size,
          updatedAtMs: Math.floor(safeRead.stat.mtimeMs),
          content: safeRead.buffer.toString("utf-8"),
        },
      },
      undefined,
    );
  },
  "agents.files.set": async ({ params, respond }) => {
    if (!validateAgentsFilesSetParams(params)) {
      respondInvalidMethodParams(respond, "agents.files.set", validateAgentsFilesSetParams.errors);
      return;
    }
    const resolved = resolveAgentWorkspaceFileOrRespondError(params, respond);
    if (!resolved) {
      return;
    }
    const { agentId, workspaceDir, name } = resolved;
    await fs.mkdir(workspaceDir, { recursive: true });
    const filePath = path.join(workspaceDir, name);
    const resolvedPath = await resolveWorkspaceFilePathOrRespond({
      respond,
      workspaceDir,
      name,
    });
    if (!resolvedPath) {
      return;
    }
    const content = String(params.content ?? "");
    try {
      await writeFileWithinRoot({
        rootDir: workspaceDir,
        relativePath: name,
        data: content,
        encoding: "utf8",
      });
    } catch {
      respondWorkspaceFileUnsafe(respond, name);
      return;
    }
    const meta = await statFileSafely(resolvedPath.ioPath);
    respond(
      true,
      {
        ok: true,
        agentId,
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          missing: false,
          size: meta?.size,
          updatedAtMs: meta?.updatedAtMs,
          content,
        },
      },
      undefined,
    );
  },
};
