import type { ProjectRecord } from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { projectsForGateway, type ProjectCatalog } from "../../lib/projects.ts";
import { createSharedOwnerProjection } from "../../lib/reactive/shared-owner-projection.ts";

export type RepositoryProjects = {
  status: "loading" | "ready" | "failed";
  projects: readonly ProjectRecord[];
};

// Worktree choices come from the shared catalog, which owns connection and config refreshes.
// Agent workspaces are often plain folders, so only registered or cloned checkouts qualify.
const repositoryProjects = createSharedOwnerProjection(
  (catalog: ProjectCatalog): RepositoryProjects => {
    const { result, ready, error } = catalog.snapshot;
    return {
      status: ready ? "ready" : error ? "failed" : "loading",
      projects:
        result?.projects.filter(
          (project) => project.source !== "workspace" && Boolean(project.repoRoot),
        ) ?? [],
    };
  },
);

export function readRepositoryProjects(gateway: ApplicationGateway): RepositoryProjects {
  return repositoryProjects(projectsForGateway(gateway)).read();
}
