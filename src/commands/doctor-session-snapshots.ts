import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveStateDir } from "../config/paths.js";
import {
  ensureSessionStorePromptBlobsForPersistence,
  hydrateSessionStoreSkillPromptRefs,
  projectSessionStoreForPersistence,
} from "../config/sessions/skill-prompt-blobs.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { expandHomePrefix } from "../infra/home-dir.js";
import { writeTextAtomic } from "../infra/json-files.js";
import { resolveBundledSkillsDir } from "../skills/loading/bundled-dir.js";
import { shortenHomePath } from "../utils.js";

type SnapshotPathSource =
  | "skillsSnapshot.prompt"
  | "skillsSnapshot.resolvedSkills"
  | "systemPromptReport.injectedWorkspaceFiles";

type CachedSnapshotPath = {
  field: SnapshotPathSource;
  path: string;
};

export type StaleSessionSnapshotPathFinding = {
  sessionKey: string;
  field: SnapshotPathSource;
  cachedPath: string;
  expectedPath: string;
};

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
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const expandedCachedPath = expandHomePrefix(params.cachedPath, {
    home: params.homeDir,
    env: params.env,
  });
  if (!isAbsolutePathLike(expandedCachedPath)) {
    return undefined;
  }
  if (isInsidePath(params.bundledSkillsDir, expandedCachedPath)) {
    return undefined;
  }
  const relativeSegments = extractBundledSkillRelativeSegments(expandedCachedPath);
  if (!relativeSegments) {
    return undefined;
  }
  const expectedPath = joinPathForRoot(params.bundledSkillsDir, ...relativeSegments);
  return params.pathExists(expectedPath) ? expectedPath : undefined;
}

