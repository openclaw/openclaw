import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ProjectRecent } from "../../../packages/gateway-protocol/src/index.js";
import { sessionCreatorProfileId } from "../../config/sessions/session-entry-provenance.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { ProjectRegistryRecord } from "../../projects/project-registry.types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  findSessionRepositoryWorkspaces,
  getSessionRepositoryWorkspaceStore,
} from "../../state/session-repository-workspaces.js";

function folderDisplayName(folder: string): string {
  const trimmed = folder.replace(/[\\/]+$/u, "");
  return trimmed.split(/[\\/]/u).at(-1) || folder;
}

function indexPathProjects(projects: readonly ProjectRegistryRecord[]) {
  const byPath = new Map<string, ProjectRegistryRecord>();
  const byAgent = new Map<string | undefined, ProjectRegistryRecord>();
  for (const project of projects) {
    // The registry emits one workspace per unique configured agent.
    if (project.source === "workspace") {
      byAgent.set(project.agentId, project);
    }
    const previous = byPath.get(project.repoRoot);
    if (
      !previous ||
      (Number(project.source === "workspace") - Number(previous.source === "workspace") ||
        project.id.localeCompare(previous.id)) < 0
    ) {
      byPath.set(project.repoRoot, project);
    }
  }
  return { byPath, byAgent };
}

export async function listProjectRecents(
  store: Record<string, SessionEntry>,
  getSessionAgentId: (key: string) => string | undefined,
  profileIds: ReadonlySet<string>,
  projects: readonly ProjectRegistryRecord[],
  usedSessions: Set<string>,
): Promise<ProjectRecent[]> {
  const candidates = Object.entries(store)
    .filter(
      ([, entry]) =>
        Boolean(sessionCreatorProfileId(entry.createdActor)) &&
        Boolean(entry.createdActor?.id && profileIds.has(entry.createdActor.id)),
    )
    .toSorted(
      ([leftKey, left], [rightKey, right]) =>
        (right.updatedAt ?? 0) - (left.updatedAt ?? 0) || leftKey.localeCompare(rightKey),
    );
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const seen = new Set<string>();
  const recents: ProjectRecent[] = [];
  let pathProjects: ReturnType<typeof indexPathProjects> | undefined;
  // Stop fetching once the picker is full, while bounding worker round trips for long histories.
  for (let offset = 0; offset < candidates.length && recents.length < 8; offset += 64) {
    const batch = candidates.slice(offset, offset + 64);
    const repositoryCandidates = batch.flatMap(([sessionKey, entry]) => {
      const agentId = getSessionAgentId(sessionKey);
      return entry.repositoryWorkspaceId && agentId ? [{ agentId, sessionKey }] : [];
    });
    const repositories = new Map(
      (repositoryCandidates.length
        ? await findSessionRepositoryWorkspaces(repositoryCandidates, {
            path: getSessionRepositoryWorkspaceStore().path,
          })
        : []
      ).map((repository) => [repository.workspaceId, repository]),
    );
    for (const [sessionKey, entry] of batch) {
      if (entry.repositoryWorkspaceId) {
        const repository = repositories.get(entry.repositoryWorkspaceId);
        const sessionAgentId = parseAgentSessionKey(sessionKey)?.agentId;
        if (
          !repository ||
          repository.sessionKey !== sessionKey ||
          (sessionAgentId && repository.agentId !== sessionAgentId) ||
          seen.has(repository.url)
        ) {
          continue;
        }
        seen.add(repository.url);
        usedSessions.add(sessionKey);
        recents.push({
          kind: "repository",
          url: repository.url,
          displayName: path.posix.basename(repository.url, ".git"),
        });
        if (recents.length === 8) {
          break;
        }
        continue;
      }
      const projectId = normalizeOptionalString(entry.projectId);
      const explicitProject = projectId ? projectsById.get(projectId) : undefined;
      const worktreeRoot = normalizeOptionalString(entry.worktree?.repoRoot);
      const spawnedCwd = normalizeOptionalString(entry.spawnedCwd);
      const execCwd = normalizeOptionalString(entry.execCwd);
      const folder = worktreeRoot ?? spawnedCwd ?? execCwd;
      let project = explicitProject;
      if (!project && folder) {
        const agentId = parseAgentSessionKey(sessionKey)?.agentId;
        const indexed = (pathProjects ??= indexPathProjects(projects));
        const workspace = indexed.byAgent.get(agentId);
        project = workspace?.repoRoot === folder ? workspace : indexed.byPath.get(folder);
      }
      const key = project
        ? `project:${project.id}`
        : folder
          ? `folder:${normalizeOptionalString(entry.execNode) ?? ""}\0${folder}`
          : undefined;
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      usedSessions.add(sessionKey);
      recents.push(
        project
          ? { kind: "project", projectId: project.id, displayName: project.displayName }
          : {
              kind: "folder",
              folder: folder!,
              displayName: folderDisplayName(folder!),
              ...(normalizeOptionalString(entry.execNode)
                ? { execNode: normalizeOptionalString(entry.execNode) }
                : {}),
            },
      );
      if (recents.length === 8) {
        break;
      }
    }
  }
  return recents;
}
