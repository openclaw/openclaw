/** Advisory inspection of runtime snapshot paths retained in legacy session stores. */
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveStateDir } from "../config/paths.js";
import { hydrateSessionStoreSkillPromptRefs } from "../config/sessions/skill-prompt-blobs.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { expandHomePrefix, resolveOsHomeDir } from "../infra/home-dir.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { resolveBundledSkillsDir } from "../skills/loading/bundled-dir.js";
import { resolveConfigDir, shortenHomePath } from "../utils.js";

const SESSION_SNAPSHOTS_CHECK_ID = "core/doctor/session-snapshots";

type SnapshotPathSource =
  | "skillsSnapshot.prompt"
  | "skillsSnapshot.resolvedSkills"
  | "systemPromptReport.injectedWorkspaceFiles";

type CachedSnapshotPath = {
  field: SnapshotPathSource;
  path: string;
};

type StaleSessionSnapshotPathFinding = {
  sessionKey: string;
  field: SnapshotPathSource;
  cachedPath: string;
  expectedPath: string;
};

type SessionSnapshotHealthIssue = StaleSessionSnapshotPathFinding & {
  storePath: string;
};

function resolveSessionSnapshotBundledSkillsDir(params?: {
  bundledSkillsDir?: string;
  argv1?: string;
  moduleUrl?: string;
  cwd?: string;
  execPath?: string;
}): string | undefined {
  const explicit = params?.bundledSkillsDir?.trim();
  if (explicit) {
    return explicit;
  }
  const resolved = resolveBundledSkillsDir({
    argv1: params?.argv1,
    moduleUrl: params?.moduleUrl,
    cwd: params?.cwd,
    execPath: params?.execPath,
  });
  if (resolved) {
    return resolved;
  }
  const packageRoot = resolveOpenClawPackageRootSync({
    argv1: params?.argv1 ?? process.argv[1],
    moduleUrl: params?.moduleUrl ?? import.meta.url,
    cwd: params?.cwd ?? process.cwd(),
  });
  return packageRoot ? path.join(packageRoot, "skills") : undefined;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractSkillLocations(prompt: unknown): string[] {
  if (typeof prompt !== "string" || !prompt.trim()) {
    return [];
  }
  const locations: string[] = [];
  const locationPattern = /<location>([\s\S]*?)<\/location>/g;
  for (const match of prompt.matchAll(locationPattern)) {
    const raw = match[1]?.trim();
    if (raw) {
      locations.push(decodeXmlText(raw));
    }
  }
  return locations;
}

function collectResolvedSkillPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const paths: string[] = [];
  for (const skill of value) {
    if (!isRecord(skill)) {
      continue;
    }
    if (typeof skill.filePath === "string" && skill.filePath.trim()) {
      paths.push(skill.filePath.trim());
    }
    if (typeof skill.baseDir === "string" && skill.baseDir.trim()) {
      paths.push(path.join(skill.baseDir.trim(), "SKILL.md"));
    }
    if (isRecord(skill.sourceInfo)) {
      if (typeof skill.sourceInfo.path === "string" && skill.sourceInfo.path.trim()) {
        paths.push(skill.sourceInfo.path.trim());
      }
      if (typeof skill.sourceInfo.baseDir === "string" && skill.sourceInfo.baseDir.trim()) {
        paths.push(path.join(skill.sourceInfo.baseDir.trim(), "SKILL.md"));
      }
    }
  }
  return paths;
}

function collectInjectedWorkspaceFilePaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (isRecord(entry) && typeof entry.path === "string" ? entry.path.trim() : ""))
    .filter(Boolean);
}

