import type {
  SessionCatalogSession,
  SessionCreatedActor,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { presenceViewerLabel } from "../presence-users.ts";

export type CatalogProjectGrouping = "project" | "person" | "none";

export function normalizeCatalogProjectGrouping(raw: unknown): CatalogProjectGrouping {
  return raw === "none" || raw === "person" ? raw : "project";
}

// Sidebar, table, and catalog groups share keys from projected identities;
// raw actor ids can alias profiles or collide across identity namespaces.
export function sessionActorGroupId(owner: SessionCreatedActor | undefined): string {
  const identity = owner?.identity;
  if (!identity) {
    return "";
  }
  return identity.type === "profile" || identity.type === "agent"
    ? `${identity.type}:${identity.id}`
    : JSON.stringify(identity, Object.keys(identity).toSorted());
}

// Canonicalize a checkout path for grouping: strip trailing separators so
// `/repo` and `/repo/` key one section, then mirror Claude Code desktop by
// folding any cwd at or under `.claude/worktrees/<name>` into the origin repo
// (the lazy prefix picks the outermost repo root). Returns null for separator-only
// paths or worktrees with no origin repo.
export function foldWorktreeCheckoutPath(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]/);
  return match ? match[1] || null : trimmed;
}

/** Basename shown for a checkout path in project sections. */
export function checkoutDisplayName(path: string): string {
  return path.split(/[\\/]/).findLast(Boolean) ?? path;
}

function codexWorktreeProject(path: string) {
  if (
    !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path) ||
    path.split(/[\\/]/).some((part) => part === "." || part === "..")
  ) {
    return undefined;
  }
  const normalized = repoNameForMatching(path, path.replaceAll("\\", "/"));
  const match = normalized.match(/^(.*?\/\.codex)\/worktrees\/[^/]+\/([^/]+)(?:\/|$)/);
  if (!match) {
    return undefined;
  }
  const ownerRoot = match[1]!;
  const repoName = match[2]!;
  // The catalog carries cwd, but no Git common-directory identity. Keep this
  // display-only fallback independent of the worktree id and descendant cwd.
  return {
    ownerRoot,
    repoName,
    key: `codex-worktree:${JSON.stringify([ownerRoot, repoName])}`,
    title: `${ownerRoot}/worktrees/${repoName}`,
  };
}

function repoNameForMatching(path: string, name: string): string {
  // Case folding is for comparison; direct project keys retain original paths.
  return isWindowsProjectPath(path) ? name.toLowerCase() : name;
}

function isWindowsProjectPath(path: string): boolean {
  return /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(path);
}

function isTemporaryProject(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => part === "." || part === "..")) {
    return false;
  }
  // Match the generated directory at the OS temp root, never a Temp folder
  // somewhere inside a user checkout. Descendant cwds belong to that project.
  const relative =
    normalized.match(
      /^(?:\/private)?\/(?:tmp|var\/tmp|var\/folders\/[^/]+\/[^/]+\/T)\/(.+)$/,
    )?.[1] ??
    normalized.match(
      /^[a-z]:\/(?:Users\/[^/]+\/AppData\/Local\/Temp|Windows\/Temp|Temp)\/(.+)$/i,
    )?.[1];
  return (
    relative !== undefined &&
    /^(?:zhc-|dual-agent-|dad-|claude-bridge-|openclaw-usage-probe)/.test(relative)
  );
}

function labelProjectGroups(groups: CatalogProjectGroup[]): void {
  const parts = groups.map((group) => group.title.split(/[\\/]/));
  const suffixCounts = new Map<string, number>();
  const foldedSuffixCounts = new Map<string, number>();
  const windowsSuffixes = new Set<string>();
  for (const [index, path] of parts.entries()) {
    for (let depth = 1; depth <= path.length; depth++) {
      const suffix = path.slice(-depth).join("/");
      const folded = suffix.toLowerCase();
      suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
      foldedSuffixCounts.set(folded, (foldedSuffixCounts.get(folded) ?? 0) + 1);
      if (isWindowsProjectPath(groups[index]!.title)) {
        windowsSuffixes.add(folded);
      }
    }
  }
  for (const [index, group] of groups.entries()) {
    const path = parts[index]!;
    // Full original paths still distinguish keys that differ only in separators.
    group.label = group.title;
    for (let depth = 1; depth <= path.length; depth++) {
      const suffix = path.slice(-depth).join("/");
      const folded = suffix.toLowerCase();
      // Compare mixed-platform collisions symmetrically while keeping purely
      // POSIX suffixes case sensitive.
      const count = windowsSuffixes.has(folded)
        ? foldedSuffixCounts.get(folded)
        : suffixCounts.get(suffix);
      if (count === 1) {
        group.label = suffix;
        break;
      }
    }
  }
}

type CatalogProjectGroup = {
  kind: "custom" | "project" | "person";
  key: string;
  // Collapse ids predate the group-kind namespace. Read the old suffix until
  // the next toggle migrates that section to its canonical id.
  legacySectionKey?: string;
  label: string;
  title: string;
  sessions: SessionCatalogSession[];
};

