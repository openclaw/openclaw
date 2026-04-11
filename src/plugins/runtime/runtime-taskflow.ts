import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  cancelFlowByIdForOwner,
  getFlowTaskSummary,
  runTaskInFlowForOwner,
} from "../../tasks/task-executor.js";
import {
  findLatestTaskFlowForOwner,
  getTaskFlowByIdForOwner,
  listTaskFlowsForOwner,
  resolveTaskFlowForLookupTokenForOwner,
} from "../../tasks/task-flow-owner-access.js";
import type { TaskFlowRecord, JsonValue } from "../../tasks/task-flow-registry.types.js";
import {
  createManagedTaskFlow,
  failFlow,
  finishFlow,
  type TaskFlowUpdateResult,
  requestFlowCancel,
  resumeFlow,
  setFlowWaiting,
} from "../../tasks/task-flow-runtime-internal.js";
import type {
  TaskDeliveryStatus,
  TaskDeliveryState,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRegistrySummary,
  TaskRuntime,
} from "../../tasks/task-registry.types.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import type { OpenClawPluginToolContext } from "../tool-types.js";

export type ManagedTaskFlowRecord = TaskFlowRecord & {
  syncMode: "managed";
  controllerId: string;
};

export type ManagedTaskFlowMutationErrorCode = "not_found" | "not_managed" | "revision_conflict";

export type ManagedTaskFlowMutationResult =
  | {
      applied: true;
      flow: ManagedTaskFlowRecord;
    }
  | {
      applied: false;
      code: ManagedTaskFlowMutationErrorCode;
      current?: TaskFlowRecord;
    };

export type BoundTaskFlowTaskRunResult =
  | {
      created: true;
      flow: ManagedTaskFlowRecord;
      task: TaskRecord;
    }
  | {
      created: false;
      reason: string;
      found: boolean;
      flow?: TaskFlowRecord;
    };

export type BoundTaskFlowCancelResult = Awaited<ReturnType<typeof cancelFlowByIdForOwner>>;