function collectCachedSnapshotPaths(entry: SessionEntry): CachedSnapshotPath[] {
  const snapshot = entry.skillsSnapshot as Record<string, unknown> | undefined;
  const report = entry.systemPromptReport as Record<string, unknown> | undefined;
  const paths: CachedSnapshotPath[] = [];
  for (const location of extractSkillLocations(snapshot?.prompt)) {
    paths.push({ field: "skillsSnapshot.prompt", path: location });
  }
  for (const location of collectResolvedSkillPaths(snapshot?.resolvedSkills)) {
    paths.push({ field: "skillsSnapshot.resolvedSkills", path: location });
  }
  if (isRecord(report)) {
    for (const location of collectInjectedWorkspaceFilePaths(report.injectedWorkspaceFiles)) {
      paths.push({ field: "systemPromptReport.injectedWorkspaceFiles", path: location });
    }
  }
  return paths;
}

function isAbsolutePathLike(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function splitPathSegments(value: string): string[] {
  return value
    .replace(/^[a-z]:/i, "")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean);
}
function isWindowsAbsolutePath(value: string): boolean {
  return (
    (/^[a-z]:/i.test(value) && ["/", "\\"].includes(value.slice(2, 3))) || value.startsWith("\\\\")
  );
}
function isTempBackedOpenClawRoot(segments: readonly string[]): boolean {
  const lower = segments.map((segment) => segment.toLowerCase());
  const openclawIndex = lower.lastIndexOf("openclaw");
  if (openclawIndex < 1) {
    return false;
  }
  return lower[openclawIndex - 1] === "tmp" || lower[openclawIndex - 1] === "temp";
}