export function groupCatalogSessionsByProject(sessions: readonly SessionCatalogSession[]): {
  groups: CatalogProjectGroup[];
  ungrouped: SessionCatalogSession[];
} {
  // Custom groups are collected separately so they sort ahead of project groups
  // regardless of session order; interleaving by first-seen would make section
  // order depend on the roster's sort.
  const customGroups: CatalogProjectGroup[] = [];
  const projectGroups: CatalogProjectGroup[] = [];
  const customGroupsByName = new Map<string, CatalogProjectGroup>();
  const projectGroupsByPath = new Map<string, CatalogProjectGroup>();
  const ungrouped: SessionCatalogSession[] = [];
  let temporaryGroup: CatalogProjectGroup | undefined;
  const projects = sessions.map((session) => {
    const cwd = session.cwd?.trim();
    const path = cwd ? foldWorktreeCheckoutPath(cwd) : null;
    return {
      path,
      codexProject: path ? codexWorktreeProject(path) : undefined,
      temporary: path ? isTemporaryProject(path) : false,
    };
  });
  const origins = new Map<string, Set<string>>();
  const codexOwners = new Map<string, Set<string>>();
  for (const { path, codexProject, temporary } of projects) {
    if (codexProject && !temporary) {
      const owners = codexOwners.get(codexProject.repoName) ?? new Set<string>();
      owners.add(codexProject.ownerRoot);
      codexOwners.set(codexProject.repoName, owners);
    }
    // A basename alone is insufficient evidence. Only distinct absolute project
    // identities outside managed Codex worktrees and generated temp projects count.
    if (
      !path ||
      codexProject ||
      /(?:^|[\\/])\.codex[\\/]worktrees(?:[\\/]|$)/.test(repoNameForMatching(path, path)) ||
      temporary ||
      !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path) ||
      path.split(/[\\/]/).some((part) => part === "." || part === "..")
    ) {
      continue;
    }
    const name = repoNameForMatching(path, checkoutDisplayName(path));
    const paths = origins.get(name) ?? new Set<string>();
    paths.add(path);
    origins.set(name, paths);
  }

  for (const [index, session] of sessions.entries()) {
    const customGroup = session.customGroup?.trim();
    if (customGroup) {
      const key = `custom:${customGroup}`;
      let group = customGroupsByName.get(customGroup);
      if (!group) {
        group = {
          kind: "custom",
          key,
          legacySectionKey: key,
          label: customGroup,
          title: `Custom group: ${customGroup}`,
          sessions: [],
        };
        customGroupsByName.set(customGroup, group);
        customGroups.push(group);
      }
      group.sessions.push(session);
      continue;
    }
    // Paths without a project identity fall to the ungrouped flat tail;
    // do not invent a project name when canonicalization returns no origin.
    const { path, codexProject, temporary } = projects[index]!;
    if (!path) {
      ungrouped.push(session);
      continue;
    }
    if (temporary) {
      if (!temporaryGroup) {
        temporaryGroup = {
          kind: "project",
          key: "temporary:tests",
          label: "Tests/Temporary",
          title: "Tests/Temporary",
          sessions: [],
        };
        projectGroups.push(temporaryGroup);
      }
      temporaryGroup.sessions.push(session);
      continue;
    }
    const candidates = codexProject ? origins.get(codexProject.repoName) : undefined;
    // One direct basename cannot attribute same-name repositories to different
    // managed owners. In that case each owner retains its synthetic group.
    const origin =
      codexProject && codexOwners.get(codexProject.repoName)?.size === 1 && candidates?.size === 1
        ? candidates.values().next().value
        : undefined;
    const projectPath = origin ?? path;
    const synthetic = origin ? undefined : codexProject;
    const key = synthetic?.key ?? `project:${projectPath}`;
    const title = synthetic?.title ?? projectPath;
    let group = projectGroupsByPath.get(key);
    if (!group) {
      group = {
        kind: "project",
        key,
        ...(!synthetic ? { legacySectionKey: projectPath } : {}),
        label: checkoutDisplayName(title),
        title,
        sessions: [],
      };
      projectGroupsByPath.set(key, group);
      projectGroups.push(group);
    }
    group.sessions.push(session);
  }

  labelProjectGroups([...projectGroupsByPath.values()]);
  return { groups: [...customGroups, ...projectGroups], ungrouped };
}

/** Groups adopted sessions by their creator identity. Native threads only carry
    `createdActor` once adopted (the gateway strips provider-supplied actors), so
    unattributed sessions intentionally fall to the flat ungrouped tail. */
export function groupCatalogSessionsByPerson(sessions: readonly SessionCatalogSession[]): {
  groups: CatalogProjectGroup[];
  ungrouped: SessionCatalogSession[];
} {
  const groupsById = new Map<string, CatalogProjectGroup>();
  const ungrouped: SessionCatalogSession[] = [];

  for (const session of sessions) {
    const actor = session.createdActor;
    const actorGroupId = sessionActorGroupId(actor);
    if (!actor?.identity || !actorGroupId) {
      ungrouped.push(session);
      continue;
    }
    const key = `person:${actorGroupId}`;
    let group = groupsById.get(key);
    if (!group) {
      const label =
        actor.identity.type === "profile"
          ? presenceViewerLabel({
              id: actor.identity.id,
              name: actor.label?.trim() || actor.identity.id,
            })
          : actor.label?.trim() || actor.identity.id;
      group = {
        kind: "person",
        key,
        legacySectionKey: `person:${actor.id}`,
        label,
        title: `Created by ${label}`,
        sessions: [],
      };
      groupsById.set(key, group);
    }
    group.sessions.push(session);
  }

  // Label order keeps the section stable regardless of roster sort.
  const groups = [...groupsById.values()].toSorted((a, b) => a.label.localeCompare(b.label));
  return { groups, ungrouped };
}
