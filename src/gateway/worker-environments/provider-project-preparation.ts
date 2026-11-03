import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RepositorySources } from "../repository-sources.js";
import type { WorkerProjectPreparationIdentity } from "./preparation-identity.schema.js";
import { createWorkerProjectPreparation } from "./project-preparation.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import type { WorkerProjectSnapshot } from "./workspace-git-base.js";

export type WorkerProviderRepositorySource = Awaited<
  ReturnType<typeof prepareRepositoryWorkerProjectSource>
>;

export async function prepareWorkerProviderProject(params: {
  project: WorkerProjectSnapshot;
  preparation: WorkerProjectPreparationIdentity | undefined;
  record: Pick<WorkerEnvironmentRecord, "preparation" | "createdAtMs">;
  namespace: string;
  getConfig: () => OpenClawConfig;
  getRepositorySources?: () => RepositorySources;
  requireCurrent: () => void;
  signal?: AbortSignal;
  repositorySource?: WorkerProviderRepositorySource;
}) {
  const { project, preparation, record } = params;
  const repository =
    "source" in project
      ? (params.repositorySource ??
        (await prepareRepositoryWorkerProjectSource({
          expected: project,
          namespace: params.namespace,
          getConfig: params.getConfig,
          getRepositorySources: params.getRepositorySources,
          assertCurrent: params.requireCurrent,
          signal: params.signal,
          knownRecipe: preparation
            ? () => ({ setupRecipe: preparation.setupRecipe, recipe: preparation.recipe })
            : undefined,
        })))
      : undefined;
  params.requireCurrent();
  if (repository && preparation && repository.setupRecipe !== preparation.setupRecipe) {
    throw new Error("Prepared repository recipe no longer matches its admission");
  }
  return createWorkerProjectPreparation({
    project,
    namespace: params.namespace,
    ...(repository
      ? {
          revalidateRepositorySource: (signal: AbortSignal) => repository.revalidate(signal),
          prepareRepositoryGitPack: repository.prepareGitPack,
        }
      : {}),
    preparation: preparation
      ? {
          ...preparation,
          purpose: record.preparation ? "reserve" : "session",
          demandAtMs: record.preparation?.demandAtMs ?? record.createdAtMs,
        }
      : undefined,
    setupAuthorized: true,
    signal: params.signal,
    requireCurrent: () => {
      params.requireCurrent();
      repository?.assertCurrent();
    },
  });
}

/** Fixed source selection retained through provider preparation. */
export type WorkerProviderRepositoryIntent = {
  agentId: string;
  url: string;
  ref?: string;
  baseCommit?: string;
  repositorySourceId?: string;
  workspaceId?: string;
};
