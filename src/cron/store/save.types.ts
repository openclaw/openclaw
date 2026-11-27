import type { CronQuarantinedJob, QuarantinedCronConfigJob } from "../types-shared.js";
import type { CronStoredJob } from "../types.js";
import type { LoadedCronStore } from "./types.js";

export type CronStoreSaveOptions = {
  stateOnly?: boolean;
  quarantine?: {
    entries: readonly (QuarantinedCronConfigJob | CronQuarantinedJob)[];
    nowMs: number;
    /** Load-time cleanup removes only the rows at the recorded source indexes. */
    source?: Pick<LoadedCronStore, "jobsFingerprint" | "runtimeFingerprint">;
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
