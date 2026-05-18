import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { isPathInside } from "../infra/path-guards.js";

export type WorkspaceCheckpointConfig = {
  enabled?: boolean;
  maxSnapshots?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
  maxFiles?: number;
  exclude?: string[];
};

export type WorkspaceCheckpointManagerOptions = WorkspaceCheckpointConfig & {
  stateDir?: string;
  storeRoot?: string;
};

export type WorkspaceCheckpoint = {
  hash: string;
  shortHash: string;
  ref: string;
  timestamp: string;
  reason: string;
  workspaceDir: string;
};

export type WorkspaceCheckpointRestoreResult = {
  restored: boolean;
  checkpoint?: WorkspaceCheckpoint;
  preRestoreCheckpoint?: WorkspaceCheckpoint;
  filePath?: string;
};

const DEFAULT_MAX_SNAPSHOTS = 50;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 50_000;
const GIT_TIMEOUT_MS = 30_000;

const DEFAULT_EXCLUDES = [
  ".git/**",
  ".hg/**",
  ".svn/**",
  "node_modules/**",
  ".pnpm-store/**",
  ".yarn/**",
  ".turbo/**",
  ".next/**",
  ".nuxt/**",
  ".cache/**",
  "dist/**",
  "build/**",
  "coverage/**",
  "logs/**",
  "tmp/**",
  "temp/**",
  "*.log",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/auth-profiles.json",
  "**/credentials/**",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.mp4",
  "**/*.mov",
  "**/*.mkv",
  "**/*.zip",
  "**/*.tar",
  "**/*.tgz",
  "**/*.gz",
] as const;

function clampPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function resolveWorkspaceCheckpointConfig(
  config: OpenClawConfig | undefined,
  overrides?: WorkspaceCheckpointConfig,
): Required<WorkspaceCheckpointConfig> {
  const checkpoints = config?.tools?.checkpoints;
  return {
    enabled: overrides?.enabled ?? checkpoints?.enabled === true,
    maxSnapshots: clampPositiveInteger(
      overrides?.maxSnapshots ?? checkpoints?.maxSnapshots,
      DEFAULT_MAX_SNAPSHOTS,
    ),
    maxTotalBytes: clampPositiveInteger(
      overrides?.maxTotalBytes ?? checkpoints?.maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
    ),
    maxFileBytes: clampPositiveInteger(
      overrides?.maxFileBytes ?? checkpoints?.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
    ),
    maxFiles: clampPositiveInteger(overrides?.maxFiles ?? checkpoints?.maxFiles, DEFAULT_MAX_FILES),
    exclude: [...DEFAULT_EXCLUDES, ...(checkpoints?.exclude ?? []), ...(overrides?.exclude ?? [])],
  };
}

function workspaceKey(workspaceDir: string): string {
  return crypto.createHash("sha256").update(path.resolve(workspaceDir)).digest("hex").slice(0, 16);
}

function snapshotId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const suffix = crypto.randomBytes(4).toString("hex");
  return `${stamp}-${suffix}`;
}

function normalizeReason(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed ? trimmed.slice(0, 200) : "manual";
}

function parseCommitBody(body: string): { reason: string; workspaceDir: string } {
  const reason = /^reason: (.*)$/m.exec(body)?.[1]?.trim() || "unknown";
  const workspaceDir = /^workspace: (.*)$/m.exec(body)?.[1]?.trim() || "";
  return { reason, workspaceDir };
}

function isBroadWorkspaceDir(workspaceDir: string): boolean {
  const resolved = path.resolve(workspaceDir);
  const home = path.resolve(os.homedir());
  return resolved === path.parse(resolved).root || resolved === home;
}

function toGitPathspecExcludes(patterns: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern || seen.has(pattern)) {
      continue;
    }
    seen.add(pattern);
    out.push(`:(exclude)${pattern}`);
  }
  return out;
}

function toGitLiteralPathspecExclude(relativePath: string): string {
  return `:(exclude,literal)${relativePath}`;
}

function splitNul(raw: string): string[] {
  return raw.split("\0").filter(Boolean);
}

type ExcludeMatcher = (relativePath: string, isDirectory: boolean) => boolean;

function escapeRegexChar(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += escapeRegexChar(char);
  }
  return new RegExp(`^${source}$`);
}

