import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";

export type PreparedPoolPresenceDemand = {
  revision: number;
  profileId: string;
  requestedRef: string | null;
  preparationKey: string;
  project: RepositoryWorkerProjectSnapshot;
  lastPresentAtMs: number;
  retireAtMs: number | null;
};
