import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { WorkerProjectPreparationIdentity } from "./preparation-identity.js";
import { createWorkerProjectPreparation } from "./project-preparation.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import type { WorkerProjectSnapshot } from "./workspace-git-base.js";

export async function prepareWorkerProviderProject(params: {
  project: WorkerProjectSnapshot;
  preparation: WorkerProjectPreparationIdentity | undefined;
  record: Pick<WorkerEnvironmentRecord, "preparation" | "createdAtMs">;
  namespace: string;
  getConfig: () => OpenClawConfig;
  requireCurrent: () => void;
  signal?: AbortSignal;
}) {
  const { project, preparation, record } = params;
  const repository =
    "source" in project
      ? await prepareRepositoryWorkerProjectSource({
          expected: project,
          namespace: params.namespace,
          getConfig: params.getConfig,
          assertCurrent: params.requireCurrent,
          signal: params.signal,
          knownRecipe: preparation
            ? () => ({ project, setupRecipe: preparation.setupRecipe })
            : undefined,
        })
      : undefined;
  params.requireCurrent();
  if ("source" in project && !repository) {
    throw new Error("Prepared repository is no longer public");
  }
  if (repository && preparation && repository.setupRecipe !== preparation.setupRecipe) {
    throw new Error("Prepared repository recipe no longer matches its admission");
  }
  return createWorkerProjectPreparation({
    project,
    namespace: params.namespace,
    ...(repository ? { revalidateRepositorySource: repository.revalidate } : {}),
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
