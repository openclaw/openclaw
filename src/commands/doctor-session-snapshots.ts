/** Advisory inspection of runtime snapshot paths retained in legacy session stores. */
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { hydrateSessionStoreSkillPromptRefs } from "../config/sessions/skill-prompt-blobs.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { expandHomePrefix, resolveOsHomeDir } from "../infra/home-dir.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { decodeXml } from "../shared/xml.js";
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

function resolveSessionSnapshotBundledSkillsDir(): string | undefined {
  const resolved = resolveBundledSkillsDir();
  if (resolved) {
    return resolved;
  }
  const packageRoot = resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
    cwd: process.cwd(),
  });
  return packageRoot ? path.join(packageRoot, "skills") : undefined;
}

function extractSkillLocations(prompt: unknown): string[] {
  return typeof prompt === "string"
    ? [...prompt.matchAll(/<location>([\s\S]*?)<\/location>/g)].flatMap((match) => {
        const raw = match[1]?.trim();
        return raw ? [decodeXml(raw)] : [];
      })
    : [];
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
    const sourceInfo = isRecord(skill.sourceInfo) ? skill.sourceInfo : undefined;
    for (const [filePath, baseDir] of [
      [skill.filePath, skill.baseDir],
      [sourceInfo?.path, sourceInfo?.baseDir],
    ]) {
      if (typeof filePath === "string" && filePath.trim()) {
        paths.push(filePath.trim());
      }
      if (typeof baseDir === "string" && baseDir.trim()) {
        paths.push(path.join(baseDir.trim(), "SKILL.md"));
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
  const sources: Array<[SnapshotPathSource, string[]]> = [
    ["skillsSnapshot.prompt", extractSkillLocations(snapshot?.prompt)],
    ["skillsSnapshot.resolvedSkills", collectResolvedSkillPaths(snapshot?.resolvedSkills)],
    [
      "systemPromptReport.injectedWorkspaceFiles",
      isRecord(report) ? collectInjectedWorkspaceFilePaths(report.injectedWorkspaceFiles) : [],
    ],
  ];
  return sources.flatMap(([field, paths]) => paths.map((location) => ({ field, path: location })));
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
function isBundledRuntimeSkillsPath(beforeSkillRoot: readonly string[]): boolean {
  const lower = beforeSkillRoot.map((segment) => segment.toLowerCase());
  const openclawIndex = lower.lastIndexOf("openclaw");
  return (
    lower.some(
      (segment) =>
        segment === "dist-runtime" || segment === "node_modules" || segment.startsWith("openclaw@"),
    ) ||
    (openclawIndex > 0 && ["tmp", "temp"].includes(lower[openclawIndex - 1]!))
  );
}
function extractBundledSkillRelativeSegments(cachedPath: string): string[] | undefined {
  const segments = splitPathSegments(cachedPath);
  const skillRootIndex = segments.lastIndexOf("skills");
  if (skillRootIndex < 0 || !isBundledRuntimeSkillsPath(segments.slice(0, skillRootIndex))) {
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
  return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
}
function joinPathForRoot(root: string, ...segments: string[]): string {
  return isWindowsAbsolutePath(root)
    ? path.win32.join(root, ...segments)
    : path.join(root, ...segments);
}
function resolveExpectedBundledSkillPath(params: {
  cachedPath: string;
  bundledSkillsDir: string;
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
  if (relativeSegments.join("/") === "imsg/SKILL.md") {
    const movedPath = path.join(resolveConfigDir(params.env), "plugin-skills", "imsg", "SKILL.md");
    if (fs.existsSync(movedPath)) {
      return movedPath;
    }
  }
  if (isInsidePath(params.bundledSkillsDir, expandedCachedPath)) {
    return undefined;
  }
  const expectedPath = joinPathForRoot(params.bundledSkillsDir, ...relativeSegments);
  return fs.existsSync(expectedPath) ? expectedPath : undefined;
}

/** Finds cached bundled-skill paths that point at old runtime/temp package roots. */
function scanSessionStoreForStaleRuntimeSnapshotPaths(params: {
  store: Record<string, SessionEntry>;
  bundledSkillsDir: string | undefined;
  env?: NodeJS.ProcessEnv;
}): StaleSessionSnapshotPathFinding[] {
  const bundledSkillsDir = params.bundledSkillsDir?.trim();
  if (!bundledSkillsDir) {
    return [];
  }
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
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

async function scanSessionSnapshotHealth(
  params: SessionSnapshotScanOptions,
  onError?: (storePath: string, error: unknown) => void,
) {
  const bundledSkillsDir = resolveSessionSnapshotBundledSkillsDir();
  const stores: Array<{ storePath: string; findings: StaleSessionSnapshotPathFinding[] }> = [];
  if (bundledSkillsDir) {
    const storePaths = resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env })
      .map((target) => target.storePath)
      .filter((storePath) => fs.existsSync(storePath))
      .toSorted((a, b) => a.localeCompare(b));
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
  params: SessionSnapshotScanOptions,
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
export async function noteSessionSnapshotHealth(params: SessionSnapshotScanOptions) {
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
