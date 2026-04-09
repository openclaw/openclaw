import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { resolveWatchLockPath } from "../../scripts/watch-node.mjs";
import { resolveStateDir } from "../config/paths.js";
import { formatRuntimeStatusWithDetails } from "../infra/runtime-status.js";
import { runCommandWithTimeout, type CommandOptions } from "../process/exec.js";
import { runDaemonRestart } from "./daemon-cli/runners.js";
import {
  gatherDaemonStatus as gatherDaemonStatusDefault,
  type DaemonStatus,
} from "./daemon-cli/status.gather.js";

const LIVE_CONTROL_VERSION = 1;
const DEFAULT_JOURNAL_LIMIT = 10;
const DEFAULT_GIT_TIMEOUT_MS = 10_000;
const DEFAULT_BUILD_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_SMOKE_TIMEOUT_MS = 10_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 20 * 60_000;
const WATCH_ARGS = ["gateway", "--force"];
const LIVE_CONTROL_DIRNAME = "live-control";
const JOURNAL_FILENAME = "journal.jsonl";
const LOCK_FILENAME = "lock.json";
const MANIFEST_FILENAME = "manifest.json";
const DRAFTS_DIRNAME = "drafts";
const KNOWN_LOCKFILE_PATHS = ["pnpm-lock.yaml", "package-lock.json", "bun.lock", "bun.lockb"];

const liveManifestSchema = z.object({
  version: z.literal(LIVE_CONTROL_VERSION),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  liveCheckoutPath: z.string().min(1),
  liveBranch: z.string().min(1),
  promotedCommit: z.string().min(1).nullable(),
  previousPromotedCommit: z.string().min(1).nullable().optional(),
  runtimeEntryPath: z.string().min(1).nullable(),
  policy: z.object({
    liveMutationsRequirePromote: z.boolean(),
    branchSwitchesBlocked: z.boolean(),
    draftStrategy: z.literal("worktree"),
  }),
  runtimeState: z
    .object({
      sourcePath: z.string().min(1).nullable(),
      loadedCommit: z.string().min(1).nullable(),
      loadedAt: z.string().min(1),
      pid: z.number().int().positive().nullable(),
    })
    .optional(),
});

const liveJournalEntrySchema = z.object({
  id: z.string().min(1),
  ts: z.string().min(1),
  actor: z.string().min(1),
  type: z.enum([
    "initialized",
    "runtime_started",
    "draft_created",
    "promoted",
    "rolled_back",
    "promotion_failed",
    "synced",
    "sync_failed",
  ]),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).default({}),
});

const actorLockSchema = z.object({
  actor: z.string().min(1),
  operation: z.enum(["start", "promote", "draft", "sync"]),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
});

export type LiveManifest = z.infer<typeof liveManifestSchema>;
export type LiveJournalEntry = z.infer<typeof liveJournalEntrySchema>;
export type LiveActorLock = z.infer<typeof actorLockSchema>;

type GitState = {
  branch: string;
  commonDir: string;
  head: string;
  root: string;
  dirty: boolean;
  dirtyLines: string[];
};

export type LiveStatusIssue = {
  code:
    | "branch-drift"
    | "dirty-live-checkout"
    | "promoted-commit-drift"
    | "runtime-commit-drift"
    | "runtime-source-mismatch"
    | "watcher-stale";
  message: string;
};

export type LiveWatcherStatus = {
  lockPath: string;
  status: "active" | "inactive" | "stale";
  pid: number | null;
  command: string | null;
  createdAt: string | null;
};

export type DraftSummary = {
  path: string;
  branch: string | null;
  dirty: boolean;
};

export type LiveSyncBlocker = {
  code:
    | "busy"
    | "branch-drift"
    | "dirty-live-checkout"
    | "drafts-present"
    | "fork-remote-misconfigured"
    | "live-branch-not-main"
    | "origin-fetch-failed"
    | "origin-main-missing"
    | "promoted-commit-drift"
    | "runtime-commit-drift"
    | "runtime-source-mismatch"
    | "runtime-source-unverified"
    | "sync-diverged";
  message: string;
};

export type LiveStatusSnapshot = {
  manifest: LiveManifest;
  liveGit: GitState;
  runtime: {
    pid: number | null;
    status: string;
    summary: string;
    sourcePath: string | null;
    matchesLiveCheckout: boolean | null;
    loadedCommit: string | null;
    loadedAt: string | null;
    matchesLiveCommit: boolean | null;
  };
  watcher: LiveWatcherStatus;
  actorLock: LiveActorLock | null;
  recentJournal: LiveJournalEntry[];
  drafts: DraftSummary[];
  issues: LiveStatusIssue[];
};

export type LiveSyncStatus = {
  liveCheckoutPath: string;
  liveSha: string;
  originMainSha: string | null;
  behindBy: number | null;
  safeToApply: boolean;
  blockers: LiveSyncBlocker[];
  runtimeMatchesLive: boolean | null;
  runtimeLoadedCommit: string | null;
  draftCount: number;
  lockfileChanged: boolean;
};

type CapturedRuntimeState = {
  sourcePath: string;
  loadedCommit: string;
  loadedAt: string;
  pid: number | null;
};

type CommandResult = {
  code: number | null;
  stderr: string;
  stdout: string;
};

export type LiveControlDeps = {
  buildCheckout: (checkoutPath: string, timeoutMs: number) => Promise<void>;
  gatherDaemonStatus: (timeoutMs: number) => Promise<DaemonStatus>;
  now: () => Date;
  resolveStateDir: () => string;
  restartRuntime: () => Promise<void>;
  runCommand: (argv: string[], options: CommandOptions) => Promise<CommandResult>;
};

