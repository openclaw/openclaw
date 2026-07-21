// Workspace audit helpers inspect local skill folders for security and trust issues.
import fs from "node:fs/promises";
import path from "node:path";
import { listAgentWorkspaceDirs } from "../../agents/workspace-dirs.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SecurityAuditFinding } from "../../security/audit.types.js";
import { isPathInside } from "../../security/scan-paths.js";
import {
  findContainingAllowedSkillSymlinkTarget,
  resolveAllowedSkillSymlinkTargetRealPaths,
} from "../loading/symlink-targets.js";

type WorkspaceSkillScanLimits = {
  maxFiles?: number;
  maxDirVisits?: number;
};

const MAX_WORKSPACE_SKILL_SCAN_FILES_PER_WORKSPACE = 2_000;
const MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS = 12;

async function safeStat(targetPath: string): Promise<{
  ok: boolean;
  isDir: boolean;
}> {
  try {
    // Follow the top-level skills root when it is a directory symlink / junction.
    // lstat().isDirectory() is false for those entries, which previously made the
    // security audit skip the whole tree and miss nested symlink escapes.
    const st = await fs.stat(targetPath);
    return {
      ok: true,
      isDir: st.isDirectory(),
    };
  } catch {
    return {
      ok: false,
      isDir: false,
    };
  }
}

function realpathWithTimeout(p: string, timeoutMs = 2000): Promise<string | null> {
  let timerHandle: ReturnType<typeof setTimeout> | undefined;

  const realpathPromise = fs
    .realpath(p)
    .catch(() => null)
    .then((result) => {
      clearTimeout(timerHandle);
      return result;
    });

  const timeoutPromise = new Promise<null>((resolve) => {
    timerHandle = setTimeout(() => resolve(null), timeoutMs);
    timerHandle.unref?.();
  });

  return Promise.race([realpathPromise, timeoutPromise]);
}

async function listWorkspaceSkillMarkdownFiles(
  workspaceDir: string,
  limits: WorkspaceSkillScanLimits = {},
): Promise<{ skillFilePaths: string[]; skillsRootRealPath: string | null; truncated: boolean }> {
  const skillsRoot = path.join(workspaceDir, "skills");
  const rootStat = await safeStat(skillsRoot);
  if (!rootStat.ok || !rootStat.isDir) {
    return { skillFilePaths: [], skillsRootRealPath: null, truncated: false };
  }
  const skillsRootRealPath = (await realpathWithTimeout(skillsRoot)) ?? path.resolve(skillsRoot);

  const maxFiles = limits.maxFiles ?? MAX_WORKSPACE_SKILL_SCAN_FILES_PER_WORKSPACE;
  const maxTotalDirVisits = limits.maxDirVisits ?? maxFiles * 20;
  const skillFiles: string[] = [];
  const queue: string[] = [skillsRoot];
  const visitedDirs = new Set<string>();

  for (const _ of Array.from({ length: maxTotalDirVisits })) {
    if (queue.length === 0 || skillFiles.length >= maxFiles) {
      break;
    }
    const dir = queue.shift()!;
    const dirRealPath = (await realpathWithTimeout(dir)) ?? path.resolve(dir);
    if (visitedDirs.has(dirRealPath)) {
      continue;
    }
    visitedDirs.add(dirRealPath);

    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const stat = await fs.stat(fullPath).catch(() => null);
        if (!stat) {
          continue;
        }
        if (stat.isDirectory()) {
          queue.push(fullPath);
          continue;
        }
        if (stat.isFile() && entry.name === "SKILL.md") {
          skillFiles.push(fullPath);
        }
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        skillFiles.push(fullPath);
      }
    }
  }

  return { skillFilePaths: skillFiles, skillsRootRealPath, truncated: queue.length > 0 };
}