function createExcludeMatcher(rawPattern: string): ExcludeMatcher | undefined {
  const pattern = rawPattern
    .trim()
    .replace(/^:\(exclude\)/, "")
    .replace(/^\.\//, "");
  if (!pattern) {
    return undefined;
  }
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3).replace(/\/$/, "");
    if (base.startsWith("**/")) {
      const suffix = base.slice(3);
      return (relativePath) =>
        relativePath === suffix ||
        relativePath.startsWith(`${suffix}/`) ||
        relativePath.endsWith(`/${suffix}`) ||
        relativePath.includes(`/${suffix}/`);
    }
    return (relativePath) => relativePath === base || relativePath.startsWith(`${base}/`);
  }
  if (pattern.startsWith("**/")) {
    const fullRegex = globToRegExp(pattern);
    const rootRegex = globToRegExp(pattern.slice(3));
    return (relativePath, isDirectory) =>
      fullRegex.test(relativePath) ||
      rootRegex.test(relativePath) ||
      (isDirectory && (fullRegex.test(`${relativePath}/`) || rootRegex.test(`${relativePath}/`)));
  }
  const regex = globToRegExp(pattern);
  const basenameRegex = pattern.includes("/") ? undefined : globToRegExp(pattern);
  return (relativePath, isDirectory) =>
    regex.test(relativePath) ||
    (basenameRegex ? basenameRegex.test(path.basename(relativePath)) : false) ||
    (isDirectory && regex.test(`${relativePath}/`));
}

function createExcludeMatchers(patterns: readonly string[]): ExcludeMatcher[] {
  return patterns
    .map(createExcludeMatcher)
    .filter((matcher): matcher is ExcludeMatcher => Boolean(matcher));
}

function isExcluded(
  relativePath: string,
  isDirectory: boolean,
  matchers: readonly ExcludeMatcher[],
): boolean {
  return matchers.some((matcher) => matcher(relativePath, isDirectory));
}

function isPathDescendantOf(relativePath: string, parentPath: string): boolean {
  return relativePath.startsWith(`${parentPath.replace(/\/$/, "")}/`);
}

function hasPathDescendant(paths: ReadonlySet<string>, parentPath: string): boolean {
  for (const candidate of paths) {
    if (isPathDescendantOf(candidate, parentPath)) {
      return true;
    }
  }
  return false;
}

