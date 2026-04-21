import type {
  DurableJobCreateInput,
  DurableJobDispositionNotification,
  DurableJobDispositionWake,
  DurableJobNotifyPolicy,
  DurableJobRecord,
  DurableJobSource,
  DurableJobStatus,
  DurableJobStopCondition,
  DurableJobTransitionDisposition,
  DurableJobTransitionRecord,
  DurableJobUpdateInput,
} from "../../tasks/durable-job-registry.types.js";
import type { OpenClawPluginToolContext } from "../tool-types.js";

export type {
  DurableJobBacking,
  DurableJobCreateInput,
  DurableJobDispositionNotification,
  DurableJobDispositionWake,
  DurableJobNotifyPolicy,
  DurableJobRecord,
  DurableJobSource,
  DurableJobStatus,
  DurableJobStopCondition,
  DurableJobTransitionDisposition,
  DurableJobTransitionRecord,
  DurableJobUpdateInput,
} from "../../tasks/durable-job-registry.types.js";

export type DurableJobListParams = {
  status?: DurableJobStatus | DurableJobStatus[];
};

export type DurableJobRuntimeMutationFailureReason =
  | "not_found"
  | "revision_conflict"
  | "status_conflict"
  | "disposition_required";

export type DurableJobRuntimeUpdateResult =
  | {
      applied: true;
      job: DurableJobRecord;
    }
  | {
      applied: false;
      reason: DurableJobRuntimeMutationFailureReason;
      current?: DurableJobRecord;
    };

export type DurableJobRuntimeTransitionParams = {
  jobId: string;
  expectedRevision: number;
  from?: DurableJobStatus;
  to: DurableJobStatus;
  reason?: string | null;
  actor?: string | null;
  at?: number;
  disposition?: DurableJobTransitionDisposition;
  dispositionKind?: string;
  notification?: DurableJobDispositionNotification | null;
  wake?: DurableJobDispositionWake | null;
  patch?: Omit<DurableJobUpdateInput, "status">;
};

export type DurableJobRuntimeTransitionResult =
  | {
      applied: true;
      job: DurableJobRecord;
      transition: DurableJobTransitionRecord;
    }
  | {
      applied: false;
      reason: DurableJobRuntimeMutationFailureReason;
      current?: DurableJobRecord;
    };

export type DurableJobAttachTaskFlowResult =
  | {
      applied: true;
      job: DurableJobRecord;
    }
  | {
      applied: false;
      reason: DurableJobRuntimeMutationFailureReason | "taskflow_not_found";
      current?: DurableJobRecord;
    };

export type BoundDurableJobsRuntime = {
  readonly sessionKey: string;
  readonly requesterOrigin?: DurableJobRecord["requesterOrigin"];
  create: (
    input: Omit<DurableJobCreateInput, "ownerSessionKey" | "requesterOrigin"> & {
      ownerSessionKey?: string;
      requesterOrigin?: DurableJobRecord["requesterOrigin"];
      stopCondition: DurableJobStopCondition;
      notifyPolicy: DurableJobNotifyPolicy;
      source?: DurableJobSource;
    },
  ) => DurableJobRecord;
  get: (jobId: string) => DurableJobRecord | undefined;
  list: (params?: DurableJobListParams) => DurableJobRecord[];
  update: (params: {
    jobId: string;
    expectedRevision: number;
    patch: DurableJobUpdateInput;
    updatedAt?: number;
  }) => DurableJobRuntimeUpdateResult;
  transition: (params: DurableJobRuntimeTransitionParams) => DurableJobRuntimeTransitionResult;
  history: (jobId: string) => DurableJobTransitionRecord[];
  attachTaskFlow: (params: {
    jobId: string;
    flowId: string;
    expectedRevision: number;
    updatedAt?: number;
  }) => DurableJobAttachTaskFlowResult;
};

export type PluginRuntimeJobs = {
  bindSession: (params: {
    sessionKey: string;
    requesterOrigin?: DurableJobRecord["requesterOrigin"];
  }) => BoundDurableJobsRuntime;
  fromToolContext: (
    ctx: Pick<OpenClawPluginToolContext, "sessionKey" | "deliveryContext">,
  ) => BoundDurableJobsRuntime;
};
