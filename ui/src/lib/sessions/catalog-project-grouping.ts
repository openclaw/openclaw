import type {
  SessionCatalogSession,
  SessionCreatedActor,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { pathDisplayName } from "../path-display.ts";
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

function isWindowsCheckoutPath(path: string): boolean {
  // Forward-slash double roots are also legal POSIX paths, not evidence of UNC.
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\");
}

// Canonicalize a checkout path for grouping: strip trailing separators so
// `/repo` and `/repo/` key one section, then mirror Claude Code desktop by
// folding any cwd at or under `.claude/worktrees/<name>` into the origin repo
// (the lazy prefix picks the outermost repo root). Returns null for separator-only
// paths or worktrees with no origin repo.
export function foldWorktreeCheckoutPath(path: string): string | null {
  // Live sidebar section IDs are persisted verbatim; keep their existing folding.
  return foldCheckoutPath(path, false);
}

function foldCheckoutPath(path: string, windows: boolean): string | null {
  // Catalog drive roots retain their separator for absolute-path detection.
  const trimmed =
    windows && /^[a-z]:[\\/]+$/i.test(path) ? path.slice(0, 3) : path.replace(/[\\/]+$/, "");
  if (!trimmed) {
    return null;
  }
  const worktreePattern = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]/;
  const match = trimmed.match(windows ? new RegExp(worktreePattern.source, "i") : worktreePattern);
  if (!match) {
    return trimmed;
  }
  const root = match[1];
  return windows && root && /^[a-z]:$/i.test(root) ? trimmed.slice(0, 3) : root || null;
}

// Shared by grouping and stored collapse-id migration, including aliases whose
// sessions are no longer in the roster. POSIX double-slash paths stay case-sensitive.
export function windowsProjectSectionKey(path: string): string | null {
  if (!isWindowsCheckoutPath(path)) {
    return null;
  }
  const projectPath = foldCheckoutPath(path, true);
  return projectPath ? `project:${projectPath.replace(/\//g, "\\").toLowerCase()}` : null;
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
  const customGroupsByName = new Map<string, CatalogProjectGroup>();
  const projectGroupsByPath = new Map<string, CatalogProjectGroup>();
  const ungrouped: SessionCatalogSession[] = [];

  for (const session of sessions) {
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
      }
      group.sessions.push(session);
      continue;
    }
    // Paths without a project identity fall to the ungrouped flat tail;
    // do not invent a project name when canonicalization returns no origin.
    const trimmedPath = session.cwd?.trim();
    const projectPath = trimmedPath
      ? foldCheckoutPath(trimmedPath, isWindowsCheckoutPath(trimmedPath))
      : null;
    if (!projectPath) {
      ungrouped.push(session);
      continue;
    }
    // State identity must survive roster reordering; only display text comes
    // from the first member. The renderer migrates earlier spelling-based ids.
    const key = windowsProjectSectionKey(projectPath) ?? `project:${projectPath}`;
    let group = projectGroupsByPath.get(key);
    if (!group) {
      group = {
        kind: "project",
        key,
        legacySectionKey: projectPath,
        label: pathDisplayName(projectPath),
        title: projectPath,
        sessions: [],
      };
      projectGroupsByPath.set(key, group);
    }
    group.sessions.push(session);
  }

  return { groups: [...customGroupsByName.values(), ...projectGroupsByPath.values()], ungrouped };
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