const defaultLiveControlDeps: LiveControlDeps = {
  async buildCheckout(checkoutPath, timeoutMs) {
    const result = await runCommandWithTimeout(["pnpm", "build"], {
      cwd: checkoutPath,
      timeoutMs,
    });
    if (result.code !== 0) {
      throw new Error(
        `Build failed in ${checkoutPath}: ${trimCommandFailure(result.stderr || result.stdout)}`,
      );
    }
  },
  async gatherDaemonStatus(timeoutMs) {
    return await gatherDaemonStatusDefault({
      rpc: { timeout: String(timeoutMs) },
      probe: true,
      requireRpc: false,
      deep: false,
    });
  },
  now: () => new Date(),
  resolveStateDir: () => resolveStateDir(process.env),
  async restartRuntime() {
    await runDaemonRestart({});
  },
  async runCommand(argv, options) {
    const result = await runCommandWithTimeout(argv, options);
    return {
      code: result.code,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  },
};

type ResolveManifestParams = {
  checkout?: string | null;
  cwd?: string;
  actor?: string | null;
  deps?: Partial<LiveControlDeps>;
};

type StartRuntimeParams = ResolveManifestParams & {
  smokeTimeoutMs?: number;
};

type PromoteParams = ResolveManifestParams & {
  buildTimeoutMs?: number;
  smokeTimeoutMs?: number;
  source?: string | null;
};

type SyncParams = ResolveManifestParams & {
  buildTimeoutMs?: number;
  smokeTimeoutMs?: number;
  fetchOrigin?: boolean;
};

type CreateDraftParams = ResolveManifestParams & {
  message?: string | null;
  name: string;
};

function withDeps(overrides?: Partial<LiveControlDeps>): LiveControlDeps {
  return {
    ...defaultLiveControlDeps,
    ...overrides,
  };
}

function liveControlDir(stateDir: string): string {
  return path.join(stateDir, LIVE_CONTROL_DIRNAME);
}

function resolveJournalPath(stateDir: string): string {
  return path.join(liveControlDir(stateDir), JOURNAL_FILENAME);
}

function resolveLockPath(stateDir: string): string {
  return path.join(liveControlDir(stateDir), LOCK_FILENAME);
}

function resolveManifestPath(stateDir: string): string {
  return path.join(liveControlDir(stateDir), MANIFEST_FILENAME);
}

function resolveDraftsRoot(stateDir: string): string {
  return path.join(liveControlDir(stateDir), DRAFTS_DIRNAME);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatIso(now: Date): string {
  return now.toISOString();
}

function trimCommandFailure(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return "unknown failure";
  }
  const lines = value.split(/\r?\n/);
  return lines.slice(-6).join(" | ");
}

function resolveActor(actor?: string | null): string {
  const trimmed = actor?.trim();
  if (trimmed) {
    return trimmed;
  }
  const session = process.env.OPENCLAW_SESSION?.trim();
  if (session) {
    return `session:${session}`;
  }
  const user = os.userInfo().username || "unknown";
  return `cli:${user}`;
}

function slugifyDraftName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "draft";
}

class LiveAdvanceError extends Error {
  readonly restoredPreviousLiveState: boolean;

