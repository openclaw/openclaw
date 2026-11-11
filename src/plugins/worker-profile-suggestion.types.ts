import type { CloudWorkerProfileConfig } from "../config/types.cloud-workers.js";

/** A proposed config entry; it cannot be used for placement until the Gateway saves it. */
export type SuggestedWorkerProfile = {
  id: string;
  profile: CloudWorkerProfileConfig;
  providerDisplayId?: string;
};

/** Plugin-owned discovery caches belong to the setup inventory; adoption explicitly refreshes them. */
export type WorkerProfileSuggestionDiscovery = (params: {
  refresh?: boolean;
}) => Promise<SuggestedWorkerProfile | undefined>;
