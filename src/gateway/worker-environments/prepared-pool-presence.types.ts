import type { ImageReserveProject } from "./image-reserve.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";

export type PreparedPoolPresenceDemand = {
  revision: number;
  profileId: string;
  requestedRef: string | null;
  preparationKey: string;
  project: RepositoryWorkerProjectSnapshot | ImageReserveProject;
  lastPresentAtMs: number;
  retireAtMs: number | null;
};
