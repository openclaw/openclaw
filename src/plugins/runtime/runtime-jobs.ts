import {
  canAttachTaskFlowForDurableJob,
  getDurableJobByIdForOwner,
  listDurableJobTransitionsForOwner,
  listDurableJobsForOwner,
} from "../../tasks/durable-job-owner-access.js";
import {
  createDurableJobRecord,
  isDurableJobTransitionDispositionRequired,
  recordDurableJobTransition,
  updateDurableJobRecordByIdExpectedRevision,
} from "../../tasks/durable-job-registry.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type {
  BoundDurableJobsRuntime,
  DurableJobAttachTaskFlowResult,
  DurableJobListParams,
  DurableJobRuntimeTransitionResult,
  DurableJobRuntimeUpdateResult,
  PluginRuntimeJobs,
} from "./runtime-jobs.types.js";
export type {
  BoundDurableJobsRuntime,
  DurableJobAttachTaskFlowResult,
  DurableJobListParams,
  DurableJobRuntimeTransitionParams,
  DurableJobRuntimeTransitionResult,
  DurableJobRuntimeUpdateResult,
  PluginRuntimeJobs,
} from "./runtime-jobs.types.js";

function assertSessionKey(sessionKey: string | undefined, errorMessage: string): string {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    throw new Error(errorMessage);
  }
  return normalized;
}

function mapUpdateResult(
  result: ReturnType<typeof updateDurableJobRecordByIdExpectedRevision>,
): DurableJobRuntimeUpdateResult {
  return result.applied
    ? { applied: true, job: result.job }
    : {
        applied: false,
        reason: result.reason,
        ...(result.current ? { current: result.current } : {}),
      };
}

function normalizeStatuses(params?: DurableJobListParams): Set<string> | undefined {
  if (!params?.status) {
    return undefined;
  }
  const statuses = Array.isArray(params.status) ? params.status : [params.status];
  return new Set(statuses);
}

function createBoundDurableJobsRuntime(params: {
  sessionKey: string;
  requesterOrigin?: import("../../tasks/durable-job-registry.types.js").DurableJobRecord["requesterOrigin"];
}): BoundDurableJobsRuntime {
  const ownerKey = assertSessionKey(
    params.sessionKey,
    "Durable jobs runtime requires a bound sessionKey.",
  );
  const requesterOrigin = params.requesterOrigin
    ? normalizeDeliveryContext(params.requesterOrigin)
    : undefined;

  return {
    sessionKey: ownerKey,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    create: (input) => {
      if (input.ownerSessionKey && input.ownerSessionKey !== ownerKey) {
        throw new Error("Durable jobs runtime is owner-scoped to the bound sessionKey.");
      }
      return createDurableJobRecord({
        ...input,
        ownerSessionKey: ownerKey,
        requesterOrigin: input.requesterOrigin ?? requesterOrigin,
      });
    },
    get: (jobId) =>
      getDurableJobByIdForOwner({
        jobId,
        callerOwnerKey: ownerKey,
      }),
    list: (listParams) => {
      const statuses = normalizeStatuses(listParams);
      return listDurableJobsForOwner({ callerOwnerKey: ownerKey }).filter(
        (job) => !statuses || statuses.has(job.status),
      );
    },
    update: ({ jobId, expectedRevision, patch, updatedAt }) => {
      const current = getDurableJobByIdForOwner({
        jobId,
        callerOwnerKey: ownerKey,
      });
      if (!current) {
        return { applied: false, reason: "not_found" };
      }
      return mapUpdateResult(
        updateDurableJobRecordByIdExpectedRevision({
          jobId,
          expectedRevision,
          patch,
          updatedAt,
        }),
      );
    },
    transition: ({ jobId, expectedRevision, from, to, reason, actor, at, disposition, patch }) => {
      const current = getDurableJobByIdForOwner({
        jobId,
        callerOwnerKey: ownerKey,
      });
      if (!current) {
        return { applied: false, reason: "not_found" };
      }
      if (from && current.status !== from) {
        return {
          applied: false,
          reason: "status_conflict",
          current,
        };
      }
      if (isDurableJobTransitionDispositionRequired(to) && !disposition) {
        return {
          applied: false,
          reason: "disposition_required",
          current,
        };
      }
      const updatedAt = at ?? Date.now();
      const updated = updateDurableJobRecordByIdExpectedRevision({
        jobId,
        expectedRevision,
        patch: {
          ...patch,
          status: to,
        },
        updatedAt,
      });
      if (!updated.applied) {
        return {
          applied: false,
          reason: updated.reason,
          ...(updated.current ? { current: updated.current } : {}),
        };
      }
      const transition = recordDurableJobTransition({
        jobId,
        from: current.status,
        to,
        reason,
        actor,
        at: updatedAt,
        disposition,
        revision: updated.job.audit.revision,
      });
      return {
        applied: true,
        job: updated.job,
        transition,
      } satisfies DurableJobRuntimeTransitionResult;
    },
    history: (jobId) =>
      listDurableJobTransitionsForOwner({
        jobId,
        callerOwnerKey: ownerKey,
      }),
    attachTaskFlow: ({ jobId, flowId, expectedRevision, updatedAt }) => {
      const current = getDurableJobByIdForOwner({
        jobId,
        callerOwnerKey: ownerKey,
      });
      if (!current) {
        return { applied: false, reason: "not_found" };
      }
      if (!canAttachTaskFlowForDurableJob({ flowId, callerOwnerKey: ownerKey })) {
        return {
          applied: false,
          reason: "taskflow_not_found",
          current,
        } satisfies DurableJobAttachTaskFlowResult;
      }
      return mapUpdateResult(
        updateDurableJobRecordByIdExpectedRevision({
          jobId,
          expectedRevision,
          patch: {
            backing: {
              ...current.backing,
              taskFlowId: flowId,
            },
          },
          updatedAt,
        }),
      );
    },
  };
}

export function createRuntimeJobs(): PluginRuntimeJobs {
  return {
    bindSession: (params) =>
      createBoundDurableJobsRuntime({
        sessionKey: params.sessionKey,
        requesterOrigin: params.requesterOrigin,
      }),
    fromToolContext: (ctx) =>
      createBoundDurableJobsRuntime({
        sessionKey: assertSessionKey(
          ctx.sessionKey,
          "Durable jobs runtime requires tool context with a sessionKey.",
        ),
        requesterOrigin: ctx.deliveryContext,
      }),
  };
}
