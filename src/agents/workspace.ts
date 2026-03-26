import syncFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openBoundaryFile } from "../infra/boundary-file-read.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { isReservedBuildRunWorkspacePath } from "./build-runs.js";
import { resolveWorkspaceTemplateDir } from "./workspace-templates.js";

export function resolveDefaultAgentWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const home = resolveRequiredHomeDir(env, homedir);
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(home, ".openclaw", `workspace-${profile}`);
  }
  return path.join(home, ".openclaw", "workspace");
}

export const DEFAULT_AGENT_WORKSPACE_DIR = resolveDefaultAgentWorkspaceDir();
export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_CLAUDE_FILENAME = "CLAUDE.md";
export const DEFAULT_OPENCLAW_FILENAME = "OPENCLAW.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME = "USER.md";
export const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
export const DEFAULT_MEMORY_ALT_FILENAME = "memory.md";
const WORKSPACE_STATE_DIRNAME = ".openclaw";
const WORKSPACE_STATE_FILENAME = "workspace-state.json";
const WORKSPACE_STATE_VERSION = 1;

const workspaceTemplateCache = new Map<string, Promise<string>>();
let gitAvailabilityPromise: Promise<boolean> | null = null;
const MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES = 2 * 1024 * 1024;

// File content cache keyed by stable file identity to avoid stale reads.
const workspaceFileCache = new Map<string, { content: string; identity: string }>();

/**
 * Read workspace files via boundary-safe open and cache by inode/dev/size/mtime identity.
 */
type WorkspaceGuardedReadResult =
  | { ok: true; content: string }
  | { ok: false; reason: "path" | "validation" | "io"; error?: unknown };

