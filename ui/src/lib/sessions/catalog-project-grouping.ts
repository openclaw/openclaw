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
  const match = trimmed.match(/^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]/);
  return match ? match[1] || null : trimmed;
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
        ? (groups.get(`project:${projectPath}`) ?? {
            kind: "project",
            key: `project:${projectPath}`,
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