export function scanSessionStoreForStaleRuntimeSnapshotPaths(params: {
  store: Record<string, SessionEntry>;
  bundledSkillsDir: string | undefined;
  pathExists?: (filePath: string) => boolean;
  homeDir?: string;
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
        homeDir: params.homeDir,
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
  let agentEntries: fs.Dirent[] = [];
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

/**
 * Replace stale paths in a session's snapshot metadata fields.
 * Scoped to specific fields to avoid modifying unrelated session content
 * (transcripts, user messages, etc.).
 */
function replacePathsInSession(
  session: Record<string, unknown>,
  finding: StaleSessionSnapshotPathFinding,
): number {
  let count = 0;

  const jsonEscaped = JSON.stringify(finding.cachedPath).slice(1, -1);
  const jsonEscapedExpected = JSON.stringify(finding.expectedPath).slice(1, -1);
  const xmlEscaped = finding.cachedPath
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  const xmlEscapedExpected = finding.expectedPath
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  if (finding.field === "skillsSnapshot.prompt") {
    const snapshot = session.skillsSnapshot as Record<string, unknown> | undefined;
    if (snapshot && typeof snapshot.prompt === "string") {
      let prompt = snapshot.prompt;
      const original = prompt;

      if (prompt.includes(jsonEscaped)) {
        count += prompt.split(jsonEscaped).length - 1;
        prompt = prompt.replaceAll(jsonEscaped, jsonEscapedExpected);
      }
      if (prompt.includes(xmlEscaped)) {
        count += prompt.split(xmlEscaped).length - 1;
        prompt = prompt.replaceAll(xmlEscaped, xmlEscapedExpected);
      }
      if (prompt.includes(finding.cachedPath)) {
        count += prompt.split(finding.cachedPath).length - 1;
        prompt = prompt.replaceAll(finding.cachedPath, finding.expectedPath);
      }

      if (prompt !== original) {
        snapshot.prompt = prompt;
      }
    }
  } else if (finding.field === "skillsSnapshot.resolvedSkills") {
    const snapshot = session.skillsSnapshot as Record<string, unknown> | undefined;
    if (snapshot && Array.isArray(snapshot.resolvedSkills)) {
      for (const entry of snapshot.resolvedSkills) {
        if (!isRecord(entry)) {
          continue;
        }

        for (const field of ["filePath", "baseDir"] as const) {
          if (typeof entry[field] !== "string") {
            continue;
          }
          let value = entry[field];
          const original = value;

          // For baseDir, also try directory form (without /SKILL.md suffix)
          const candidates: Array<{ cached: string; expected: string }> = [
            { cached: jsonEscaped, expected: jsonEscapedExpected },
            { cached: finding.cachedPath, expected: finding.expectedPath },
          ];
          if (field === "baseDir") {
            for (const suffix of ["/SKILL.md", "\\SKILL.md"]) {
              if (finding.cachedPath.endsWith(suffix)) {
                const cachedDir = finding.cachedPath.slice(0, -suffix.length);
                const expectedDir = finding.expectedPath.slice(0, -suffix.length);
                candidates.push(
                  { cached: JSON.stringify(cachedDir).slice(1, -1), expected: JSON.stringify(expectedDir).slice(1, -1) },
                  { cached: cachedDir, expected: expectedDir },
                );
              }
            }
          }

          for (const { cached, expected } of candidates) {
            if (value.includes(cached)) {
              count += value.split(cached).length - 1;
              value = value.replaceAll(cached, expected);
            }
          }

          if (value !== original) {
            entry[field] = value;
          }
        }
      }
    }
  } else if (finding.field === "systemPromptReport.injectedWorkspaceFiles") {
    const report = session.systemPromptReport as Record<string, unknown> | undefined;
    if (report && Array.isArray(report.injectedWorkspaceFiles)) {
      for (const entry of report.injectedWorkspaceFiles) {
        if (!isRecord(entry) || typeof entry.path !== "string") {
          continue;
        }

        let entryPath = entry.path;
        const original = entryPath;

        for (const { cached, expected } of [
          { cached: jsonEscaped, expected: jsonEscapedExpected },
          { cached: finding.cachedPath, expected: finding.expectedPath },
        ]) {
          if (entryPath.includes(cached)) {
            count += entryPath.split(cached).length - 1;
            entryPath = entryPath.replaceAll(cached, expected);
          }
        }

        if (entryPath !== original) {
          entry.path = entryPath;
        }
      }
    }
  }

  return count;
}

export async function noteSessionSnapshotHealth(params?: {
  storePaths?: string[];
  bundledSkillsDir?: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair?: boolean;
}) {
  const bundledSkillsDir = params?.bundledSkillsDir ?? resolveBundledSkillsDir();
  if (!bundledSkillsDir) {
    return;
  }
  const storePaths =
    params?.storePaths ??
    resolveSessionStorePaths({ cfg: params?.cfg, env: params?.env }) ??
    (await listSessionStorePaths(resolveStateDir(params?.env)));
  const findingsByStore = new Map<string, StaleSessionSnapshotPathFinding[]>();
  for (const storePath of storePaths) {
    let store: Record<string, SessionEntry>;
    try {
      store = loadSessionStoreForSnapshotScan(storePath);
    } catch (err) {
      note(
        `- Failed to inspect session snapshot metadata in ${shortenHomePath(storePath)}: ${String(err)}`,
        "Session snapshots",
      );
      continue;
    }
    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      store,
      bundledSkillsDir,
      env: params?.env,
    });
    if (findings.length > 0) {
      findingsByStore.set(storePath, findings);
    }
  }
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

  // Auto-repair stale paths when shouldRepair is enabled
  if (params?.shouldRepair) {
    let repairedStores = 0;
    let totalReplacements = 0;
    let leftoverFindings = 0;

    for (const [storePath, findings] of findingsByStore) {
      try {
        // Load store with hydration (same as scanner uses)
        const store = loadSessionStoreForSnapshotScan(storePath);
        const raw = fs.readFileSync(storePath, "utf-8");

        let storeCount = 0;
        for (const finding of findings) {
          const session = store[finding.sessionKey] as Record<string, unknown> | undefined;
          if (!session) {
            continue;
          }
          storeCount += replacePathsInSession(session, finding);
        }

        if (storeCount > 0) {
          // Create backup before writing
          const backupPath = `${storePath}.bak.${Date.now()}`;
          await writeTextAtomic(backupPath, raw, { mode: 0o600 });

          // Convert hydrated prompts back to promptRef blobs where needed
          const { store: persisted, promptBlobs } = projectSessionStoreForPersistence({
            storePath,
            store: store as Record<string, SessionEntry>,
          });

          // Write prompt blob files
          await ensureSessionStorePromptBlobsForPersistence({ storePath, promptBlobs: promptBlobs.values() });

          // Atomic write to prevent partial writes or corruption
          const fixed = JSON.stringify(persisted, null, 2);
          await writeTextAtomic(storePath, fixed, { mode: 0o600 });
          totalReplacements += storeCount;
          repairedStores++;

          // Rescan to report leftover findings
          const repairedStore = loadSessionStoreForSnapshotScan(storePath);
          const leftovers = scanSessionStoreForStaleRuntimeSnapshotPaths({
            store: repairedStore,
            bundledSkillsDir,
            env: params?.env,
          });
          leftoverFindings += leftovers.length;
        }
      } catch (err) {
        note(
          `- Failed to repair session snapshot paths in ${shortenHomePath(storePath)}: ${String(err)}`,
          "Session snapshots",
        );
      }
    }

    if (repairedStores > 0) {
      const msg = `- Repaired ${totalReplacements} stale path${totalReplacements === 1 ? "" : "s"} across ${repairedStores} store${repairedStores === 1 ? "" : "s"}.`;
      if (leftoverFindings > 0) {
        note(
          `${msg}\n  ${leftoverFindings} stale path${leftoverFindings === 1 ? "" : "s"} still remain (possibly non-bundled or non-repairable).`,
          "Session snapshots",
        );
      } else {
        note(msg, "Session snapshots");
      }
      return;
    }
  }

  const lines = [
    `- Found ${affectedSessions.size} session${affectedSessions.size === 1 ? "" : "s"} with stale cached session metadata paths.`,
    `  Live bundled skills root is healthy: ${shortenHomePath(bundledSkillsDir)}`,
    "  Cached session metadata still references an inactive runtime root; start a fresh session or reset the affected long-lived sessions after confirming history can be retired.",
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