async function runProcess(
  file: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    allowNonZero?: boolean;
    maxBuffer?: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxBuffer = options?.maxBuffer ?? 2 * 1024 * 1024;
    let outputBytes = 0;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${file} ${args.join(" ")} timed out`));
    }, GIT_TIMEOUT_MS);

    const append = (chunks: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxBuffer) {
        child.kill("SIGTERM");
        reject(new Error(`${file} ${args.join(" ")} exceeded output limit`));
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0 || options?.allowNonZero) {
        resolve(result);
        return;
      }
      const error = new Error(
        `${file} ${args.join(" ")} failed with exit code ${code}: ${result.stderr.trim()}`,
      );
      reject(error);
    });
    if (options?.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function dirSize(root: string): Promise<number> {
  let total = 0;
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const stat = await fs.lstat(full).catch(() => null);
      if (stat) {
        total += stat.size;
      }
    }
  }
  await walk(root);
  return total;
}

async function countWorkspaceFiles(params: {
  workspaceDir: string;
  maxFiles: number;
  excludeMatchers: readonly ExcludeMatcher[];
}): Promise<number> {
  let count = 0;
  async function walk(dir: string): Promise<void> {
    if (count > params.maxFiles) {
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (count > params.maxFiles) {
        return;
      }
      const relative = path
        .relative(params.workspaceDir, path.join(dir, entry.name))
        .replaceAll(path.sep, "/");
      if (entry.isDirectory()) {
        if (isExcluded(relative, true, params.excludeMatchers)) {
          continue;
        }
        await walk(path.join(dir, entry.name));
        continue;
      }
      if (isExcluded(relative, false, params.excludeMatchers)) {
        continue;
      }
      count += 1;
    }
  }
  await walk(params.workspaceDir);
  return count;
}

async function listOversizedWorkspaceFiles(params: {
  workspaceDir: string;
  maxFileBytes: number;
  excludeMatchers: readonly ExcludeMatcher[];
}): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(params.workspaceDir, full).replaceAll(path.sep, "/");
      if (entry.isDirectory()) {
        if (!isExcluded(relative, true, params.excludeMatchers)) {
          await walk(full);
        }
        continue;
      }
      if (isExcluded(relative, false, params.excludeMatchers)) {
        continue;
      }
      const stat = await fs.lstat(full).catch(() => null);
      if (stat?.isFile() && stat.size > params.maxFileBytes) {
        out.push(relative);
      }
    }
  }
  await walk(params.workspaceDir);
  return out;
}

export class WorkspaceCheckpointManager {
  readonly enabled: boolean;
  readonly maxSnapshots: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly excludes: readonly string[];
  readonly rootDir: string;
  readonly storeDir: string;
  readonly indexesDir: string;
  readonly projectsDir: string;
  private checkpointPromisesThisTurn = new Map<string, Promise<WorkspaceCheckpoint | undefined>>();

  constructor(options: WorkspaceCheckpointManagerOptions = {}) {
    const stateDir = options.stateDir ?? resolveStateDir();
    this.rootDir = options.storeRoot ?? path.join(stateDir, "checkpoints");
    this.storeDir = path.join(this.rootDir, "store.git");
    this.indexesDir = path.join(this.rootDir, "indexes");
    this.projectsDir = path.join(this.rootDir, "projects");
    this.enabled = options.enabled === true;
    this.maxSnapshots = clampPositiveInteger(options.maxSnapshots, DEFAULT_MAX_SNAPSHOTS);
    this.maxTotalBytes = clampPositiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
    this.maxFileBytes = clampPositiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
    this.maxFiles = clampPositiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
    this.excludes = [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])];
  }

  newTurn(): void {
    this.checkpointPromisesThisTurn.clear();
  }

  async ensureCheckpoint(
    workspaceDir: string,
    reason = "auto",
  ): Promise<WorkspaceCheckpoint | undefined> {
    if (!this.enabled) {
      return undefined;
    }
    const resolved = path.resolve(workspaceDir);
    const existing = this.checkpointPromisesThisTurn.get(resolved);
    if (existing) {
      await existing;
      return undefined;
    }
    const checkpointPromise = this.createCheckpoint(resolved, reason).catch(() => undefined);
    this.checkpointPromisesThisTurn.set(resolved, checkpointPromise);
    return await checkpointPromise;
  }

  async createCheckpoint(
    workspaceDir: string,
    reason = "manual",
  ): Promise<WorkspaceCheckpoint | undefined> {
    const resolved = path.resolve(workspaceDir);
    if (isBroadWorkspaceDir(resolved) || !(await pathExists(resolved))) {
      return undefined;
    }
    const stat = await fs.lstat(resolved).catch(() => null);
    if (!stat?.isDirectory()) {
      return undefined;
    }
    if (!(await this.hasGit())) {
      return undefined;
    }
    const fileCount = await countWorkspaceFiles({
      workspaceDir: resolved,
      maxFiles: this.maxFiles,
      excludeMatchers: createExcludeMatchers(this.excludes),
    });
    if (fileCount > this.maxFiles) {
      return undefined;
    }

    await this.ensureStore();
    await this.prepareIndex(resolved);
    await this.stageWorkspaceSnapshot(resolved);
    const tree = (await this.git(resolved, ["write-tree"])).stdout.trim();
    const latest = await this.latestHash(resolved);
    if (latest) {
      const latestTree = (
        await this.git(resolved, ["show", "-s", "--format=%T", latest])
      ).stdout.trim();
      if (latestTree === tree) {
        await this.resetIndexToCheckpoint(resolved, latest);
        return undefined;
      }
    }

    const id = snapshotId();
    const reasonText = normalizeReason(reason);
    const message = `OpenClaw workspace checkpoint\n\nreason: ${reasonText}\nworkspace: ${resolved}\ncreatedAt: ${new Date().toISOString()}\n`;
    const commit = (
      await this.git(resolved, ["commit-tree", tree], { input: message })
    ).stdout.trim();
    const key = workspaceKey(resolved);
    const ref = `refs/openclaw/checkpoints/${key}/${id}`;
    await this.git(resolved, ["update-ref", ref, commit]);
    await this.git(resolved, ["update-ref", this.latestRef(resolved), commit]);
    await this.writeProjectMetadata(resolved);
    await this.prune(resolved);
    await this.resetIndexToCheckpoint(resolved, commit);
    return await this.checkpointFromHash(resolved, commit, ref);
  }

  async listCheckpoints(workspaceDir: string): Promise<WorkspaceCheckpoint[]> {
    const resolved = path.resolve(workspaceDir);
    if (!(await pathExists(this.storeDir))) {
      return [];
    }
    const key = workspaceKey(resolved);
    const prefix = `refs/openclaw/checkpoints/${key}/`;
    const refs = (
      await this.git(resolved, [
        "for-each-ref",
        "--sort=-creatordate",
        "--format=%(objectname)%00%(creatordate:iso8601-strict)%00%(refname)",
        prefix,
      ])
    ).stdout;
    const parts = splitNul(refs.replaceAll("\n", "\0"));
    const out: WorkspaceCheckpoint[] = [];
    for (let i = 0; i + 2 < parts.length; i += 3) {
      const hash = parts[i];
      const timestamp = parts[i + 1];
      const ref = parts[i + 2];
      const checkpoint = await this.checkpointFromHash(resolved, hash, ref, timestamp);
      if (checkpoint) {
        out.push(checkpoint);
      }
    }
    return out;
  }

  async diff(workspaceDir: string, checkpointRef: string): Promise<{ stat: string; diff: string }> {
    const resolved = path.resolve(workspaceDir);
    const hash = await this.resolveCheckpointHash(resolved, checkpointRef);
    await this.prepareIndex(resolved);
    await this.stageWorkspaceSnapshot(resolved);
    const stat = (
      await this.git(resolved, ["diff", "--cached", "--stat", hash, "--"], {
        allowNonZero: true,
      })
    ).stdout.trim();
    const diff = (
      await this.git(
        resolved,
        [
          "diff",
          "--cached",
          "--no-ext-diff",
          "--src-prefix=checkpoint/",
          "--dst-prefix=current/",
          hash,
          "--",
        ],
        { allowNonZero: true, maxBuffer: 8 * 1024 * 1024 },
      )
    ).stdout.trim();
    await this.resetIndexToCheckpoint(resolved, await this.latestHash(resolved));
    return { stat, diff };
  }

  async restore(
    workspaceDir: string,
    checkpointRef: string,
    filePath?: string,
  ): Promise<WorkspaceCheckpointRestoreResult> {
    const resolved = path.resolve(workspaceDir);
    const hash = await this.resolveCheckpointHash(resolved, checkpointRef);
    const checkpoint = await this.checkpointFromHash(resolved, hash, "");
    const restoreRelativePath = filePath?.trim()
      ? this.resolveRestorePath(resolved, filePath)
      : undefined;
    if (restoreRelativePath && this.matchesExcludedPath(restoreRelativePath)) {
      throw new Error(`restore path is excluded from checkpoints: ${restoreRelativePath}`);
    }
    const preRestoreCheckpoint = await this.createCheckpoint(
      resolved,
      `pre-restore:${hash.slice(0, 12)}`,
    );
    await this.prepareIndex(resolved);
    await this.stageWorkspaceSnapshot(resolved);

    if (restoreRelativePath) {
      const relative = restoreRelativePath;
      const checkpointFiles = new Set(await this.commitFileList(resolved, hash));
      const checkpointHasDescendants = hasPathDescendant(checkpointFiles, relative);
      const checkpointHasPath = checkpointFiles.has(relative) || checkpointHasDescendants;
      if (checkpointHasDescendants) {
        const targetStat = await fs.lstat(path.join(resolved, relative)).catch(() => null);
        if (targetStat && !targetStat.isDirectory()) {
          await fs.rm(path.join(resolved, relative), { force: true, recursive: true });
        }
        const currentFiles = await this.indexFileList(resolved);
        for (const currentFile of currentFiles) {
          if (isPathDescendantOf(currentFile, relative) && !checkpointFiles.has(currentFile)) {
            await fs.rm(path.join(resolved, currentFile), { force: true, recursive: true });
          }
        }
      }
      if (checkpointHasPath) {
        await this.removeFileDirectoryConflicts(resolved, checkpointFiles, relative);
        if (checkpointFiles.has(relative)) {
          const currentStat = await fs.lstat(path.join(resolved, relative)).catch(() => null);
          if (currentStat?.isDirectory()) {
            await fs.rm(path.join(resolved, relative), { force: true, recursive: true });
          }
        }
        await this.git(resolved, ["checkout", "-f", hash, "--", relative]);
      } else {
        await fs.rm(path.join(resolved, relative), { force: true, recursive: true });
      }
      await this.resetIndexToCheckpoint(resolved, await this.latestHash(resolved));
      return { restored: true, checkpoint, preRestoreCheckpoint, filePath: relative };
    }

    const currentFiles = new Set(await this.indexFileList(resolved));
    const checkpointFiles = new Set(await this.commitFileList(resolved, hash));
    for (const relative of currentFiles) {
      if (!checkpointFiles.has(relative)) {
        await fs.rm(path.join(resolved, relative), { force: true, recursive: true });
      }
    }
    await this.removeFileDirectoryConflicts(resolved, checkpointFiles);
    if (checkpointFiles.size > 0) {
      await this.git(resolved, ["checkout", "-f", hash, "--", "."]);
    }
    await this.resetIndexToCheckpoint(resolved, await this.latestHash(resolved));
    return { restored: true, checkpoint, preRestoreCheckpoint };
  }

  private async hasGit(): Promise<boolean> {
    try {
      await runProcess("git", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  private gitEnv(workspaceDir: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      GIT_DIR: this.storeDir,
      GIT_WORK_TREE: workspaceDir,
      GIT_INDEX_FILE: path.join(this.indexesDir, `${workspaceKey(workspaceDir)}.index`),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: "OpenClaw Checkpoints",
      GIT_AUTHOR_EMAIL: "checkpoints@openclaw.local",
      GIT_COMMITTER_NAME: "OpenClaw Checkpoints",
      GIT_COMMITTER_EMAIL: "checkpoints@openclaw.local",
    };
    return env;
  }

  private async git(
    workspaceDir: string,
    args: string[],
    options?: { input?: string; allowNonZero?: boolean; maxBuffer?: number },
  ): Promise<{ stdout: string; stderr: string }> {
    return await runProcess("git", args, {
      cwd: workspaceDir,
      env: this.gitEnv(workspaceDir),
      input: options?.input,
      allowNonZero: options?.allowNonZero,
      maxBuffer: options?.maxBuffer,
    });
  }

  private async ensureStore(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.indexesDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.projectsDir, { recursive: true, mode: 0o700 });
    if (!(await pathExists(this.storeDir))) {
      await runProcess("git", ["init", "--bare", this.storeDir]);
    }
  }

  private latestRef(workspaceDir: string): string {
    return `refs/openclaw/latest/${workspaceKey(workspaceDir)}`;
  }

  private async latestHash(workspaceDir: string): Promise<string | undefined> {
    try {
      const result = await this.git(workspaceDir, [
        "rev-parse",
        "--verify",
        this.latestRef(workspaceDir),
      ]);
      return result.stdout.trim();
    } catch {
      return undefined;
    }
  }

  private async prepareIndex(workspaceDir: string): Promise<void> {
    await this.ensureStore();
    const latest = await this.latestHash(workspaceDir);
    if (latest) {
      await this.git(workspaceDir, ["read-tree", latest]);
      return;
    }
    const indexPath = path.join(this.indexesDir, `${workspaceKey(workspaceDir)}.index`);
    await fs.rm(indexPath, { force: true });
  }

  private async resetIndexToCheckpoint(
    workspaceDir: string,
    checkpointHash: string | undefined,
  ): Promise<void> {
    if (checkpointHash) {
      await this.git(workspaceDir, ["read-tree", checkpointHash]).catch(() => undefined);
      return;
    }
    await fs.rm(path.join(this.indexesDir, `${workspaceKey(workspaceDir)}.index`), { force: true });
  }

  private async stageWorkspaceSnapshot(workspaceDir: string): Promise<void> {
    const oversizedFiles = await listOversizedWorkspaceFiles({
      workspaceDir,
      maxFileBytes: this.maxFileBytes,
      excludeMatchers: createExcludeMatchers(this.excludes),
    });
    await this.git(workspaceDir, [
      "add",
      "-A",
      "-f",
      "--",
      ".",
      ...toGitPathspecExcludes(this.excludes),
      ...oversizedFiles.map(toGitLiteralPathspecExclude),
    ]);
    for (let index = 0; index < oversizedFiles.length; index += 100) {
      const chunk = oversizedFiles.slice(index, index + 100);
      if (chunk.length > 0) {
        await this.git(workspaceDir, ["rm", "--cached", "-q", "--ignore-unmatch", "--", ...chunk]);
      }
    }
  }

  private async indexFileList(workspaceDir: string): Promise<string[]> {
    const raw = (await this.git(workspaceDir, ["ls-files", "-z"])).stdout;
    return splitNul(raw);
  }

  private async commitFileList(workspaceDir: string, hash: string): Promise<string[]> {
    const raw = (await this.git(workspaceDir, ["ls-tree", "-r", "-z", "--name-only", hash])).stdout;
    return splitNul(raw);
  }

  private async removeFileDirectoryConflicts(
    workspaceDir: string,
    checkpointFiles: ReadonlySet<string>,
    scopePath?: string,
  ): Promise<void> {
    for (const checkpointFile of checkpointFiles) {
      if (
        scopePath &&
        checkpointFile !== scopePath &&
        !isPathDescendantOf(checkpointFile, scopePath)
      ) {
        continue;
      }
      const parts = checkpointFile.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        const ancestor = parts.slice(0, index).join("/");
        const currentAncestorStat = await fs
          .lstat(path.join(workspaceDir, ancestor))
          .catch(() => null);
        if (currentAncestorStat && !currentAncestorStat.isDirectory()) {
          await fs.rm(path.join(workspaceDir, ancestor), { force: true, recursive: true });
        }
      }
      const currentStat = await fs.lstat(path.join(workspaceDir, checkpointFile)).catch(() => null);
      if (currentStat?.isDirectory()) {
        await fs.rm(path.join(workspaceDir, checkpointFile), { force: true, recursive: true });
      }
    }
  }

  private resolveRestorePath(workspaceDir: string, filePath: string): string {
    const candidate = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(workspaceDir, filePath);
    if (candidate !== workspaceDir && !isPathInside(workspaceDir, candidate)) {
      throw new Error("restore path must stay inside the checkpoint workspace");
    }
    const relative = path.relative(workspaceDir, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("restore file path must point to a file or directory inside the workspace");
    }
    return relative.replaceAll(path.sep, "/");
  }

  private matchesExcludedPath(relativePath: string): boolean {
    const matchers = createExcludeMatchers(this.excludes);
    return isExcluded(relativePath, false, matchers) || isExcluded(relativePath, true, matchers);
  }

  private async resolveCheckpointHash(
    workspaceDir: string,
    checkpointRef: string,
  ): Promise<string> {
    const trimmed = checkpointRef.trim();
    if (!trimmed) {
      throw new Error("checkpoint id is required");
    }
    if (trimmed === "latest") {
      const latest = await this.latestHash(workspaceDir);
      if (latest) {
        return latest;
      }
      throw new Error("checkpoint not found: latest");
    }
    const checkpoints = await this.listCheckpoints(workspaceDir);
    const byIndex = /^\d+$/.test(trimmed)
      ? checkpoints[Number.parseInt(trimmed, 10) - 1]
      : undefined;
    if (byIndex) {
      return byIndex.hash;
    }
    const match = checkpoints.find(
      (checkpoint) => checkpoint.hash === trimmed || checkpoint.hash.startsWith(trimmed),
    );
    if (!match) {
      throw new Error(`checkpoint not found: ${trimmed}`);
    }
    return match.hash;
  }

  private async checkpointFromHash(
    workspaceDir: string,
    hash: string,
    ref: string,
    timestamp?: string,
  ): Promise<WorkspaceCheckpoint | undefined> {
    if (!hash) {
      return undefined;
    }
    const body = (await this.git(workspaceDir, ["show", "-s", "--format=%B", hash])).stdout;
    const parsed = parseCommitBody(body);
    const time =
      timestamp ??
      (await this.git(workspaceDir, ["show", "-s", "--format=%cI", hash])).stdout.trim();
    return {
      hash,
      shortHash: hash.slice(0, 12),
      ref,
      timestamp: time,
      reason: parsed.reason,
      workspaceDir: parsed.workspaceDir || workspaceDir,
    };
  }

  private async writeProjectMetadata(workspaceDir: string): Promise<void> {
    const key = workspaceKey(workspaceDir);
    await fs.writeFile(
      path.join(this.projectsDir, `${key}.json`),
      `${JSON.stringify({ key, workspaceDir, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  }

  private async prune(workspaceDir: string): Promise<void> {
    const checkpoints = await this.listCheckpoints(workspaceDir);
    for (const checkpoint of checkpoints.slice(this.maxSnapshots)) {
      if (checkpoint.ref) {
        await this.git(workspaceDir, ["update-ref", "-d", checkpoint.ref]).catch(() => undefined);
      }
    }
    if ((await dirSize(this.rootDir).catch(() => 0)) > this.maxTotalBytes) {
      await this.git(workspaceDir, ["gc", "--prune=now", "--quiet"]).catch(() => undefined);
    }
  }
}

export function formatWorkspaceCheckpointList(checkpoints: readonly WorkspaceCheckpoint[]): string {
  if (checkpoints.length === 0) {
    return "No workspace checkpoints found.\n";
  }
  return `${checkpoints
    .map(
      (checkpoint, index) =>
        `${index + 1}. ${checkpoint.shortHash} ${checkpoint.timestamp} ${checkpoint.reason}`,
    )
    .join("\n")}\n`;
}
