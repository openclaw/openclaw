import type { CronStoredJob } from "../types.js";
import type { CronQuarantinedJob, QuarantinedCronConfigJob } from "./types.js";

export type CronStoreSaveOptions = {
  stateOnly?: boolean;
  quarantine?: {
    entries: readonly (QuarantinedCronConfigJob | CronQuarantinedJob)[];
    nowMs: number;
  };
  preserveRuntimeState?: boolean;
  deleteQuarantineEntries?: readonly (QuarantinedCronConfigJob | CronQuarantinedJob)[];
};

export type CronStoreChangesOptions = {
  preserveConcurrentAdds?: boolean;
};

export type PreparedCronStoreChanges = {
  previousById: Map<string, CronStoredJob>;
  nextById: Map<string, CronStoredJob>;
  changedIds: Set<string>;
};