export type BoundTaskFlowRuntime = {
  readonly sessionKey: string;
  readonly requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  createManaged: (params: {
    controllerId: string;
    goal: string;
    status?: ManagedTaskFlowRecord["status"];
    notifyPolicy?: TaskNotifyPolicy;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    waitJson?: JsonValue | null;
    cancelRequestedAt?: number | null;
    createdAt?: number;
    updatedAt?: number;
    endedAt?: number | null;
  }) => ManagedTaskFlowRecord;
  get: (flowId: string) => TaskFlowRecord | undefined;
  list: () => TaskFlowRecord[];
  findLatest: () => TaskFlowRecord | undefined;
  resolve: (token: string) => TaskFlowRecord | undefined;
  getTaskSummary: (flowId: string) => TaskRegistrySummary | undefined;
  setWaiting: (params: {
    flowId: string;
    expectedRevision: number;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    waitJson?: JsonValue | null;
    blockedTaskId?: string | null;
    blockedSummary?: string | null;
    updatedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  resume: (params: {
    flowId: string;
    expectedRevision: number;
    status?: Extract<ManagedTaskFlowRecord["status"], "queued" | "running">;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    updatedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  finish: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: JsonValue | null;
    updatedAt?: number;
    endedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  fail: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: JsonValue | null;
    blockedTaskId?: string | null;
    blockedSummary?: string | null;
    updatedAt?: number;
    endedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  requestCancel: (params: {
    flowId: string;
    expectedRevision: number;
    cancelRequestedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  cancel: (params: { flowId: string; cfg: OpenClawConfig }) => Promise<BoundTaskFlowCancelResult>;
  runTask: (params: {
    flowId: string;
    runtime: TaskRuntime;
    sourceId?: string;
    childSessionKey?: string;
    parentTaskId?: string;
    agentId?: string;
    runId?: string;
    label?: string;
    task: string;
    preferMetadata?: boolean;
    notifyPolicy?: TaskNotifyPolicy;
    deliveryStatus?: TaskDeliveryStatus;
    status?: "queued" | "running";
    startedAt?: number;
    lastEventAt?: number;
    progressSummary?: string | null;
  }) => BoundTaskFlowTaskRunResult;
};

export type PluginRuntimeTaskFlow = {
  bindSession: (params: {
    sessionKey: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  }) => BoundTaskFlowRuntime;
  fromToolContext: (
    ctx: Pick<OpenClawPluginToolContext, "sessionKey" | "deliveryContext">,
  ) => BoundTaskFlowRuntime;
};

function assertSessionKey(sessionKey: string | undefined, errorMessage: string): string {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    throw new Error(errorMessage);
  }
  return normalized;
}

function asManagedTaskFlowRecord(
  flow: TaskFlowRecord | undefined,
): ManagedTaskFlowRecord | undefined {
  if (!flow || flow.syncMode !== "managed" || !flow.controllerId) {
    return undefined;
  }
  return flow as ManagedTaskFlowRecord;
}

function resolveManagedFlowForOwner(params: {
  flowId: string;
  ownerKey: string;
}):
  | { ok: true; flow: ManagedTaskFlowRecord }
  | { ok: false; code: "not_found" | "not_managed"; current?: TaskFlowRecord } {
  const flow = getTaskFlowByIdForOwner({
    flowId: params.flowId,
    callerOwnerKey: params.ownerKey,
  });
  if (!flow) {
    return { ok: false, code: "not_found" };
  }
  const managed = asManagedTaskFlowRecord(flow);
  if (!managed) {
    return { ok: false, code: "not_managed", current: flow };
  }
  return { ok: true, flow: managed };
}

function mapFlowUpdateResult(result: TaskFlowUpdateResult): ManagedTaskFlowMutationResult {
  if (result.applied) {
    const managed = asManagedTaskFlowRecord(result.flow);
    if (!managed) {
      return {
        applied: false,
        code: "not_managed",
        current: result.flow,
      };
    }
    return {
      applied: true,
      flow: managed,
    };
  }
  return {
    applied: false,
    code: result.reason,
    ...(result.current ? { current: result.current } : {}),
  };
}

function createBoundTaskFlowRuntime(params: {
  sessionKey: string;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
}): BoundTaskFlowRuntime {
  const ownerKey = assertSessionKey(
    params.sessionKey,
    "TaskFlow runtime requires a bound sessionKey.",
  );
  const requesterOrigin = params.requesterOrigin
    ? normalizeDeliveryContext(params.requesterOrigin)
    : undefined;

  return {
    sessionKey: ownerKey,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    createManaged: (input) =>
      createManagedTaskFlow({
        ownerKey,
        controllerId: input.controllerId,
        requesterOrigin,
        status: input.status,
        notifyPolicy: input.notifyPolicy,
        goal: input.goal,
        currentStep: input.currentStep,
        stateJson: input.stateJson,
        waitJson: input.waitJson,
        cancelRequestedAt: input.cancelRequestedAt,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        endedAt: input.endedAt,
      }) as ManagedTaskFlowRecord,
    get: (flowId) =>
      getTaskFlowByIdForOwner({
        flowId,
        callerOwnerKey: ownerKey,
      }),
    list: () =>
      listTaskFlowsForOwner({
        callerOwnerKey: ownerKey,
      }),
    findLatest: () =>
      findLatestTaskFlowForOwner({
        callerOwnerKey: ownerKey,
      }),
    resolve: (token) =>
      resolveTaskFlowForLookupTokenForOwner({
        token,
        callerOwnerKey: ownerKey,
      }),
    getTaskSummary: (flowId) => {
      const flow = getTaskFlowByIdForOwner({
        flowId,
        callerOwnerKey: ownerKey,
      });
      return flow ? getFlowTaskSummary(flow.flowId) : undefined;
    },
    setWaiting: (input) => {
      const flow = resolveManagedFlowForOwner({
        flowId: input.flowId,
        ownerKey,
      });
      if (!flow.ok) {
        return {
          applied: false,
          code: flow.code,
          ...(flow.current ? { current: flow.current } : {}),
        };
      }
      return mapFlowUpdateResult(
        setFlowWaiting({
          flowId: flow.flow.flowId,
          expectedRevision: input.expectedRevision,
          currentStep: input.currentStep,
          stateJson: input.stateJson,
          waitJson: input.waitJson,
          blockedTaskId: input.blockedTaskId,
          blockedSummary: input.blockedSummary,
          updatedAt: input.updatedAt,
        }),
      );
    },
    resume: (input) => {
      const flow = resolveManagedFlowForOwner({
        flowId: input.flowId,
        ownerKey,
      });
      if (!flow.ok) {
        return {
          applied: false,
          code: flow.code,
          ...(flow.current ? { current: flow.current } : {}),
        };
      }
      return mapFlowUpdateResult(
        resumeFlow({
          flowId: flow.flow.flowId,
          expectedRevision: input.expectedRevision,
          status: input.status,
          currentStep: input.currentStep,
          stateJson: input.stateJson,
          updatedAt: input.updatedAt,
        }),
      );
    },
    finish: (input) => {
      const flow = resolveManagedFlowForOwner({
        flowId: input.flowId,
        ownerKey,
      });
      if (!flow.ok) {
        return {
          applied: false,
          code: flow.code,
          ...(flow.current ? { current: flow.current } : {}),
        };
      }
      return mapFlowUpdateResult(
        finishFlow({
          flowId: flow.flow.flowId,
          expectedRevision: input.expectedRevision,
          stateJson: input.stateJson,
          updatedAt: input.updatedAt,
          endedAt: input.endedAt,
        }),
      );
    },
    fail: (input) => {
      const flow = resolveManagedFlowForOwner({
        flowId: input.flowId,
        ownerKey,
      });
      if (!flow.ok) {
        return {
          applied: false,
          code: flow.code,
          ...(flow.current ? { current: flow.current } : {}),
        };
      }
      return mapFlowUpdateResult(
        failFlow({
          flowId: flow.flow.flowId,
          expectedRevision: input.expectedRevision,
          stateJson: input.stateJson,
          blockedTaskId: input.blockedTaskId,
          blockedSummary: input.blockedSummary,
          updatedAt: input.updatedAt,
          endedAt: input.endedAt,
        }),
      );
    },
    requestCancel: (input) => {
      const flow = resolveManagedFlowForOwner({
        flowId: input.flowId,
        ownerKey,
      });
      if (!flow.ok) {
        return {
          applied: false,
          code: flow.code,
          ...(flow.current ? { current: flow.current } : {}),
        };
      }
      return mapFlowUpdateResult(
        requestFlowCancel({
          flowId: flow.flow.flowId,
          expectedRevision: input.expectedRevision,
          cancelRequestedAt: input.cancelRequestedAt,
        }),
      );
    },
    cancel: ({ flowId, cfg }) =>
      cancelFlowByIdForOwner({
        cfg,
        flowId,
        callerOwnerKey: ownerKey,
      }),
    runTask: (input) => {
      const created = runTaskInFlowForOwner({
        flowId: input.flowId,
        callerOwnerKey: ownerKey,
        runtime: input.runtime,
        sourceId: input.sourceId,
        childSessionKey: input.childSessionKey,
        parentTaskId: input.parentTaskId,
        agentId: input.agentId,
        runId: input.runId,
        label: input.label,
        task: input.task,
        preferMetadata: input.preferMetadata,
        notifyPolicy: input.notifyPolicy,
        deliveryStatus: input.deliveryStatus,
        status: input.status,
        startedAt: input.startedAt,
        lastEventAt: input.lastEventAt,
        progressSummary: input.progressSummary,
      });
      if (!created.created) {
        return {
          created: false,
          found: created.found,
          reason: created.reason ?? "Task was not created.",
          ...(created.flow ? { flow: created.flow } : {}),
        };
      }
      const managed = asManagedTaskFlowRecord(created.flow);
      if (!managed) {
        return {
          created: false,
          found: true,
          reason: "TaskFlow does not accept managed child tasks.",
          flow: created.flow,
        };
      }
      if (!created.task) {
        return {
          created: false,
          found: true,
          reason: "Task was not created.",
          flow: created.flow,
        };
      }
      return {
        created: true,
        flow: managed,
        task: created.task,
      };
    },
  };
}

export function createRuntimeTaskFlow(): PluginRuntimeTaskFlow {
  return {
    bindSession: (params) =>
      createBoundTaskFlowRuntime({
        sessionKey: params.sessionKey,
        requesterOrigin: params.requesterOrigin,
      }),
    fromToolContext: (ctx) =>
      createBoundTaskFlowRuntime({
        sessionKey: assertSessionKey(
          ctx.sessionKey,
          "TaskFlow runtime requires tool context with a sessionKey.",
        ),
        requesterOrigin: ctx.deliveryContext,
      }),
  };
}
