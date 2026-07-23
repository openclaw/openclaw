import type { SessionCatalogSession } from "../../../../packages/gateway-protocol/src/index.ts";

export type CatalogProjectGrouping = "project" | "none";

export function normalizeCatalogProjectGrouping(raw: unknown): CatalogProjectGrouping {
  return raw === "none" ? "none" : "project";
}

type CatalogProjectGroup = {
  key: string;
  label: string;
  title: string;
  sessions: SessionCatalogSession[];
};

type WindowsPathRootKind = "drive" | "unc" | "rooted";

function windowsPathRootKind(value: string): WindowsPathRootKind | undefined {
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return "drive";
  }
  if (value.startsWith("\\\\")) {
    return "unc";
  }
  if (value.startsWith("\\")) {
    return "rooted";
  }
  return undefined;
}

function isWindowsPath(value: string): boolean {
  return windowsPathRootKind(value) !== undefined;
}

function catalogProjectPathIdentity(value: string): string {
  const rootKind = windowsPathRootKind(value);
  if (!rootKind) {
    return value;
  }
  return `windows:${rootKind}:${value
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase())
    .join("/")}`;
}

export function groupCatalogSessionsByProject(sessions: readonly SessionCatalogSession[]): {
  groups: CatalogProjectGroup[];
  ungrouped: SessionCatalogSession[];
} {
  // Custom groups are collected separately so they sort ahead of project groups
  // regardless of session order; interleaving by first-seen would make section
  // order depend on the roster's sort.
  const customGroups: CatalogProjectGroup[] = [];
  const projectGroups: CatalogProjectGroup[] = [];
  const groupsByPath = new Map<string, CatalogProjectGroup>();
  const ungrouped: SessionCatalogSession[] = [];

  for (const session of sessions) {
    const customGroup = session.customGroup?.trim();
    if (customGroup) {
      const key = `custom:${customGroup}`;
      let group = groupsByPath.get(key);
      if (!group) {
        group = {
          key,
          label: customGroup,
          title: `Custom group: ${customGroup}`,
          sessions: [],
        };
        groupsByPath.set(key, group);
        customGroups.push(group);
      }
      group.sessions.push(session);
      continue;
    }
    // Accepted tradeoff: local filesystem-root cwds ("/", "C:\") are not real
    // harness session roots, so they fall to the ungrouped flat tail. UNC share
    // roots remain groupable because the share itself can be a project root.
    let projectPath = session.cwd?.trim().replace(/[\\/]+$/, "");
    if (!projectPath || /^[A-Za-z]:$/.test(projectPath)) {
      ungrouped.push(session);
      continue;
    }
    // Mirror Claude Code desktop: any cwd at or under `.claude/worktrees/<name>`
    // folds into the origin repo; the lazy prefix picks the outermost repo root.
    const worktreePattern = isWindowsPath(projectPath)
      ? /^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]/i
      : /^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]/;
    const worktreeMatch = projectPath.match(worktreePattern);
    projectPath = worktreeMatch?.[1] ?? projectPath;
    if (!projectPath || /^[A-Za-z]:$/.test(projectPath)) {
      ungrouped.push(session);
      continue;
    }
    const pathIdentity = catalogProjectPathIdentity(projectPath);
    let group = groupsByPath.get(pathIdentity);
    if (!group) {
      group = {
        key: projectPath,
        label: projectPath.split(/[\\/]/).at(-1) || projectPath,
        title: projectPath,
        sessions: [],
      };
      groupsByPath.set(pathIdentity, group);
      projectGroups.push(group);
    }
    group.sessions.push(session);
  }

  return { groups: [...customGroups, ...projectGroups], ungrouped };
}