  constructor(message: string, params: { restoredPreviousLiveState: boolean; cause?: unknown }) {
    super(message, params.cause ? { cause: params.cause } : undefined);
    this.name = "LiveAdvanceError";
    this.restoredPreviousLiveState = params.restoredPreviousLiveState;
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

async function readJsonFile<T>(filePath: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendJournalEntry(stateDir: string, entry: LiveJournalEntry): Promise<void> {
  const filePath = resolveJournalPath(stateDir);
  await ensureDir(path.dirname(filePath));
  await fsp.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

async function readJournalEntries(
  stateDir: string,
  limit = DEFAULT_JOURNAL_LIMIT,
): Promise<LiveJournalEntry[]> {
  const filePath = resolveJournalPath(stateDir);
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines
      .slice(Math.max(0, lines.length - Math.max(1, limit)))
      .map((line) => liveJournalEntrySchema.parse(JSON.parse(line)))
      .toReversed();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readActorLock(stateDir: string): Promise<LiveActorLock | null> {
  const filePath = resolveLockPath(stateDir);
  const value = await readJsonFile(filePath, actorLockSchema);
  if (!value) {
    return null;
  }
  if (!isProcessAlive(value.pid)) {
    await fsp.rm(filePath, { force: true });
    return null;
  }
  return value;
}

async function withActorLock<T>(
  stateDir: string,
  params: { actor: string; operation: LiveActorLock["operation"] },
  run: () => Promise<T>,
): Promise<T> {
  const filePath = resolveLockPath(stateDir);
  const existing = await readActorLock(stateDir);
  if (existing) {
    throw new Error(
      `Live control is busy: ${existing.operation} by ${existing.actor} (pid ${existing.pid}).`,
    );
  }
  const lock: LiveActorLock = {
    actor: params.actor,
    operation: params.operation,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await writeJsonFile(filePath, lock);
  try {
    return await run();
  } finally {
    await fsp.rm(filePath, { force: true });
  }
}

async function runGitCommand(
  root: string,
  args: string[],
  deps: LiveControlDeps,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
): Promise<string> {
  const result = await deps.runCommand(["git", "-C", root, ...args], {
    cwd: root,
    timeoutMs,
  });
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${trimCommandFailure(result.stderr || result.stdout)}`,
    );
  }
  return result.stdout.trim();
}

async function tryRunGitCommand(
  root: string,
  args: string[],
  deps: LiveControlDeps,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
): Promise<string | null> {
  const result = await deps
    .runCommand(["git", "-C", root, ...args], {
      cwd: root,
      timeoutMs,
    })
    .catch(() => null);
  if (!result || result.code !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  return value || null;
}

async function resolveGitRoot(cwd: string, deps: LiveControlDeps): Promise<string | null> {
  const result = await deps
    .runCommand(["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
      cwd,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    })
    .catch(() => null);
  if (!result || result.code !== 0) {
    return null;
  }
  const root = result.stdout.trim();
  return root ? path.resolve(cwd, root) : null;
}

async function readGitState(root: string, deps: LiveControlDeps): Promise<GitState> {
  const [branch, head, commonDirRaw, statusRaw] = await Promise.all([
    runGitCommand(root, ["branch", "--show-current"], deps),
    runGitCommand(root, ["rev-parse", "HEAD"], deps),
    runGitCommand(root, ["rev-parse", "--git-common-dir"], deps),
    runGitCommand(root, ["status", "--porcelain", "--untracked-files=normal"], deps),
  ]);
  const dirtyLines = statusRaw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  return {
    branch: branch || "HEAD",
    commonDir: path.resolve(root, commonDirRaw || ".git"),
    dirty: dirtyLines.length > 0,
    dirtyLines,
    head,
    root,
  };
}

async function resolveDaemonCommandCheckoutPath(
  command: DaemonStatus["service"]["command"] | null | undefined,
  deps: LiveControlDeps,
): Promise<string | null> {
  if (!command) {
    return null;
  }

  const rawCandidates = [
    command.workingDirectory?.trim() || null,
    ...command.programArguments.flatMap((arg) => {
      const value = arg.trim();
      if (!value || !path.isAbsolute(value)) {
        return [];
      }
      return [value, path.dirname(value)];
    }),
    command.sourcePath?.trim() || null,
  ].filter((value): value is string => Boolean(value));

  const seen = new Set<string>();
  for (const candidate of rawCandidates) {
    const resolvedCandidate = path.resolve(candidate);
    if (seen.has(resolvedCandidate)) {
      continue;
    }
    seen.add(resolvedCandidate);
    const root = await resolveGitRoot(resolvedCandidate, deps);
    if (root) {
      return root;
    }
  }

  return null;
}

async function resolveLiveCheckoutPath(
  params: ResolveManifestParams,
  deps: LiveControlDeps,
): Promise<string> {
  if (params.checkout?.trim()) {
    const root = await resolveGitRoot(path.resolve(params.checkout), deps);
    if (!root) {
      throw new Error(`Expected a git checkout at ${params.checkout}.`);
    }
    return root;
  }

  const cwd = params.cwd ?? process.cwd();
  const rootFromCwd = await resolveGitRoot(cwd, deps);
  if (rootFromCwd) {
    return rootFromCwd;
  }

  const daemonStatus = await deps.gatherDaemonStatus(DEFAULT_SMOKE_TIMEOUT_MS).catch(() => null);
  const runtimeCheckoutPath = await resolveDaemonCommandCheckoutPath(
    daemonStatus?.service.command,
    deps,
  );
  if (runtimeCheckoutPath) {
    return runtimeCheckoutPath;
  }

  throw new Error(
    "Could not resolve a live checkout. Run this command from a repo checkout or pass --checkout <path>.",
  );
}

async function loadManifest(stateDir: string): Promise<LiveManifest | null> {
  return await readJsonFile(resolveManifestPath(stateDir), liveManifestSchema);
}

async function saveManifest(stateDir: string, manifest: LiveManifest): Promise<void> {
  await writeJsonFile(resolveManifestPath(stateDir), manifest);
}

async function ensureManifest(params: ResolveManifestParams): Promise<{
  manifest: LiveManifest;
  stateDir: string;
}> {
  const deps = withDeps(params.deps);
  const stateDir = deps.resolveStateDir();
  const existing = await loadManifest(stateDir);
  if (existing) {
    return { manifest: existing, stateDir };
  }

  const liveCheckoutPath = await resolveLiveCheckoutPath(params, deps);
  const git = await readGitState(liveCheckoutPath, deps);
  const now = formatIso(deps.now());
  const manifest: LiveManifest = {
    version: LIVE_CONTROL_VERSION,
    createdAt: now,
    updatedAt: now,
    liveCheckoutPath,
    liveBranch: git.branch || "main",
    promotedCommit: git.head || null,
    previousPromotedCommit: null,
    runtimeEntryPath: path.join(liveCheckoutPath, "dist", "index.js"),
    policy: {
      branchSwitchesBlocked: true,
      draftStrategy: "worktree",
      liveMutationsRequirePromote: true,
    },
  };
  await saveManifest(stateDir, manifest);
  await appendJournalEntry(stateDir, {
    id: `init-${Date.now()}`,
    ts: now,
    actor: resolveActor(params.actor),
    type: "initialized",
    message: `Initialized live control for ${liveCheckoutPath}`,
    details: {
      liveBranch: manifest.liveBranch,
      promotedCommit: manifest.promotedCommit,
    },
  });
  return { manifest, stateDir };
}

async function resolveWatcherStatus(liveCheckoutPath: string): Promise<LiveWatcherStatus> {
  const lockPath = resolveWatchLockPath(liveCheckoutPath, WATCH_ARGS);
  try {
    const raw = await fsp.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number; command?: string; createdAt?: string };
    const pid = typeof parsed.pid === "number" ? parsed.pid : null;
    return {
      lockPath,
      status: pid && isProcessAlive(pid) ? "active" : "stale",
      pid,
      command: typeof parsed.command === "string" ? parsed.command : null,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {
        lockPath,
        status: "inactive",
        pid: null,
        command: null,
        createdAt: null,
      };
    }
    throw error;
  }
}

async function listDrafts(stateDir: string, deps: LiveControlDeps): Promise<DraftSummary[]> {
  const draftsRoot = resolveDraftsRoot(stateDir);
  try {
    const entries = await fsp.readdir(draftsRoot, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory());
    const results: DraftSummary[] = [];
    for (const entry of dirs) {
      const worktreePath = path.join(draftsRoot, entry.name);
      const root = await resolveGitRoot(worktreePath, deps);
      if (!root) {
        continue;
      }
      const gitState = await readGitState(root, deps).catch(() => null);
      results.push({
        path: root,
        branch: gitState?.branch ?? null,
        dirty: gitState?.dirty ?? false,
      });
    }
    return results.toSorted((a, b) => a.path.localeCompare(b.path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function normalizeRemoteUrl(value: string): string {
  const trimmed = value.trim().replace(/\.git$/i, "");
  const sshMatch = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`.replace(/\/+$/g, "").toLowerCase();
  }
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/g, "").toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/g, "").toLowerCase();
  }
}

async function fetchRemoteRef(
  root: string,
  remote: string,
  deps: LiveControlDeps,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
): Promise<boolean> {
  const result = await deps
    .runCommand(["git", "-C", root, "fetch", "--quiet", remote, "main"], {
      cwd: root,
      timeoutMs,
    })
    .catch(() => null);
  return Boolean(result && result.code === 0);
}

async function resolveGitRemoteUrl(
  root: string,
  remote: string,
  deps: LiveControlDeps,
): Promise<string | null> {
  return await tryRunGitCommand(root, ["remote", "get-url", remote], deps);
}

async function resolveGitRef(
  root: string,
  ref: string,
  deps: LiveControlDeps,
): Promise<string | null> {
  return await tryRunGitCommand(root, ["rev-parse", ref], deps);
}

async function resolveAheadBehindCounts(
  root: string,
  left: string,
  right: string,
  deps: LiveControlDeps,
): Promise<{ ahead: number | null; behind: number | null }> {
  const raw = await tryRunGitCommand(
    root,
    ["rev-list", "--left-right", "--count", `${left}...${right}`],
    deps,
  );
  if (!raw) {
    return { ahead: null, behind: null };
  }
  const [aheadRaw, behindRaw] = raw.split(/\s+/);
  const ahead = Number.parseInt(aheadRaw ?? "", 10);
  const behind = Number.parseInt(behindRaw ?? "", 10);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return { ahead: null, behind: null };
  }
  return { ahead, behind };
}

async function detectLockfileChange(
  root: string,
  baseRef: string,
  targetRef: string,
  deps: LiveControlDeps,
): Promise<boolean> {
  const result = await deps.runCommand(
    [
      "git",
      "-C",
      root,
      "diff",
      "--name-only",
      `${baseRef}..${targetRef}`,
      "--",
      ...KNOWN_LOCKFILE_PATHS,
    ],
    {
      cwd: root,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `Could not inspect lockfile changes between ${baseRef} and ${targetRef}: ${trimCommandFailure(result.stderr || result.stdout)}`,
    );
  }
  return (
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean).length > 0
  );
}