function isBundledRuntimeSkillsPath(cachedPath: string, skillRootIndex: number): boolean {
  const beforeSkillRoot = splitPathSegments(cachedPath).slice(0, skillRootIndex);
  const lower = beforeSkillRoot.map((segment) => segment.toLowerCase());
  return (
    lower.some(
      (segment) =>
        segment === "dist-runtime" || segment === "node_modules" || segment.startsWith("openclaw@"),
    ) || isTempBackedOpenClawRoot(beforeSkillRoot)
  );
}
function extractBundledSkillRelativeSegments(cachedPath: string): string[] | undefined {
  const segments = splitPathSegments(cachedPath);
  const skillRootIndex = segments.lastIndexOf("skills");
  if (skillRootIndex < 0 || !isBundledRuntimeSkillsPath(cachedPath, skillRootIndex)) {
    return undefined;
  }
  const relativeSegments = segments.slice(skillRootIndex + 1);
  if (relativeSegments.length < 2 || relativeSegments.at(-1) !== "SKILL.md") {
    return undefined;
  }
  return relativeSegments;
}
function isInsidePath(baseDir: string, candidatePath: string): boolean {
  const baseIsWindows = isWindowsAbsolutePath(baseDir);
  const candidateIsWindows = isWindowsAbsolutePath(candidatePath);
  if (baseIsWindows !== candidateIsWindows) {
    return false;
  }
  const pathApi = baseIsWindows ? path.win32 : path;
  const relative = pathApi.relative(pathApi.resolve(baseDir), pathApi.resolve(candidatePath));
  return (
    relative === "" ||
    (relative !== "" && !relative.startsWith("..") && !pathApi.isAbsolute(relative))
  );
}
function joinPathForRoot(root: string, ...segments: string[]): string {
  return isWindowsAbsolutePath(root)
    ? path.win32.join(root, ...segments)
    : path.join(root, ...segments);
}
function resolveExpectedBundledSkillPath(params: {
  cachedPath: string;
  bundledSkillsDir: string;
  pathExists: (filePath: string) => boolean;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  // Snapshot paths use shell `~` semantics. OPENCLAW_HOME may point at an isolated
  // runtime profile, so expanding against it would make the active runtime look stale.
  const osHomeDir = resolveOsHomeDir(params.env);
  const expandedCachedPath = osHomeDir
    ? expandHomePrefix(params.cachedPath, { home: osHomeDir })
    : params.cachedPath;
  if (!isAbsolutePathLike(expandedCachedPath)) {
    return undefined;
  }
  const relativeSegments = extractBundledSkillRelativeSegments(expandedCachedPath);
  if (!relativeSegments) {
    return undefined;
  }
  const movedPath = resolveMovedBundledSkillPath({
    relativeSegments,
    pathExists: params.pathExists,
    env: params.env,
  });
  if (movedPath) {
    return movedPath;
  }
  if (isInsidePath(params.bundledSkillsDir, expandedCachedPath)) {
    return undefined;
  }
  const expectedPath = joinPathForRoot(params.bundledSkillsDir, ...relativeSegments);
  if (params.pathExists(expectedPath)) {
    return expectedPath;
  }
  return undefined;
}

function resolveMovedBundledSkillPath(params: {
  relativeSegments: readonly string[];
  pathExists: (filePath: string) => boolean;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  if (params.relativeSegments.join("/") !== "imsg/SKILL.md") {
    return undefined;
  }
  const expectedPath = path.join(resolveConfigDir(params.env), "plugin-skills", "imsg", "SKILL.md");
  return params.pathExists(expectedPath) ? expectedPath : undefined;
}

/** Finds cached bundled-skill paths that point at old runtime/temp package roots. */
function scanSessionStoreForStaleRuntimeSnapshotPaths(params: {
  store: Record<string, SessionEntry>;
  bundledSkillsDir: string | undefined;
  pathExists?: (filePath: string) => boolean;
  env?: NodeJS.ProcessEnv;
}): StaleSessionSnapshotPathFinding[] {
  const bundledSkillsDir = params.bundledSkillsDir?.trim();
  if (!bundledSkillsDir) {
    return [];
  }
  const pathExists = params.pathExists ?? fs.existsSync;
  const findings: StaleSessionSnapshotPathFinding[] = [];
  const seen = new Set<string>();
  for (const [sessionKey, entry] of Object.entries(params.store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    for (const cached of collectCachedSnapshotPaths(entry)) {
      const expectedPath = resolveExpectedBundledSkillPath({
        cachedPath: cached.path,
        bundledSkillsDir,
        pathExists,
        env: params.env,
      });
      if (!expectedPath) {
        continue;
      }
      const key = `${sessionKey}\0${cached.field}\0${cached.path}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      findings.push({
        sessionKey,
        field: cached.field,
        cachedPath: cached.path,
        expectedPath,
      });
    }
  }
  return findings;
}

async function listSessionStorePaths(stateDir: string): Promise<string[]> {
  const agentsDir = path.join(stateDir, "agents");
  let agentEntries: fs.Dirent[];
  try {
    agentEntries = await fs.promises.readdir(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return agentEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(agentsDir, entry.name, "sessions", "sessions.json"))
    .filter((storePath) => fs.existsSync(storePath))
    .toSorted((a, b) => a.localeCompare(b));
}

function resolveSessionStorePaths(params: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] | undefined {
  if (!params.cfg) {
    return undefined;
  }
  return resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env })
    .map((target) => target.storePath)
    .filter((storePath) => fs.existsSync(storePath))
    .toSorted((a, b) => a.localeCompare(b));
}

function loadSessionStoreForSnapshotScan(storePath: string): Record<string, SessionEntry> {
  const parsed = JSON.parse(fs.readFileSync(storePath, "utf-8")) as unknown;
  if (!isRecord(parsed)) {
    return {};
  }
  const store = parsed as Record<string, SessionEntry>;
  hydrateSessionStoreSkillPromptRefs({ storePath, store });
  return store;
}

type SessionSnapshotScanOptions = {
  storePaths?: string[];
  bundledSkillsDir?: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

async function scanSessionSnapshotHealth(
  params: SessionSnapshotScanOptions = {},
  onError?: (storePath: string, error: unknown) => void,
) {
  const bundledSkillsDir = resolveSessionSnapshotBundledSkillsDir({
    bundledSkillsDir: params.bundledSkillsDir,
  });
  const stores: Array<{ storePath: string; findings: StaleSessionSnapshotPathFinding[] }> = [];
  if (bundledSkillsDir) {
    const storePaths =
      params.storePaths ??
      resolveSessionStorePaths(params) ??
      (await listSessionStorePaths(resolveStateDir(params.env)));
    for (const storePath of storePaths) {
      let store: Record<string, SessionEntry>;
      try {
        store = loadSessionStoreForSnapshotScan(storePath);
      } catch (error) {
        onError?.(storePath, error);
        continue;
      }
      const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
        store,
        bundledSkillsDir,
        env: params.env,
      });
      if (findings.length > 0) {
        stores.push({ storePath, findings });
      }
    }
  }
  return { bundledSkillsDir, stores };
}

export async function detectSessionSnapshotHealthIssues(
  params?: SessionSnapshotScanOptions,
): Promise<SessionSnapshotHealthIssue[]> {
  const { stores } = await scanSessionSnapshotHealth(params);
  return stores.flatMap(({ storePath, findings }) =>
    findings.map((finding) => ({ ...finding, storePath })),
  );
}

export function sessionSnapshotIssueToHealthFinding(
  issue: SessionSnapshotHealthIssue,
): HealthFinding {
  return {
    checkId: SESSION_SNAPSHOTS_CHECK_ID,
    severity: "info",
    message: `${issue.sessionKey} historical session metadata references an inactive runtime root.`,
    path: issue.storePath,
    target: issue.cachedPath,
    requirement: `Current bundled skill path: ${issue.expectedPath}`,
    fixHint:
      "No repair is needed for this historical metadata. Doctor preserves migration originals; active sessions use canonical SQLite state and the current runtime skill catalog.",
  };
}

/** Reports historical snapshot paths without rewriting migration source bytes. */
export async function noteSessionSnapshotHealth(params?: SessionSnapshotScanOptions) {
  const { bundledSkillsDir, stores } = await scanSessionSnapshotHealth(
    params,
    (storePath, error) => {
      note(
        `- Failed to inspect session snapshot metadata in ${shortenHomePath(storePath)}: ${String(error)}`,
        "Session snapshots",
      );
    },
  );
  if (!bundledSkillsDir) {
    return;
  }
  const findingsByStore = new Map(stores.map(({ storePath, findings }) => [storePath, findings]));
  const totalFindings = [...findingsByStore.values()].reduce(
    (total, findings) => total + findings.length,
    0,
  );
  if (totalFindings === 0) {
    return;
  }
  const affectedSessions = new Set(
    [...findingsByStore.values()].flatMap((findings) =>
      findings.map((finding) => finding.sessionKey),
    ),
  );

  const lines = [
    `- Found ${affectedSessions.size} session${affectedSessions.size === 1 ? "" : "s"} with stale cached session metadata paths.`,
    `  Live bundled skills root is healthy: ${shortenHomePath(bundledSkillsDir)}`,
    "  Historical metadata references an inactive runtime root. Originals are preserved; active sessions use canonical SQLite state and the current runtime skill catalog. No cleanup or session reset is needed.",
  ];
  let shown = 0;
  for (const [storePath, findings] of findingsByStore) {
    lines.push(`  Store: ${shortenHomePath(storePath)}`);
    for (const finding of findings.slice(0, Math.max(0, 10 - shown))) {
      lines.push(
        `  - ${finding.sessionKey} ${finding.field}: ${shortenHomePath(
          finding.cachedPath,
        )} -> ${shortenHomePath(finding.expectedPath)}`,
      );
      shown += 1;
      if (shown >= 10) {
        break;
      }
    }
    if (shown >= 10) {
      break;
    }
  }
  if (totalFindings > shown) {
    lines.push(
      `  ...and ${totalFindings - shown} more stale cached path${totalFindings - shown === 1 ? "" : "s"}.`,
    );
  }
  note(lines.join("\n"), "Session snapshots");
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.doctorSessionSnapshotsTestApi")
  ] = {
    resolveSessionSnapshotBundledSkillsDir,
    scanSessionStoreForStaleRuntimeSnapshotPaths,
  };
}
