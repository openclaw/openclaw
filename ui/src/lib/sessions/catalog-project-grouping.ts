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
  const pattern = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]/;
  const match = trimmed.match(isWindowsProjectPath(path) ? new RegExp(pattern, "i") : pattern);
  const folded = match ? match[1] || null : trimmed;
  return folded && /^[a-z]:$/i.test(folded) && /^[a-z]:[\\/]/i.test(path)
    ? `${folded}${path[2]}`
    : folded;
}

function isWindowsProjectPath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\");
}

function projectPathKey(path: string): string {
  if (/^[a-z]:$/i.test(path)) {
    return `drive-relative:${path.toLowerCase()}`;
  }
  return isWindowsProjectPath(path) ? path.replaceAll("\\", "/").toLowerCase() : path;
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

export function catalogProjectSectionAliases(
  group: CatalogProjectGroup,
  catalogId: string,
  hostId: string,
  collapsed: ReadonlySet<string>,
): string[] {
  const prefix = `catalog-project:${catalogId}:${hostId}:`;
  const aliases = group.legacySectionKey ? [`${prefix}${group.legacySectionKey}`] : [];
  if (group.kind !== "project") {
    return aliases;
  }
  // Old drive-root ids lost their separator. Keep actual drive-relative roots
  // in their own namespace instead of inheriting that ambiguous preference.
  if (/^[a-z]:$/i.test(group.title)) {
    return [];
  }
  if (!isWindowsProjectPath(group.title)) {
    return aliases;
  }
  for (const id of collapsed) {
    if (!id.startsWith(prefix)) {
      continue;
    }
    const suffix = id.slice(prefix.length).replace(/^project:/, "");
    const path = /^[a-z]:$/i.test(suffix) ? `${suffix}/` : foldWorktreeCheckoutPath(suffix);
    if (path && `project:${projectPathKey(path)}` === group.key) {
      aliases.push(id);
    }
  }
  return aliases;
}

function collectCatalogGroups(
  sessions: readonly SessionCatalogSession[],
  resolve: (
    session: SessionCatalogSession,
    groups: ReadonlyMap<string, CatalogProjectGroup>,
  ) => CatalogProjectGroup | null,
  compare: (left: CatalogProjectGroup, right: CatalogProjectGroup) => number,
): { groups: CatalogProjectGroup[]; ungrouped: SessionCatalogSession[] } {
  const groups = new Map<string, CatalogProjectGroup>();
  const ungrouped: SessionCatalogSession[] = [];
  for (const session of sessions) {
    const group = resolve(session, groups);
    if (!group) {
      ungrouped.push(session);
      continue;
    }
    group.sessions.push(session);
    groups.set(group.key, group);
  }
  return { groups: [...groups.values()].toSorted(compare), ungrouped };
}

export function groupCatalogSessionsByProject(sessions: readonly SessionCatalogSession[]) {
  return collectCatalogGroups(
    sessions,
    (session, groups) => {
      const customGroup = session.customGroup?.trim();
      if (customGroup) {
        const key = `custom:${customGroup}`;
        return (
          groups.get(key) ?? {
            kind: "custom",
            key,
            legacySectionKey: key,
            label: customGroup,
            title: `Custom group: ${customGroup}`,
            sessions: [],
          }
        );
      }
      // Missing project identities stay in the flat tail, including worktrees with no origin.
      const trimmedPath = session.cwd?.trim();
      const projectPath = trimmedPath ? foldWorktreeCheckoutPath(trimmedPath) : null;
      return projectPath
        ? (groups.get(`project:${projectPathKey(projectPath)}`) ?? {
            kind: "project",
            key: `project:${projectPathKey(projectPath)}`,
            legacySectionKey: projectPath,
            label: pathDisplayName(projectPath),
            title: projectPath,
            sessions: [],
          })
        : null;
    },
    // Preserve first occurrence within each kind, with custom groups ahead of projects.
    (left, right) => Number(right.kind === "custom") - Number(left.kind === "custom"),
  );
}

/** Native threads have no attributed creator until the Gateway adopts them. */
export function groupCatalogSessionsByPerson(sessions: readonly SessionCatalogSession[]) {
  return collectCatalogGroups(
    sessions,
    (session, groups) => {
      const actor = session.createdActor;
      const actorGroupId = sessionActorGroupId(actor);
      if (!actor?.identity || !actorGroupId) {
        return null;
      }
      const key = `person:${actorGroupId}`;
      const existing = groups.get(key);
      if (existing) {
        return existing;
      }
      const label =
        actor.identity.type === "profile"
          ? presenceViewerLabel({
              id: actor.identity.id,
              name: actor.label?.trim() || undefined,
            })
          : actor.label?.trim() || actor.identity.id;
      return {
        kind: "person",
        key,
        legacySectionKey: `person:${actor.id}`,
        label,
        title: `Created by ${label}`,
        sessions: [],
      };
    },
    (left, right) => left.label.localeCompare(right.label),
  );
}