async function installCheckoutDependencies(
  checkoutPath: string,
  deps: LiveControlDeps,
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
): Promise<void> {
  const result = await deps.runCommand(["pnpm", "install", "--frozen-lockfile"], {
    cwd: checkoutPath,
    timeoutMs,
  });
  if (result.code !== 0) {
    throw new Error(
      `Dependency install failed in ${checkoutPath}: ${trimCommandFailure(result.stderr || result.stdout)}`,
    );
  }
}

function runtimeSummaryFromStatus(status: DaemonStatus): {
  pid: number | null;
  status: string;
  summary: string;
  sourcePath: string | null;
  matchesLiveCheckout: boolean | null;
  loadedCommit: string | null;
  loadedAt: string | null;
  matchesLiveCommit: boolean | null;
} {
  const runtimeStatus = status.service.runtime?.status ?? "unknown";
  return {
    pid: status.service.runtime?.pid ?? null,
    status: runtimeStatus,
    summary: formatRuntimeStatusWithDetails({
      status: runtimeStatus,
      pid: status.service.runtime?.pid,
      state: status.service.runtime?.detail,
    }),
    sourcePath:
      status.service.command?.workingDirectory?.trim() ||
      status.service.command?.sourcePath?.trim() ||
      null,
    matchesLiveCheckout: null,
    loadedCommit: null,
    loadedAt: null,
    matchesLiveCommit: null,
  };
}

async function captureRuntimeState(params: {
  deps: LiveControlDeps;
  expectedLiveCheckoutPath: string;
  loadedAt: string;
  timeoutMs: number;
}): Promise<CapturedRuntimeState> {
  const status = await params.deps.gatherDaemonStatus(params.timeoutMs);
  const runtimeCheckoutPath = await resolveDaemonCommandCheckoutPath(
    status.service.command,
    params.deps,
  );
  if (!runtimeCheckoutPath) {
    throw new Error("Could not resolve the running gateway checkout after restart.");
  }
  if (path.resolve(runtimeCheckoutPath) !== path.resolve(params.expectedLiveCheckoutPath)) {
    throw new Error(
      `Gateway runtime source ${runtimeCheckoutPath} does not match live checkout ${params.expectedLiveCheckoutPath}.`,
    );
  }
  if (status.service.runtime?.status !== "running") {
    throw new Error(
      `Gateway runtime is not running (${status.service.runtime?.status ?? "unknown"}).`,
    );
  }
  if (!status.rpc?.ok) {
    throw new Error(`Gateway RPC probe failed: ${status.rpc?.error ?? "unknown error"}`);
  }
  const runtimeGit = await readGitState(runtimeCheckoutPath, params.deps);
  return {
    sourcePath: runtimeCheckoutPath,
    loadedCommit: runtimeGit.head,
    loadedAt: params.loadedAt,
    pid: status.service.runtime?.pid ?? null,
  };
}

export async function collectLiveStatus(
  params: ResolveManifestParams & { journalLimit?: number },
): Promise<LiveStatusSnapshot> {
  const deps = withDeps(params.deps);
  const { manifest, stateDir } = await ensureManifest(params);
  const [liveGit, daemonStatus, watcher, actorLock, recentJournal, drafts] = await Promise.all([
    readGitState(manifest.liveCheckoutPath, deps),
    deps.gatherDaemonStatus(DEFAULT_SMOKE_TIMEOUT_MS).catch(() => null),
    resolveWatcherStatus(manifest.liveCheckoutPath),
    readActorLock(stateDir),
    readJournalEntries(stateDir, params.journalLimit ?? DEFAULT_JOURNAL_LIMIT),
    listDrafts(stateDir, deps),
  ]);

  const runtime = daemonStatus
    ? runtimeSummaryFromStatus(daemonStatus)
    : {
        pid: null,
        status: "unknown",
        summary: "unknown",
        sourcePath: null,
        matchesLiveCheckout: null,
        loadedCommit: null,
        loadedAt: null,
        matchesLiveCommit: null,
      };
  const runtimeCheckoutPath = daemonStatus
    ? await resolveDaemonCommandCheckoutPath(daemonStatus.service.command, deps)
    : null;
  if (runtimeCheckoutPath) {
    runtime.sourcePath = runtimeCheckoutPath;
    runtime.matchesLiveCheckout =
      path.resolve(runtimeCheckoutPath) === path.resolve(manifest.liveCheckoutPath);
  }
  const manifestRuntime = manifest.runtimeState;
  const runtimeStateMatchesProcess =
    manifestRuntime &&
    runtime.pid != null &&
    manifestRuntime.pid != null &&
    runtime.pid === manifestRuntime.pid &&
    runtime.sourcePath != null &&
    manifestRuntime.sourcePath != null &&
    path.resolve(runtime.sourcePath) === path.resolve(manifestRuntime.sourcePath);
  if (runtimeStateMatchesProcess) {
    runtime.loadedCommit = manifestRuntime.loadedCommit ?? null;
    runtime.loadedAt = manifestRuntime.loadedAt;
    runtime.matchesLiveCommit =
      manifestRuntime.loadedCommit != null ? manifestRuntime.loadedCommit === liveGit.head : null;
  }

  const issues: LiveStatusIssue[] = [];
  if (liveGit.branch !== manifest.liveBranch) {
    issues.push({
      code: "branch-drift",
      message: `Live checkout branch drifted to ${liveGit.branch}; expected ${manifest.liveBranch}.`,
    });
  }
  if (liveGit.dirty) {
    issues.push({
      code: "dirty-live-checkout",
      message: "Live checkout is dirty; draft work should not live in the live lane.",
    });
  }
  if (manifest.promotedCommit && liveGit.head !== manifest.promotedCommit) {
    issues.push({
      code: "promoted-commit-drift",
      message: `Live HEAD ${liveGit.head.slice(0, 7)} no longer matches promoted commit ${manifest.promotedCommit.slice(0, 7)}.`,
    });
  }
  if (runtime.matchesLiveCheckout === false) {
    issues.push({
      code: "runtime-source-mismatch",
      message: `Gateway runtime source ${runtime.sourcePath} does not match live checkout ${manifest.liveCheckoutPath}.`,
    });
  }
  if (runtime.matchesLiveCheckout === true && runtime.matchesLiveCommit === false) {
    issues.push({
      code: "runtime-commit-drift",
      message: `Gateway runtime loaded commit ${runtime.loadedCommit?.slice(0, 7) ?? "unknown"} does not match live HEAD ${liveGit.head.slice(0, 7)}.`,
    });
  }
  if (watcher.status === "stale") {
    issues.push({
      code: "watcher-stale",
      message:
        "Gateway watch lock is stale. Restart the live runtime to re-establish a clean watcher state.",
    });
  }

  return {
    manifest,
    liveGit,
    runtime,
    watcher,
    actorLock,
    recentJournal,
    drafts,
    issues,
  };
}

