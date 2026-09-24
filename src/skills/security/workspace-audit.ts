// Workspace audit helpers inspect local skill folders for security and trust issues.
import fs from "node:fs/promises";
import path from "node:path";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import { isNotFoundPathError } from "@openclaw/fs-safe/path";
import { walkDirectory } from "@openclaw/fs-safe/walk";
import {
  listAgentWorkspaceDirs,
  listExplicitAgentWorkspaceDirs,
} from "../../agents/workspace-dirs.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SecurityAuditFinding } from "../../security/audit.types.js";
import { isPathInside } from "../../security/scan-paths.js";

type WorkspaceSkillScanLimits = {
  maxFiles?: number;
  maxDirVisits?: number;
};

const MAX_WORKSPACE_SKILL_SCAN_FILES_PER_WORKSPACE = 2_000;
const MAX_WORKSPACE_SKILL_SCAN_ENTRIES_PER_WORKSPACE = 100_000;
const MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS = 12;

function realpathWithTimeout(p: string, timeoutMs = 2000): Promise<string | null> {
  return withTimeout(fs.realpath(p), timeoutMs).catch(() => null);
}

async function listWorkspaceSkillMarkdownFiles(
  workspaceDir: string,
  limits: WorkspaceSkillScanLimits = {},
): Promise<{ skillFilePaths: string[]; truncated: boolean }> {
  const skillsRoot = path.join(workspaceDir, "skills");
  let rootStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    rootStat = await fs.lstat(skillsRoot);
  } catch (error) {
    return { skillFilePaths: [], truncated: !isNotFoundPathError(error) };
  }
  if (!rootStat.isDirectory()) {
    return { skillFilePaths: [], truncated: false };
  }

  const maxFiles = limits.maxFiles ?? MAX_WORKSPACE_SKILL_SCAN_FILES_PER_WORKSPACE;
  const maxTotalDirVisits = limits.maxDirVisits ?? maxFiles * 20;
  if (maxFiles <= 0 || maxTotalDirVisits <= 0) {
    return { skillFilePaths: [], truncated: true };
  }
  let fileCount = 0;
  let directoryVisits = 1;
  let truncated = false;
  const visible = (name: string) => !name.startsWith(".") && name !== "node_modules";
  const scan = await walkDirectory(skillsRoot, {
    maxEntries: MAX_WORKSPACE_SKILL_SCAN_ENTRIES_PER_WORKSPACE,
    symlinks: "follow",
    include: (entry) => {
      if (entry.kind !== "file" || entry.name !== "SKILL.md") {
        return false;
      }
      if (fileCount >= maxFiles) {
        truncated = true;
        return false;
      }
      fileCount += 1;
      return true;
    },
    descend: (entry) => {
      if (!visible(entry.name)) {
        return false;
      }
      if (fileCount >= maxFiles || directoryVisits >= maxTotalDirVisits) {
        truncated = true;
        return false;
      }
      directoryVisits += 1;
      return true;
    },
  });
  return {
    skillFilePaths: scan.entries.map((entry) => entry.path).toSorted(),
    truncated: truncated || scan.truncated || scan.failedDirs.length > 0,
  };
}

export async function collectWorkspaceSkillSymlinkEscapeFindings(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  skillScanLimits?: WorkspaceSkillScanLimits;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const workspaceDirs = new Set(params.workspaceDir ? [params.workspaceDir] : []);
  try {
    for (const workspaceDir of listAgentWorkspaceDirs(params.cfg)) {
      workspaceDirs.add(workspaceDir);
    }
  } catch {
    // Raw audit input can precede roster migration or be malformed. Keep the
    // entry-authored workspaces scannable even when default resolution is unavailable.
    for (const workspaceDir of listExplicitAgentWorkspaceDirs(params.cfg)) {
      workspaceDirs.add(workspaceDir);
    }
  }
  if (workspaceDirs.size === 0) {
    return findings;
  }

  const escapedSkillFiles: Array<{
    workspaceDir: string;
    skillFilePath: string;
    skillRealPath: string;
  }> = [];
  const seenSkillPaths = new Set<string>();

  for (const workspaceDir of workspaceDirs) {
    const workspacePath = path.resolve(workspaceDir);
    const workspaceRealPath = (await realpathWithTimeout(workspacePath)) ?? workspacePath;
    const { skillFilePaths, truncated } = await listWorkspaceSkillMarkdownFiles(
      workspacePath,
      params.skillScanLimits,
    );

    if (truncated) {
      findings.push({
        checkId: "skills.workspace.scan_truncated",
        severity: "warn",
        title: "Workspace skill scan was incomplete",
        detail:
          `The skills/ directory scan in ${workspacePath} reached a file, directory, or entry ` +
          "limit, or could not read part of the tree. Skill files in the unscanned portion " +
          "were not checked for symlink escapes.",
        remediation:
          "Check directory access, flatten or simplify the skills/ tree, or move large " +
          "skill collections to a managed skill location.",
      });
    }

    for (const skillFilePath of skillFilePaths) {
      const canonicalSkillPath = path.resolve(skillFilePath);
      if (seenSkillPaths.has(canonicalSkillPath)) {
        continue;
      }
      seenSkillPaths.add(canonicalSkillPath);

      const skillRealPath = await realpathWithTimeout(canonicalSkillPath);
      if (!skillRealPath) {
        escapedSkillFiles.push({
          workspaceDir: workspacePath,
          skillFilePath: canonicalSkillPath,
          skillRealPath: "(realpath timed out - symlink target unverifiable)",
        });
        continue;
      }
      if (isPathInside(workspaceRealPath, skillRealPath)) {
        continue;
      }
      escapedSkillFiles.push({
        workspaceDir: workspacePath,
        skillFilePath: canonicalSkillPath,
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
    title: "Workspace skill files resolve outside the workspace root",
    detail:
      "Detected workspace `skills/**/SKILL.md` paths whose realpath escapes their workspace root:\n" +
      escapedSkillFiles
        .slice(0, MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS)
        .map(
          (entry) =>
            `- workspace=${entry.workspaceDir}\n` +
            `  skill=${entry.skillFilePath}\n` +
            `  realpath=${entry.skillRealPath}`,
        )
        .join("\n") +
      (escapedSkillFiles.length > MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS
        ? `\n- +${escapedSkillFiles.length - MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS} more`
        : ""),
    remediation:
      "Keep workspace skills inside the workspace root (replace symlinked escapes with real in-workspace files), or move trusted shared skills to managed/bundled skill locations.",
  });

  return findings;
}