function workspaceFileIdentity(stat: syncFs.Stats, canonicalPath: string): string {
  return `${canonicalPath}|${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

async function readWorkspaceFileWithGuards(params: {
  filePath: string;
  workspaceDir: string;
}): Promise<WorkspaceGuardedReadResult> {
  const opened = await openBoundaryFile({
    absolutePath: params.filePath,
    rootPath: params.workspaceDir,
    boundaryLabel: "workspace root",
    maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  });
  if (!opened.ok) {
    workspaceFileCache.delete(params.filePath);
    return opened;
  }

  const identity = workspaceFileIdentity(opened.stat, opened.path);
  const cached = workspaceFileCache.get(params.filePath);
  if (cached && cached.identity === identity) {
    syncFs.closeSync(opened.fd);
    return { ok: true, content: cached.content };
  }

  try {
    const content = syncFs.readFileSync(opened.fd, "utf-8");
    workspaceFileCache.set(params.filePath, { content, identity });
    return { ok: true, content };
  } catch (error) {
    workspaceFileCache.delete(params.filePath);
    return { ok: false, reason: "io", error };
  } finally {
    syncFs.closeSync(opened.fd);
  }
}

function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return content;
  }
  const start = endIndex + "\n---".length;
  let trimmed = content.slice(start);
  trimmed = trimmed.replace(/^\s+/, "");
  return trimmed;
}

async function loadTemplate(name: string): Promise<string> {
  const cached = workspaceTemplateCache.get(name);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const templateDir = await resolveWorkspaceTemplateDir();
    const templatePath = path.join(templateDir, name);
    try {
      const content = await fs.readFile(templatePath, "utf-8");
      return stripFrontMatter(content);
    } catch {
      throw new Error(
        `Missing workspace template: ${name} (${templatePath}). Ensure docs/reference/templates are packaged.`,
      );
    }
  })();

  workspaceTemplateCache.set(name, pending);
  try {
    return await pending;
  } catch (error) {
    workspaceTemplateCache.delete(name);
    throw error;
  }
}

export type WorkspaceBootstrapFileName =
  | typeof DEFAULT_AGENTS_FILENAME
  | typeof DEFAULT_CLAUDE_FILENAME
  | typeof DEFAULT_OPENCLAW_FILENAME
  | typeof DEFAULT_SOUL_FILENAME
  | typeof DEFAULT_TOOLS_FILENAME
  | typeof DEFAULT_IDENTITY_FILENAME
  | typeof DEFAULT_USER_FILENAME
  | typeof DEFAULT_HEARTBEAT_FILENAME
  | typeof DEFAULT_BOOTSTRAP_FILENAME
  | typeof DEFAULT_MEMORY_FILENAME
  | typeof DEFAULT_MEMORY_ALT_FILENAME;

export type WorkspaceBootstrapFile = {
  name: WorkspaceBootstrapFileName;
  path: string;
  content?: string;
  missing: boolean;
};

export type WorkspacePolicyDiscoveryEntry = {
  name: string;
  path: string;
  kind: "bootstrap" | "candidate";
  autoInjected: boolean;
  matchedBy: "bootstrap-name" | "policy-filename" | "policy-directory";
  policyRole:
    | "global-guidance"
    | "repo-focus"
    | "tool-guidance"
    | "persona"
    | "identity"
    | "user-facts"
    | "heartbeat"
    | "bootstrap"
    | "memory"
    | "candidate";
  mergePriority: number;
  mergeTier: "primary" | "supporting" | "specialized" | "candidate";
  source: "workspace-root" | "extra-bootstrap" | "policy-scan";
  conflictSummary?: string;
  conflictWith?: string[];
};

export type ExtraBootstrapLoadDiagnosticCode =
  | "invalid-bootstrap-filename"
  | "missing"
  | "security"
  | "io";

export type ExtraBootstrapLoadDiagnostic = {
  path: string;
  reason: ExtraBootstrapLoadDiagnosticCode;
  detail: string;
};

type WorkspaceSetupState = {
  version: typeof WORKSPACE_STATE_VERSION;
  bootstrapSeededAt?: string;
  setupCompletedAt?: string;
};

/** Set of recognized bootstrap filenames for runtime validation */
const VALID_BOOTSTRAP_NAMES: ReadonlySet<string> = new Set([
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_CLAUDE_FILENAME,
  DEFAULT_OPENCLAW_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
]);

const POLICY_DISCOVERY_DIRECTORY_NAMES = new Set([
  ".github",
  ".openclaw",
  "docs",
  "policy",
  "policies",
  "rules",
  "runbooks",
]);

const POLICY_DISCOVERY_FILE_PATTERNS: RegExp[] = [
  /(?:^|[-_.])policy(?:[-_.]|$)/i,
  /(?:^|[-_.])policies(?:[-_.]|$)/i,
  /(?:^|[-_.])rule(?:[-_.]|$)/i,
  /(?:^|[-_.])rules(?:[-_.]|$)/i,
  /(?:^|[-_.])guardrail(?:[-_.]|$)/i,
  /(?:^|[-_.])guardrails(?:[-_.]|$)/i,
  /(?:^|[-_.])standing-order(?:[-_.]|$)/i,
  /(?:^|[-_.])standing-orders(?:[-_.]|$)/i,
  /(?:^|[-_.])playbook(?:[-_.]|$)/i,
  /(?:^|[-_.])workflow(?:[-_.]|$)/i,
  /(?:^|[-_.])runbook(?:[-_.]|$)/i,
  /(?:^|[-_.])instruction(?:[-_.]|$)/i,
  /(?:^|[-_.])instructions(?:[-_.]|$)/i,
];

const POLICY_DISCOVERY_MAX_DEPTH = 2;
const POLICY_DISCOVERY_MAX_FILES = 64;

function resolveWorkspacePolicyRole(
  name: string,
): Pick<WorkspacePolicyDiscoveryEntry, "policyRole" | "mergePriority" | "mergeTier"> {
  switch (name) {
    case DEFAULT_AGENTS_FILENAME:
      return { policyRole: "global-guidance", mergePriority: 100, mergeTier: "primary" };
    case DEFAULT_CLAUDE_FILENAME:
      return { policyRole: "global-guidance", mergePriority: 95, mergeTier: "primary" };
    case DEFAULT_OPENCLAW_FILENAME:
      return { policyRole: "repo-focus", mergePriority: 90, mergeTier: "primary" };
    case DEFAULT_TOOLS_FILENAME:
      return { policyRole: "tool-guidance", mergePriority: 70, mergeTier: "supporting" };
    case DEFAULT_SOUL_FILENAME:
      return { policyRole: "persona", mergePriority: 60, mergeTier: "supporting" };
    case DEFAULT_IDENTITY_FILENAME:
      return { policyRole: "identity", mergePriority: 55, mergeTier: "supporting" };
    case DEFAULT_USER_FILENAME:
      return { policyRole: "user-facts", mergePriority: 50, mergeTier: "supporting" };
    case DEFAULT_MEMORY_FILENAME:
    case DEFAULT_MEMORY_ALT_FILENAME:
      return { policyRole: "memory", mergePriority: 45, mergeTier: "specialized" };
    case DEFAULT_HEARTBEAT_FILENAME:
      return { policyRole: "heartbeat", mergePriority: 40, mergeTier: "specialized" };
    case DEFAULT_BOOTSTRAP_FILENAME:
      return { policyRole: "bootstrap", mergePriority: 10, mergeTier: "specialized" };
    default:
      return { policyRole: "candidate", mergePriority: 0, mergeTier: "candidate" };
  }
}

function resolveWorkspacePolicySource(params: {
  rootDir: string;
  absolutePath: string;
  kind: WorkspacePolicyDiscoveryEntry["kind"];
}): WorkspacePolicyDiscoveryEntry["source"] {
  if (params.kind === "candidate") {
    return "policy-scan";
  }
  const expectedRootPath = path.join(params.rootDir, path.basename(params.absolutePath));
  return path.resolve(expectedRootPath) === path.resolve(params.absolutePath)
    ? "workspace-root"
    : "extra-bootstrap";
}

function annotateWorkspacePolicyEntries(params: {
  rootDir: string;
  entries: Array<
    Omit<
      WorkspacePolicyDiscoveryEntry,
      "policyRole" | "mergePriority" | "mergeTier" | "source" | "conflictSummary" | "conflictWith"
    >
  >;
}): WorkspacePolicyDiscoveryEntry[] {
  const annotated = params.entries.map((entry) => ({
    ...entry,
    ...resolveWorkspacePolicyRole(entry.name),
    source: resolveWorkspacePolicySource({
      rootDir: params.rootDir,
      absolutePath: entry.path,
      kind: entry.kind,
    }),
  }));

  const injectedByRole = new Map<string, WorkspacePolicyDiscoveryEntry[]>();
  const injectedByName = new Map<string, WorkspacePolicyDiscoveryEntry[]>();
  for (const entry of annotated) {
    if (!entry.autoInjected) {
      continue;
    }
    const roleEntries = injectedByRole.get(entry.policyRole) ?? [];
    roleEntries.push(entry);
    injectedByRole.set(entry.policyRole, roleEntries);

    const nameEntries = injectedByName.get(entry.name) ?? [];
    nameEntries.push(entry);
    injectedByName.set(entry.name, nameEntries);
  }

  return annotated
    .map((entry) => {
      const overlaps: string[] = [];
      const overlapSummaries: string[] = [];
      const rolePeers = injectedByRole.get(entry.policyRole) ?? [];
      const namePeers = injectedByName.get(entry.name) ?? [];

      if (entry.autoInjected && rolePeers.length > 1) {
        const peerNames = rolePeers.map((peer) => peer.name).filter((name) => name !== entry.name);
        if (peerNames.length > 0) {
          overlaps.push(...peerNames);
          overlapSummaries.push(`shares ${entry.policyRole} role with ${peerNames.join(", ")}`);
        }
      }

      if (entry.autoInjected && namePeers.length > 1) {
        const peerPaths = namePeers
          .map((peer) => peer.path)
          .filter((peerPath) => peerPath !== entry.path)
          .map((peerPath) => path.relative(params.rootDir, peerPath) || path.basename(peerPath));
        if (peerPaths.length > 0) {
          overlaps.push(...peerPaths);
          overlapSummaries.push(
            `duplicate bootstrap basename also loaded from ${peerPaths.join(", ")}`,
          );
        }
      }

      return {
        ...entry,
        ...(overlaps.length
          ? {
              conflictWith: Array.from(new Set(overlaps)),
              conflictSummary: overlapSummaries.join("; "),
            }
          : {}),
      };
    })
    .toSorted((left, right) => {
      if (left.autoInjected !== right.autoInjected) {
        return left.autoInjected ? -1 : 1;
      }
      if (left.mergePriority !== right.mergePriority) {
        return right.mergePriority - left.mergePriority;
      }
      return left.path.localeCompare(right.path);
    });
}

async function writeFileIfMissing(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.writeFile(filePath, content, {
      encoding: "utf-8",
      flag: "wx",
    });
    return true;
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "EEXIST") {
      throw err;
    }
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveWorkspaceStatePath(dir: string): string {
  return path.join(dir, WORKSPACE_STATE_DIRNAME, WORKSPACE_STATE_FILENAME);
}

function parseWorkspaceSetupState(raw: string): WorkspaceSetupState | null {
  try {
    const parsed = JSON.parse(raw) as {
      bootstrapSeededAt?: unknown;
      setupCompletedAt?: unknown;
      onboardingCompletedAt?: unknown;
    };
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const legacyCompletedAt =
      typeof parsed.onboardingCompletedAt === "string" ? parsed.onboardingCompletedAt : undefined;
    return {
      version: WORKSPACE_STATE_VERSION,
      bootstrapSeededAt:
        typeof parsed.bootstrapSeededAt === "string" ? parsed.bootstrapSeededAt : undefined,
      setupCompletedAt:
        typeof parsed.setupCompletedAt === "string" ? parsed.setupCompletedAt : legacyCompletedAt,
    };
  } catch {
    return null;
  }
}

async function readWorkspaceSetupState(statePath: string): Promise<WorkspaceSetupState> {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = parseWorkspaceSetupState(raw);
    if (
      parsed &&
      raw.includes('"onboardingCompletedAt"') &&
      !raw.includes('"setupCompletedAt"') &&
      parsed.setupCompletedAt
    ) {
      await writeWorkspaceSetupState(statePath, parsed);
    }
    return parsed ?? { version: WORKSPACE_STATE_VERSION };
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "ENOENT") {
      throw err;
    }
    return {
      version: WORKSPACE_STATE_VERSION,
    };
  }
}

async function readWorkspaceSetupStateForDir(dir: string): Promise<WorkspaceSetupState> {
  const statePath = resolveWorkspaceStatePath(resolveUserPath(dir));
  return await readWorkspaceSetupState(statePath);
}

export async function isWorkspaceSetupCompleted(dir: string): Promise<boolean> {
  const state = await readWorkspaceSetupStateForDir(dir);
  return typeof state.setupCompletedAt === "string" && state.setupCompletedAt.trim().length > 0;
}

async function writeWorkspaceSetupState(
  statePath: string,
  state: WorkspaceSetupState,
): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.writeFile(tmpPath, payload, { encoding: "utf-8" });
    await fs.rename(tmpPath, statePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

async function hasGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function isGitAvailable(): Promise<boolean> {
  if (gitAvailabilityPromise) {
    return gitAvailabilityPromise;
  }

  gitAvailabilityPromise = (async () => {
    try {
      const result = await runCommandWithTimeout(["git", "--version"], { timeoutMs: 2_000 });
      return result.code === 0;
    } catch {
      return false;
    }
  })();

  return gitAvailabilityPromise;
}

async function ensureGitRepo(dir: string, isBrandNewWorkspace: boolean) {
  if (!isBrandNewWorkspace) {
    return;
  }
  if (await hasGitRepo(dir)) {
    return;
  }
  if (!(await isGitAvailable())) {
    return;
  }
  try {
    await runCommandWithTimeout(["git", "init"], { cwd: dir, timeoutMs: 10_000 });
  } catch {
    // Ignore git init failures; workspace creation should still succeed.
  }
}

export async function ensureAgentWorkspace(params?: {
  dir?: string;
  ensureBootstrapFiles?: boolean;
}): Promise<{
  dir: string;
  agentsPath?: string;
  soulPath?: string;
  toolsPath?: string;
  identityPath?: string;
  userPath?: string;
  heartbeatPath?: string;
  bootstrapPath?: string;
}> {
  const rawDir = params?.dir?.trim() ? params.dir.trim() : DEFAULT_AGENT_WORKSPACE_DIR;
  const dir = resolveUserPath(rawDir);
  await fs.mkdir(dir, { recursive: true });

  if (!params?.ensureBootstrapFiles) {
    return { dir };
  }

  const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
  const soulPath = path.join(dir, DEFAULT_SOUL_FILENAME);
  const toolsPath = path.join(dir, DEFAULT_TOOLS_FILENAME);
  const identityPath = path.join(dir, DEFAULT_IDENTITY_FILENAME);
  const userPath = path.join(dir, DEFAULT_USER_FILENAME);
  const heartbeatPath = path.join(dir, DEFAULT_HEARTBEAT_FILENAME);
  const bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);
  const statePath = resolveWorkspaceStatePath(dir);

  const isBrandNewWorkspace = await (async () => {
    const templatePaths = [agentsPath, soulPath, toolsPath, identityPath, userPath, heartbeatPath];
    const userContentPaths = [
      path.join(dir, "memory"),
      path.join(dir, DEFAULT_MEMORY_FILENAME),
      path.join(dir, ".git"),
    ];
    const paths = [...templatePaths, ...userContentPaths];
    const existing = await Promise.all(
      paths.map(async (p) => {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      }),
    );
    return existing.every((v) => !v);
  })();

  const agentsTemplate = await loadTemplate(DEFAULT_AGENTS_FILENAME);
  const soulTemplate = await loadTemplate(DEFAULT_SOUL_FILENAME);
  const toolsTemplate = await loadTemplate(DEFAULT_TOOLS_FILENAME);
  const identityTemplate = await loadTemplate(DEFAULT_IDENTITY_FILENAME);
  const userTemplate = await loadTemplate(DEFAULT_USER_FILENAME);
  const heartbeatTemplate = await loadTemplate(DEFAULT_HEARTBEAT_FILENAME);
  await writeFileIfMissing(agentsPath, agentsTemplate);
  await writeFileIfMissing(soulPath, soulTemplate);
  await writeFileIfMissing(toolsPath, toolsTemplate);
  await writeFileIfMissing(identityPath, identityTemplate);
  await writeFileIfMissing(userPath, userTemplate);
  await writeFileIfMissing(heartbeatPath, heartbeatTemplate);

  let state = await readWorkspaceSetupState(statePath);
  let stateDirty = false;
  const markState = (next: Partial<WorkspaceSetupState>) => {
    state = { ...state, ...next };
    stateDirty = true;
  };
  const nowIso = () => new Date().toISOString();

  let bootstrapExists = await fileExists(bootstrapPath);
  if (!state.bootstrapSeededAt && bootstrapExists) {
    markState({ bootstrapSeededAt: nowIso() });
  }

  if (!state.setupCompletedAt && state.bootstrapSeededAt && !bootstrapExists) {
    markState({ setupCompletedAt: nowIso() });
  }

  if (!state.bootstrapSeededAt && !state.setupCompletedAt && !bootstrapExists) {
    // Legacy migration path: if USER/IDENTITY diverged from templates, or if user-content
    // indicators exist, treat setup as complete and avoid recreating BOOTSTRAP for
    // already-configured workspaces.
    const [identityContent, userContent] = await Promise.all([
      fs.readFile(identityPath, "utf-8"),
      fs.readFile(userPath, "utf-8"),
    ]);
    const hasUserContent = await (async () => {
      const indicators = [
        path.join(dir, "memory"),
        path.join(dir, DEFAULT_MEMORY_FILENAME),
        path.join(dir, ".git"),
      ];
      for (const indicator of indicators) {
        try {
          await fs.access(indicator);
          return true;
        } catch {
          // continue
        }
      }
      return false;
    })();
    const legacySetupCompleted =
      identityContent !== identityTemplate || userContent !== userTemplate || hasUserContent;
    if (legacySetupCompleted) {
      markState({ setupCompletedAt: nowIso() });
    } else {
      const bootstrapTemplate = await loadTemplate(DEFAULT_BOOTSTRAP_FILENAME);
      const wroteBootstrap = await writeFileIfMissing(bootstrapPath, bootstrapTemplate);
      if (!wroteBootstrap) {
        bootstrapExists = await fileExists(bootstrapPath);
      } else {
        bootstrapExists = true;
      }
      if (bootstrapExists && !state.bootstrapSeededAt) {
        markState({ bootstrapSeededAt: nowIso() });
      }
    }
  }

  if (stateDirty) {
    await writeWorkspaceSetupState(statePath, state);
  }
  await ensureGitRepo(dir, isBrandNewWorkspace);

  return {
    dir,
    agentsPath,
    soulPath,
    toolsPath,
    identityPath,
    userPath,
    heartbeatPath,
    bootstrapPath,
  };
}

async function resolveMemoryBootstrapEntry(
  resolvedDir: string,
): Promise<{ name: WorkspaceBootstrapFileName; filePath: string } | null> {
  // Prefer MEMORY.md; fall back to memory.md only when absent.
  // Checking both and deduplicating via realpath is unreliable on case-insensitive
  // file systems mounted in Docker (e.g. macOS volumes), where both names pass
  // fs.access() but realpath does not normalise case through the mount layer,
  // causing the same content to be injected twice and wasting tokens.
  for (const name of [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME] as const) {
    const filePath = path.join(resolvedDir, name);
    try {
      await fs.access(filePath);
      return { name, filePath };
    } catch {
      // try next candidate
    }
  }
  return null;
}

export async function loadWorkspaceBootstrapFiles(dir: string): Promise<WorkspaceBootstrapFile[]> {
  const resolvedDir = resolveUserPath(dir);

  const entries: Array<{
    name: WorkspaceBootstrapFileName;
    filePath: string;
  }> = [
    {
      name: DEFAULT_AGENTS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME),
    },
    {
      name: DEFAULT_CLAUDE_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_CLAUDE_FILENAME),
    },
    {
      name: DEFAULT_OPENCLAW_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_OPENCLAW_FILENAME),
    },
    {
      name: DEFAULT_SOUL_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_SOUL_FILENAME),
    },
    {
      name: DEFAULT_TOOLS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_TOOLS_FILENAME),
    },
    {
      name: DEFAULT_IDENTITY_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_IDENTITY_FILENAME),
    },
    {
      name: DEFAULT_USER_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_USER_FILENAME),
    },
    {
      name: DEFAULT_HEARTBEAT_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_HEARTBEAT_FILENAME),
    },
    {
      name: DEFAULT_BOOTSTRAP_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME),
    },
  ];

  const memoryEntry = await resolveMemoryBootstrapEntry(resolvedDir);
  if (memoryEntry) {
    entries.push(memoryEntry);
  }

  const result: WorkspaceBootstrapFile[] = [];
  for (const entry of entries) {
    const loaded = await readWorkspaceFileWithGuards({
      filePath: entry.filePath,
      workspaceDir: resolvedDir,
    });
    if (loaded.ok) {
      result.push({
        name: entry.name,
        path: entry.filePath,
        content: loaded.content,
        missing: false,
      });
    } else {
      result.push({ name: entry.name, path: entry.filePath, missing: true });
    }
  }
  return result;
}

function isWithinWorkspace(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function matchesDiscoveredPolicyFilename(name: string): boolean {
  const lowered = name.toLowerCase();
  if (!lowered.endsWith(".md")) {
    return false;
  }
  return POLICY_DISCOVERY_FILE_PATTERNS.some((pattern) => pattern.test(lowered));
}

function discoverPolicyCandidatesInDirectory(params: {
  rootDir: string;
  currentDir: string;
  depth: number;
  entries: Array<
    Omit<
      WorkspacePolicyDiscoveryEntry,
      "policyRole" | "mergePriority" | "mergeTier" | "source" | "conflictSummary" | "conflictWith"
    >
  >;
  seenPaths: Set<string>;
}): void {
  if (
    params.depth > POLICY_DISCOVERY_MAX_DEPTH ||
    params.entries.length >= POLICY_DISCOVERY_MAX_FILES
  ) {
    return;
  }
  let dirEntries: syncFs.Dirent[];
  try {
    dirEntries = syncFs.readdirSync(params.currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirEntries) {
    if (params.entries.length >= POLICY_DISCOVERY_MAX_FILES) {
      return;
    }
    const absolutePath = path.join(params.currentDir, dirent.name);
    const resolvedPath = path.resolve(absolutePath);
    if (!isWithinWorkspace(params.rootDir, resolvedPath)) {
      continue;
    }

    if (dirent.isDirectory()) {
      if (isReservedBuildRunWorkspacePath(params.rootDir, resolvedPath)) {
        continue;
      }
      if (dirent.name.startsWith(".") && !POLICY_DISCOVERY_DIRECTORY_NAMES.has(dirent.name)) {
        continue;
      }
      discoverPolicyCandidatesInDirectory({
        ...params,
        currentDir: resolvedPath,
        depth: params.depth + 1,
      });
      continue;
    }

    if (!dirent.isFile() || !matchesDiscoveredPolicyFilename(dirent.name)) {
      continue;
    }
    if (params.seenPaths.has(resolvedPath)) {
      continue;
    }
    params.seenPaths.add(resolvedPath);
    params.entries.push({
      name: dirent.name,
      path: resolvedPath,
      kind: "candidate",
      autoInjected: false,
      matchedBy: POLICY_DISCOVERY_DIRECTORY_NAMES.has(path.basename(params.currentDir))
        ? "policy-directory"
        : "policy-filename",
    });
  }
}

export function discoverWorkspacePolicyFiles(params: {
  dir?: string;
  bootstrapFiles?: WorkspaceBootstrapFile[];
}): WorkspacePolicyDiscoveryEntry[] {
  const dir = params.dir?.trim();
  if (!dir) {
    return [];
  }
  const resolvedDir = resolveUserPath(dir);
  const seenPaths = new Set<string>();
  const entries: Array<
    Omit<
      WorkspacePolicyDiscoveryEntry,
      "policyRole" | "mergePriority" | "mergeTier" | "source" | "conflictSummary" | "conflictWith"
    >
  > = [];

  for (const file of params.bootstrapFiles ?? []) {
    if (file.missing) {
      continue;
    }
    const resolvedPath = path.resolve(file.path);
    if (!isWithinWorkspace(resolvedDir, resolvedPath) || seenPaths.has(resolvedPath)) {
      continue;
    }
    seenPaths.add(resolvedPath);
    entries.push({
      name: file.name,
      path: resolvedPath,
      kind: "bootstrap",
      autoInjected: true,
      matchedBy: "bootstrap-name",
    });
  }

  discoverPolicyCandidatesInDirectory({
    rootDir: resolvedDir,
    currentDir: resolvedDir,
    depth: 0,
    entries,
    seenPaths,
  });

  return annotateWorkspacePolicyEntries({
    rootDir: resolvedDir,
    entries,
  });
}

const MINIMAL_BOOTSTRAP_ALLOWLIST = new Set([
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_CLAUDE_FILENAME,
  DEFAULT_OPENCLAW_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
]);

export function filterBootstrapFilesForSession(
  files: WorkspaceBootstrapFile[],
  sessionKey?: string,
): WorkspaceBootstrapFile[] {
  if (!sessionKey || (!isSubagentSessionKey(sessionKey) && !isCronSessionKey(sessionKey))) {
    return files;
  }
  return files.filter((file) => MINIMAL_BOOTSTRAP_ALLOWLIST.has(file.name));
}

export async function loadExtraBootstrapFiles(
  dir: string,
  extraPatterns: string[],
): Promise<WorkspaceBootstrapFile[]> {
  const loaded = await loadExtraBootstrapFilesWithDiagnostics(dir, extraPatterns);
  return loaded.files;
}

export async function loadExtraBootstrapFilesWithDiagnostics(
  dir: string,
  extraPatterns: string[],
): Promise<{
  files: WorkspaceBootstrapFile[];
  diagnostics: ExtraBootstrapLoadDiagnostic[];
}> {
  if (!extraPatterns.length) {
    return { files: [], diagnostics: [] };
  }
  const resolvedDir = resolveUserPath(dir);

  // Resolve glob patterns into concrete file paths
  const resolvedPaths = new Set<string>();
  for (const pattern of extraPatterns) {
    if (pattern.includes("*") || pattern.includes("?") || pattern.includes("{")) {
      try {
        const matches = fs.glob(pattern, { cwd: resolvedDir });
        for await (const m of matches) {
          resolvedPaths.add(m);
        }
      } catch {
        // glob not available or pattern error — fall back to literal
        resolvedPaths.add(pattern);
      }
    } else {
      resolvedPaths.add(pattern);
    }
  }

  const files: WorkspaceBootstrapFile[] = [];
  const diagnostics: ExtraBootstrapLoadDiagnostic[] = [];
  for (const relPath of resolvedPaths) {
    const filePath = path.resolve(resolvedDir, relPath);
    // Only load files whose basename is a recognized bootstrap filename
    const baseName = path.basename(relPath);
    if (!VALID_BOOTSTRAP_NAMES.has(baseName)) {
      diagnostics.push({
        path: filePath,
        reason: "invalid-bootstrap-filename",
        detail: `unsupported bootstrap basename: ${baseName}`,
      });
      continue;
    }
    const loaded = await readWorkspaceFileWithGuards({
      filePath,
      workspaceDir: resolvedDir,
    });
    if (loaded.ok) {
      files.push({
        name: baseName as WorkspaceBootstrapFileName,
        path: filePath,
        content: loaded.content,
        missing: false,
      });
      continue;
    }

    const reason: ExtraBootstrapLoadDiagnosticCode =
      loaded.reason === "path" ? "missing" : loaded.reason === "validation" ? "security" : "io";
    diagnostics.push({
      path: filePath,
      reason,
      detail:
        loaded.error instanceof Error
          ? loaded.error.message
          : typeof loaded.error === "string"
            ? loaded.error
            : reason,
    });
  }
  return { files, diagnostics };
}
