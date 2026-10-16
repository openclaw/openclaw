import type { CronRuntimeAuthority } from "../runtime-authority.js";
import type { CronScheduledToolPolicy } from "../scheduled-tool-policy.js";
import type { CronNotificationIntent } from "../service/notification-intents.js";
import type { CronAddOptions } from "../service/state.js";
import type { CronJobCreate, CronJobPatch, CronStoredJob, CronStoreFile } from "../types.js";
import type { CronRunRecoveryOutcome } from "./run-recovery.types.js";
import type { CronSchedulerSnapshot } from "./scheduler-actor.types.js";

/** Only captured facts cross this boundary; callbacks and live authority stay on the host. */
type CronJobMutationOptions = Pick<
  CronAddOptions,
  | "enabledExplicit"
  | "systemOwned"
  | "createdActor"
  | "inferenceBinding"
  | "sourceConversation"
  | "skillLibrarySelections"
  | "toolsAllowProvenance"
  | "toolsAllowExecTarget"
> & {
  scheduledToolPolicy?: CronScheduledToolPolicy | null;
  captured: boolean;
  runtimeAuthority?: CronRuntimeAuthority;
};

export type CronJobMutation =
  | {
      kind: "add";
      input: CronJobCreate;
      matchingJobIds?: string[];
      options: CronJobMutationOptions;
    }
  | { kind: "update"; id: string; patch: CronJobPatch; options: CronJobMutationOptions }
  | { kind: "remove"; ids: string[]; systemOwned?: boolean };

export type CronJobMutationSnapshot = {
  nowMs: number;
  scheduler?: CronSchedulerSnapshot;
};

export type CronJobMutationPlan = {
  previous: CronStoreFile;
  next: CronStoreFile;
  job?: CronStoredJob;
  created?: boolean;
  updated?: boolean;
  notifications: CronNotificationIntent[];
  logs: CronRunRecoveryOutcome["logs"];
};