function assertSafeLiveLane(status: LiveStatusSnapshot): void {
  const blocking = status.issues.filter(
    (issue) =>
      issue.code === "branch-drift" ||
      issue.code === "dirty-live-checkout" ||
      issue.code === "promoted-commit-drift" ||
      issue.code === "runtime-commit-drift" ||
      issue.code === "runtime-source-mismatch",
  );
  if (blocking.length > 0) {
    throw new Error(blocking.map((issue) => issue.message).join(" "));
  }
}

function assertSafeLiveCheckoutForRestart(status: LiveStatusSnapshot): void {
  const blocking = status.issues.filter(
    (issue) =>
      issue.code === "branch-drift" ||
      issue.code === "dirty-live-checkout" ||
      issue.code === "promoted-commit-drift",
  );
  if (blocking.length > 0) {
    throw new Error(blocking.map((issue) => issue.message).join(" "));
  }
}

function createBlockerCollector() {
  const blockers: LiveSyncBlocker[] = [];
  const seen = new Set<string>();
  return {
    add(blocker: LiveSyncBlocker) {
      const key = `${blocker.code}:${blocker.message}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      blockers.push(blocker);
    },
    list() {
      return blockers;
    },
  };
}

async function smokeCheckRuntime(
  deps: LiveControlDeps,
  timeoutMs: number,
  expectedLiveCheckoutPath: string,
): Promise<CapturedRuntimeState> {
  return await captureRuntimeState({
    deps,
    expectedLiveCheckoutPath,
    loadedAt: formatIso(deps.now()),
    timeoutMs,
  });
}

async function advanceLiveCheckout(params: {
  buildTimeoutMs: number;
  deps: LiveControlDeps;
  installDeps: boolean;
  liveCheckoutPath: string;
  smokeTimeoutMs: number;
  targetCommit: string;
}): Promise<{ currentHead: string; liveChanged: boolean; runtimeState: CapturedRuntimeState }> {
  const liveGit = await readGitState(params.liveCheckoutPath, params.deps);
  const currentHead = liveGit.head;
  let liveChanged = false;
  if (params.targetCommit !== currentHead) {
    const mergeResult = await params.deps.runCommand(
      ["git", "-C", params.liveCheckoutPath, "merge", "--ff-only", params.targetCommit],
      {
        cwd: params.liveCheckoutPath,
        timeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
      },
    );
    if (mergeResult.code !== 0) {
      throw new Error(
        `Could not fast-forward live checkout to ${params.targetCommit.slice(0, 7)}: ${trimCommandFailure(mergeResult.stderr || mergeResult.stdout)}`,
      );
    }
    liveChanged = true;
  }

  try {
    if (params.installDeps) {
      await installCheckoutDependencies(params.liveCheckoutPath, params.deps);
    }
    await params.deps.buildCheckout(params.liveCheckoutPath, params.buildTimeoutMs);
    await params.deps.restartRuntime();
    const runtimeState = await smokeCheckRuntime(
      params.deps,
      params.smokeTimeoutMs,
      params.liveCheckoutPath,
    );
    return { currentHead, liveChanged, runtimeState };
  } catch (error) {
    let restoredPreviousLiveState = false;
    if (liveChanged) {
      await restoreLiveCheckoutCommit({
        buildTimeoutMs: params.buildTimeoutMs,
        commit: currentHead,
        deps: params.deps,
        installDeps: params.installDeps,
        liveCheckoutPath: params.liveCheckoutPath,
        smokeTimeoutMs: params.smokeTimeoutMs,
      });
      restoredPreviousLiveState = true;
    }
    throw new LiveAdvanceError(String(error), { cause: error, restoredPreviousLiveState });
  }
}

export async function startLiveRuntime(
  params: StartRuntimeParams = {},
): Promise<LiveStatusSnapshot> {
  const deps = withDeps(params.deps);
  const actor = resolveActor(params.actor);
  const { stateDir } = await ensureManifest(params);
  return await withActorLock(stateDir, { actor, operation: "start" }, async () => {
    const statusBefore = await collectLiveStatus({ ...params, deps });
    assertSafeLiveCheckoutForRestart(statusBefore);
    await deps.restartRuntime();
    const runtimeState = await smokeCheckRuntime(
      deps,
      params.smokeTimeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS,
      statusBefore.manifest.liveCheckoutPath,
    );
    await updateManifestRuntimeState(stateDir, statusBefore.manifest, {
      ...runtimeState,
      now: formatIso(deps.now()),
    });
    await appendJournalEntry(stateDir, {
      id: `start-${Date.now()}`,
      ts: formatIso(deps.now()),
      actor,
      type: "runtime_started",
      message: `Restarted live runtime for ${statusBefore.manifest.liveCheckoutPath}`,
      details: {
        loadedCommit: runtimeState.loadedCommit,
        pid: runtimeState.pid,
        promotedCommit: statusBefore.manifest.promotedCommit,
      },
    });
    return await collectLiveStatus({ ...params, deps });
  });
}

function draftNameStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

export async function createDraftWorktree(params: CreateDraftParams): Promise<{
  branch: string;
  manifest: LiveManifest;
  path: string;
}> {
  const deps = withDeps(params.deps);
  const actor = resolveActor(params.actor);
  const { manifest, stateDir } = await ensureManifest(params);
  return await withActorLock(stateDir, { actor, operation: "draft" }, async () => {
    const status = await collectLiveStatus({ ...params, deps });
    assertSafeLiveLane(status);
    const slug = slugifyDraftName(params.name);
    const stamp = draftNameStamp(deps.now());
    const branch = `draft/${slug}-${stamp}`;
    const draftPath = path.join(
      resolveDraftsRoot(stateDir),
      `${path.basename(manifest.liveCheckoutPath)}-${slug}-${stamp}`,
    );
    await ensureDir(resolveDraftsRoot(stateDir));
    const result = await deps.runCommand(
      [
        "git",
        "-C",
        manifest.liveCheckoutPath,
        "worktree",
        "add",
        "-b",
        branch,
        draftPath,
        manifest.liveBranch,
      ],
      {
        cwd: manifest.liveCheckoutPath,
        timeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
      },
    );
    if (result.code !== 0) {
      throw new Error(
        `Failed to create draft worktree: ${trimCommandFailure(result.stderr || result.stdout)}`,
      );
    }
    await appendJournalEntry(stateDir, {
      id: `draft-${Date.now()}`,
      ts: formatIso(deps.now()),
      actor,
      type: "draft_created",
      message: `Created draft worktree ${branch}`,
      details: {
        baseCommit: status.liveGit.head,
        branch,
        draftPath,
        note: params.message?.trim() || "",
      },
    });
    return { branch, manifest, path: draftPath };
  });
}

async function restoreLiveCheckoutCommit(params: {
  commit: string;
  deps: LiveControlDeps;
  liveCheckoutPath: string;
  buildTimeoutMs: number;
  installDeps?: boolean;
  smokeTimeoutMs: number;
}): Promise<void> {
  const resetResult = await params.deps.runCommand(
    ["git", "-C", params.liveCheckoutPath, "reset", "--hard", params.commit],
    {
      cwd: params.liveCheckoutPath,
      timeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
    },
  );
  if (resetResult.code !== 0) {
    throw new Error(
      `Failed to reset live checkout: ${trimCommandFailure(resetResult.stderr || resetResult.stdout)}`,
    );
  }
  if (params.installDeps) {
    await installCheckoutDependencies(params.liveCheckoutPath, params.deps);
  }
  await params.deps.buildCheckout(params.liveCheckoutPath, params.buildTimeoutMs);
  await params.deps.restartRuntime();
  await smokeCheckRuntime(params.deps, params.smokeTimeoutMs, params.liveCheckoutPath);
}

async function updateManifestPromotion(
  stateDir: string,
  manifest: LiveManifest,
  params: { currentCommit: string; previousCommit: string; now: string },
): Promise<LiveManifest> {
  const next: LiveManifest = {
    ...manifest,
    previousPromotedCommit: params.previousCommit,
    promotedCommit: params.currentCommit,
    updatedAt: params.now,
  };
  await saveManifest(stateDir, next);
  return next;
}

async function updateManifestRuntimeState(
  stateDir: string,
  manifest: LiveManifest,
  params: CapturedRuntimeState & { now: string },
): Promise<LiveManifest> {
  const next: LiveManifest = {
    ...manifest,
    updatedAt: params.now,
    runtimeState: {
      sourcePath: params.sourcePath,
      loadedCommit: params.loadedCommit,
      loadedAt: params.loadedAt,
      pid: params.pid,
    },
  };
  await saveManifest(stateDir, next);
  return next;
}

export async function promoteLiveSource(params: PromoteParams = {}): Promise<{
  manifest: LiveManifest;
  restoredPreviousLiveState: boolean;
  sourceRoot: string;
}> {
  const deps = withDeps(params.deps);
  const actor = resolveActor(params.actor);
  const buildTimeoutMs = params.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  const smokeTimeoutMs = params.smokeTimeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS;
  const { manifest, stateDir } = await ensureManifest(params);
  return await withActorLock(stateDir, { actor, operation: "promote" }, async () => {
    const statusBefore = await collectLiveStatus({ ...params, deps });
    assertSafeLiveLane(statusBefore);
    const sourceArg = params.source?.trim() || "current";
    if (sourceArg === "rollback") {
      if (!manifest.previousPromotedCommit) {
        throw new Error("No previous promoted commit is recorded for rollback.");
      }
      await restoreLiveCheckoutCommit({
        buildTimeoutMs,
        commit: manifest.previousPromotedCommit,
        deps,
        liveCheckoutPath: manifest.liveCheckoutPath,
        smokeTimeoutMs,
      });
      const now = formatIso(deps.now());
      const runtimeState = await smokeCheckRuntime(deps, smokeTimeoutMs, manifest.liveCheckoutPath);
      const withRuntimeState = await updateManifestRuntimeState(stateDir, manifest, {
        ...runtimeState,
        now,
      });
      const next = await updateManifestPromotion(stateDir, withRuntimeState, {
        currentCommit: manifest.previousPromotedCommit,
        previousCommit: statusBefore.liveGit.head,
        now,
      });
      await appendJournalEntry(stateDir, {
        id: `rollback-${Date.now()}`,
        ts: now,
        actor,
        type: "rolled_back",
        message: `Rolled back live checkout to ${manifest.previousPromotedCommit.slice(0, 7)}`,
        details: {
          fromCommit: statusBefore.liveGit.head,
          loadedCommit: runtimeState.loadedCommit,
          pid: runtimeState.pid,
          toCommit: manifest.previousPromotedCommit,
        },
      });
      return {
        manifest: next,
        restoredPreviousLiveState: true,
        sourceRoot: manifest.liveCheckoutPath,
      };
    }

    const sourceCheckoutHint =
      sourceArg === "current" ? (params.cwd ?? process.cwd()) : path.resolve(sourceArg);
    const sourceRoot =
      (await resolveGitRoot(sourceCheckoutHint, deps)) ??
      (sourceArg === "current" ? manifest.liveCheckoutPath : null);
    if (!sourceRoot) {
      throw new Error(`Could not resolve a draft checkout from ${sourceArg}.`);
    }

    const [sourceGit, liveGit] = await Promise.all([
      readGitState(sourceRoot, deps),
      readGitState(manifest.liveCheckoutPath, deps),
    ]);
    if (sourceGit.commonDir !== liveGit.commonDir) {
      throw new Error(
        "Draft checkout does not belong to the same git worktree family as the live checkout.",
      );
    }
    if (sourceGit.dirty) {
      throw new Error(
        "Draft checkout is dirty. Commit or stash changes before promoting live state.",
      );
    }

    const oldLiveHead = liveGit.head;
    try {
      const advance = await advanceLiveCheckout({
        buildTimeoutMs,
        deps,
        installDeps: false,
        liveCheckoutPath: manifest.liveCheckoutPath,
        smokeTimeoutMs,
        targetCommit: sourceGit.head,
      });
      const now = formatIso(deps.now());
      const withRuntimeState = await updateManifestRuntimeState(stateDir, manifest, {
        ...advance.runtimeState,
        now,
      });
      const next = await updateManifestPromotion(stateDir, withRuntimeState, {
        currentCommit: sourceGit.head,
        previousCommit: oldLiveHead,
        now,
      });
      await appendJournalEntry(stateDir, {
        id: `promote-${Date.now()}`,
        ts: now,
        actor,
        type: "promoted",
        message: `Promoted ${sourceGit.head.slice(0, 7)} into live state`,
        details: {
          fromCommit: oldLiveHead,
          loadedCommit: advance.runtimeState.loadedCommit,
          pid: advance.runtimeState.pid,
          sourceCommit: sourceGit.head,
          sourceRoot,
        },
      });
      return {
        manifest: next,
        restoredPreviousLiveState: false,
        sourceRoot,
      };
    } catch (error) {
      const restoredPreviousLiveState =
        error instanceof LiveAdvanceError ? error.restoredPreviousLiveState : false;
      await appendJournalEntry(stateDir, {
        id: `promote-failed-${Date.now()}`,
        ts: formatIso(deps.now()),
        actor,
        type: "promotion_failed",
        message: restoredPreviousLiveState
          ? `Promotion from ${sourceRoot} failed. Previous live state restored.`
          : `Promotion from ${sourceRoot} failed before live state changed.`,
        details: {
          error: String(error),
          sourceCommit: sourceGit.head,
          sourceRoot,
        },
      });
      throw error;
    }
  });
}

export async function listLiveJournal(
  params: ResolveManifestParams & { limit?: number } = {},
): Promise<{
  entries: LiveJournalEntry[];
  manifest: LiveManifest;
}> {
  const { manifest, stateDir } = await ensureManifest(params);
  return {
    entries: await readJournalEntries(stateDir, params.limit ?? DEFAULT_JOURNAL_LIMIT),
    manifest,
  };
}

export async function collectLiveSyncStatus(params: SyncParams = {}): Promise<LiveSyncStatus> {
  const deps = withDeps(params.deps);
  const status = await collectLiveStatus({ ...params, deps });
  const collector = createBlockerCollector();
  const hasPromotedCommitDrift = status.issues.some(
    (issue) => issue.code === "promoted-commit-drift",
  );

  for (const issue of status.issues) {
    if (
      issue.code === "branch-drift" ||
      issue.code === "dirty-live-checkout" ||
      issue.code === "runtime-commit-drift" ||
      issue.code === "runtime-source-mismatch"
    ) {
      collector.add({ code: issue.code, message: issue.message });
    }
  }

  if (status.actorLock && status.actorLock.pid !== process.pid) {
    collector.add({
      code: "busy",
      message: `Live control is busy: ${status.actorLock.operation} by ${status.actorLock.actor} (pid ${status.actorLock.pid}).`,
    });
  }
  if (status.manifest.liveBranch !== "main" || status.liveGit.branch !== "main") {
    collector.add({
      code: "live-branch-not-main",
      message: "Fork-backed live sync requires the live checkout to stay on main.",
    });
  }
  if (status.drafts.length > 0) {
    collector.add({
      code: "drafts-present",
      message: "Close or promote draft worktrees before applying fork sync updates to live main.",
    });
  }
  if (status.runtime.matchesLiveCheckout !== true) {
    collector.add({
      code:
        status.runtime.matchesLiveCheckout === false
          ? "runtime-source-mismatch"
          : "runtime-source-unverified",
      message:
        status.runtime.matchesLiveCheckout === false
          ? `Gateway runtime source ${status.runtime.sourcePath ?? "unknown"} does not match live checkout ${status.manifest.liveCheckoutPath}.`
          : "Cannot verify that the running gateway matches the live checkout. Start the live runtime first.",
    });
  } else if (status.runtime.matchesLiveCommit !== true) {
    collector.add({
      code:
        status.runtime.matchesLiveCommit === false
          ? "runtime-commit-drift"
          : "runtime-source-unverified",
      message:
        status.runtime.matchesLiveCommit === false
          ? `Gateway runtime loaded commit ${status.runtime.loadedCommit?.slice(0, 7) ?? "unknown"} does not match live HEAD ${status.liveGit.head.slice(0, 7)}. Restart the live runtime first.`
          : "Cannot verify that the running gateway loaded commit matches live HEAD. Restart the live runtime first.",
    });
  }

  const fetchOk =
    params.fetchOrigin === false
      ? true
      : await fetchRemoteRef(status.manifest.liveCheckoutPath, "origin", deps);
  if (!fetchOk) {
    collector.add({
      code: "origin-fetch-failed",
      message: "Could not fetch origin/main. Check git remote access before syncing live main.",
    });
  }

  const [originUrl, upstreamUrl, originMainSha] = await Promise.all([
    resolveGitRemoteUrl(status.manifest.liveCheckoutPath, "origin", deps),
    resolveGitRemoteUrl(status.manifest.liveCheckoutPath, "upstream", deps),
    resolveGitRef(status.manifest.liveCheckoutPath, "origin/main", deps),
  ]);

  if (!originMainSha) {
    collector.add({
      code: "origin-main-missing",
      message:
        "origin/main is not available in this checkout. Fetch the fork remote before syncing.",
    });
  }

  if (!originUrl || !upstreamUrl) {
    collector.add({
      code: "fork-remote-misconfigured",
      message: "Fork-backed live sync requires both origin and upstream remotes.",
    });
  } else if (normalizeRemoteUrl(originUrl) === normalizeRemoteUrl(upstreamUrl)) {
    collector.add({
      code: "fork-remote-misconfigured",
      message:
        "origin and upstream point at the same repository. Configure your fork as origin and openclaw/openclaw as upstream.",
    });
  }

  const counts =
    originMainSha && fetchOk
      ? await resolveAheadBehindCounts(
          status.manifest.liveCheckoutPath,
          "HEAD",
          "origin/main",
          deps,
        )
      : { ahead: null, behind: null };
  if ((counts.ahead ?? 0) > 0 && (counts.behind ?? 0) > 0) {
    collector.add({
      code: "sync-diverged",
      message: `Live main diverged from origin/main (ahead ${counts.ahead}, behind ${counts.behind}). Reconcile the fork before syncing.`,
    });
  } else if ((counts.ahead ?? 0) > 0) {
    collector.add({
      code: "sync-diverged",
      message: `Live main is ahead of origin/main by ${counts.ahead}. Push or reconcile those commits before syncing.`,
    });
  }

  const lockfileChanged =
    originMainSha && fetchOk && (counts.behind ?? 0) > 0
      ? await detectLockfileChange(status.manifest.liveCheckoutPath, "HEAD", "origin/main", deps)
      : false;

  const promotedCommitDriftCanBeReconciled =
    hasPromotedCommitDrift &&
    status.runtime.matchesLiveCheckout !== false &&
    Boolean(originMainSha) &&
    status.liveGit.head === originMainSha &&
    (counts.ahead ?? 0) === 0 &&
    (counts.behind ?? 0) === 0;

  if (hasPromotedCommitDrift && !promotedCommitDriftCanBeReconciled) {
    const issue = status.issues.find((entry) => entry.code === "promoted-commit-drift");
    collector.add({
      code: "promoted-commit-drift",
      message:
        issue?.message ??
        `Live HEAD ${status.liveGit.head.slice(0, 7)} no longer matches promoted commit ${status.manifest.promotedCommit?.slice(0, 7) ?? "none"}.`,
    });
  }

  const blockers = collector.list();

  return {
    liveCheckoutPath: status.manifest.liveCheckoutPath,
    liveSha: status.liveGit.head,
    originMainSha,
    behindBy: counts.behind,
    safeToApply: blockers.length === 0,
    blockers,
    runtimeMatchesLive:
      status.runtime.matchesLiveCheckout === true
        ? status.runtime.matchesLiveCommit
        : status.runtime.matchesLiveCheckout,
    runtimeLoadedCommit: status.runtime.loadedCommit,
    draftCount: status.drafts.length,
    lockfileChanged,
  };
}

export async function syncLiveCheckout(params: SyncParams = {}): Promise<{
  applied: boolean;
  status: LiveSyncStatus;
}> {
  const deps = withDeps(params.deps);
  const actor = resolveActor(params.actor);
  const buildTimeoutMs = params.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  const smokeTimeoutMs = params.smokeTimeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS;
  const { manifest, stateDir } = await ensureManifest(params);
  return await withActorLock(stateDir, { actor, operation: "sync" }, async () => {
    const statusBefore = await collectLiveSyncStatus({ ...params, deps, fetchOrigin: true });
    if (!statusBefore.originMainSha) {
      throw new Error("origin/main is unavailable for live sync.");
    }
    const canReconcilePromotionOnly =
      (statusBefore.behindBy ?? 0) === 0 &&
      Boolean(manifest.promotedCommit) &&
      manifest.promotedCommit !== statusBefore.liveSha &&
      statusBefore.liveSha === statusBefore.originMainSha;
    const metadataOnlyRuntimeBlockers = statusBefore.blockers.filter(
      (blocker) =>
        blocker.code === "runtime-commit-drift" || blocker.code === "runtime-source-unverified",
    );
    const otherBlockers = statusBefore.blockers.filter(
      (blocker) =>
        blocker.code !== "runtime-commit-drift" && blocker.code !== "runtime-source-unverified",
    );
    if ((statusBefore.behindBy ?? 0) === 0) {
      if (canReconcilePromotionOnly) {
        const now = formatIso(deps.now());
        if (otherBlockers.length > 0) {
          throw new Error(otherBlockers.map((blocker) => blocker.message).join(" "));
        }
        const runtimeState =
          metadataOnlyRuntimeBlockers.length > 0
            ? await (async () => {
                await deps.restartRuntime();
                return await smokeCheckRuntime(deps, smokeTimeoutMs, manifest.liveCheckoutPath);
              })()
            : null;
        const withRuntimeState =
          runtimeState == null
            ? manifest
            : await updateManifestRuntimeState(stateDir, manifest, {
                ...runtimeState,
                now,
              });
        await updateManifestPromotion(stateDir, withRuntimeState, {
          currentCommit: statusBefore.liveSha,
          previousCommit: manifest.promotedCommit ?? statusBefore.liveSha,
          now,
        });
        await appendJournalEntry(stateDir, {
          id: `sync-${Date.now()}`,
          ts: now,
          actor,
          type: "synced",
          message: `Reconciled live promotion metadata at ${statusBefore.liveSha.slice(0, 7)}`,
          details: {
            fromCommit: manifest.promotedCommit,
            lockfileChanged: false,
            metadataOnly: true,
            runtimeRestarted: runtimeState != null,
            runtimeLoadedCommit: runtimeState?.loadedCommit,
            runtimePid: runtimeState?.pid,
            toCommit: statusBefore.liveSha,
          },
        });
        return {
          applied: true,
          status: await collectLiveSyncStatus({ ...params, deps, fetchOrigin: false }),
        };
      }
      return {
        applied: false,
        status: statusBefore,
      };
    }
    if (statusBefore.blockers.length > 0) {
      throw new Error(statusBefore.blockers.map((blocker) => blocker.message).join(" "));
    }

    try {
      const advance = await advanceLiveCheckout({
        buildTimeoutMs,
        deps,
        installDeps: statusBefore.lockfileChanged,
        liveCheckoutPath: manifest.liveCheckoutPath,
        smokeTimeoutMs,
        targetCommit: statusBefore.originMainSha,
      });
      const now = formatIso(deps.now());
      const withRuntimeState = await updateManifestRuntimeState(stateDir, manifest, {
        ...advance.runtimeState,
        now,
      });
      await updateManifestPromotion(stateDir, withRuntimeState, {
        currentCommit: statusBefore.originMainSha,
        previousCommit: advance.currentHead,
        now,
      });
      await appendJournalEntry(stateDir, {
        id: `sync-${Date.now()}`,
        ts: now,
        actor,
        type: "synced",
        message: `Synced live checkout to origin/main at ${statusBefore.originMainSha.slice(0, 7)}`,
        details: {
          fromCommit: advance.currentHead,
          lockfileChanged: statusBefore.lockfileChanged,
          runtimeLoadedCommit: advance.runtimeState.loadedCommit,
          runtimePid: advance.runtimeState.pid,
          toCommit: statusBefore.originMainSha,
        },
      });
    } catch (error) {
      const restoredPreviousLiveState =
        error instanceof LiveAdvanceError ? error.restoredPreviousLiveState : false;
      await appendJournalEntry(stateDir, {
        id: `sync-failed-${Date.now()}`,
        ts: formatIso(deps.now()),
        actor,
        type: "sync_failed",
        message: restoredPreviousLiveState
          ? "Live sync failed. Previous live state restored."
          : "Live sync failed before live state changed.",
        details: {
          error: String(error),
          targetCommit: statusBefore.originMainSha,
        },
      });
      throw error;
    }

    return {
      applied: true,
      status: await collectLiveSyncStatus({ ...params, deps, fetchOrigin: false }),
    };
  });
}