export async function collectWorkspaceSkillSymlinkEscapeFindings(params: {
  cfg: OpenClawConfig;
  skillScanLimits?: WorkspaceSkillScanLimits;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const workspaceDirs = listAgentWorkspaceDirs(params.cfg);
  if (workspaceDirs.length === 0) {
    return findings;
  }

  const allowedSymlinkTargetRealPaths = resolveAllowedSkillSymlinkTargetRealPaths(params.cfg);

  const escapedSkillFiles: Array<{
    workspaceDir: string;
    skillsRootRealPath: string;
    skillFilePath: string;
    skillDirRealPath: string;
    skillRealPath: string;
  }> = [];
  const seenSkillPaths = new Set<string>();

  for (const workspaceDir of workspaceDirs) {
    const workspacePath = path.resolve(workspaceDir);
    const { skillFilePaths, skillsRootRealPath, truncated } = await listWorkspaceSkillMarkdownFiles(
      workspacePath,
      params.skillScanLimits,
    );

    if (truncated) {
      findings.push({
        checkId: "skills.workspace.scan_truncated",
        severity: "warn",
        title: "Workspace skill scan reached the directory visit limit",
        detail:
          `The skills/ directory scan in ${workspacePath} stopped early after reaching the ` +
          `BFS visit cap. Skill files in the unscanned portion of the tree were not checked ` +
          "for symlink escapes.",
        remediation:
          "Flatten or simplify the skills/ directory hierarchy to stay within the scan budget, " +
          "or move deeply-nested skill collections to a managed skill location.",
      });
    }

    for (const skillFilePath of skillFilePaths) {
      const canonicalSkillPath = path.resolve(skillFilePath);
      if (seenSkillPaths.has(canonicalSkillPath)) {
        continue;
      }
      seenSkillPaths.add(canonicalSkillPath);

      const [skillDirRealPath, skillRealPath] = await Promise.all([
        realpathWithTimeout(path.dirname(canonicalSkillPath)),
        realpathWithTimeout(canonicalSkillPath),
      ]);
      if (!skillDirRealPath || !skillRealPath) {
        escapedSkillFiles.push({
          workspaceDir: workspacePath,
          skillsRootRealPath: skillsRootRealPath ?? path.join(workspacePath, "skills"),
          skillFilePath: canonicalSkillPath,
          skillDirRealPath:
            skillDirRealPath ?? "(realpath timed out - skill directory unverifiable)",
          skillRealPath: skillRealPath ?? "(realpath timed out - symlink target unverifiable)",
        });
        continue;
      }
      // Trust boundary matches the skill loader: resolved skills root, plus any
      // operator-declared skills.load.allowSymlinkTargets. A nested skill dir must
      // stay inside one of those roots, and SKILL.md must stay inside its skill dir.
      const skillDirIsTrusted =
        (skillsRootRealPath !== null && isPathInside(skillsRootRealPath, skillDirRealPath)) ||
        findContainingAllowedSkillSymlinkTarget(allowedSymlinkTargetRealPaths, skillDirRealPath) !==
          null;
      if (skillDirIsTrusted && isPathInside(skillDirRealPath, skillRealPath)) {
        continue;
      }
      escapedSkillFiles.push({
        workspaceDir: workspacePath,
        skillsRootRealPath: skillsRootRealPath ?? path.join(workspacePath, "skills"),
        skillFilePath: canonicalSkillPath,
        skillDirRealPath,
        skillRealPath,
      });
    }
  }

  if (escapedSkillFiles.length === 0) {
    return findings;
  }

  findings.push({
    checkId: "skills.workspace.symlink_escape",
    severity: "warn",
    title: "Workspace skill files resolve outside trusted skill roots",
    detail:
      "Detected workspace `skills/**/SKILL.md` paths whose skill directory escapes the resolved " +
      "skills root and configured `skills.load.allowSymlinkTargets`, or whose file escapes its " +
      "resolved skill directory:\n" +
      escapedSkillFiles
        .slice(0, MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS)
        .map(
          (entry) =>
            `- workspace=${entry.workspaceDir}\n` +
            `  skillsRoot=${entry.skillsRootRealPath}\n` +
            `  skill=${entry.skillFilePath}\n` +
            `  skillDirRealpath=${entry.skillDirRealPath}\n` +
            `  realpath=${entry.skillRealPath}`,
        )
        .join("\n") +
      (escapedSkillFiles.length > MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS
        ? `\n- +${escapedSkillFiles.length - MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS} more`
        : ""),
    remediation:
      "Keep each SKILL.md inside its resolved skill directory and the skill directory inside the " +
      "resolved skills root, or explicitly trust intentional shared roots with " +
      "skills.load.allowSymlinkTargets.",
  });

  return findings;
}
