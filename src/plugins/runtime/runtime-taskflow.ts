// Runtime task-flow helpers adapt plugin task descriptors into executable task flows.
import type { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePacedNextRunAtMs } from "../../cron/pacing.js";
import { tryCronScheduleIdentity } from "../../cron/schedule-identity.js";
import { loadedCronStoreFromRows, loadCronRows } from "../../cron/store/row-codec.js";
import {
  getCurrentPacedCronRunBinding,
  recordManagedFlowAutomationObligationProposal,
} from "../../infra/agent-run-registry.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  cancelFlowByIdForOwner,
  getFlowTaskSummary,
  runTaskInFlowForOwner,
} from "../../tasks/task-executor.js";
import {
  listTaskFlowAutomationObligationsForCronJobFromSqlite,
  removeTaskFlowAutomationObligationForTerminalFlowInStateTransaction,
  upsertTaskFlowAutomationObligationInStateTransaction,
} from "../../tasks/task-flow-automation-obligation.store.sqlite.js";
import {
  findLatestTaskFlowForOwner,
  getTaskFlowByIdForOwner,
  listTaskFlowsForOwner,
  resolveTaskFlowForLookupTokenForOwner,
} from "../../tasks/task-flow-owner-access.js";
import { getTaskFlowRegistryStore } from "../../tasks/task-flow-registry.store.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import {
  createManagedTaskFlow,
  commitPreparedManagedTaskFlowMutationInStateTransaction,
  enableTaskFlowHistoryForFlow,
  prepareManagedTaskFlowMutation,
  publishPreparedManagedTaskFlowMutation,
  type TaskFlowUpdateResult,
  requestFlowCancel,
  resumeFlow,
  setFlowWaiting,
} from "../../tasks/task-flow-runtime-internal.js";
import type { TaskDeliveryState } from "../../tasks/task-registry.types.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import {
  asManagedTaskFlowRecord,
  mapFlowTaskRunResult,
  mapFlowUpdateResult,
} from "./runtime-managed-flow-result.js";
import type {
  BoundTaskFlowRuntime,
  BoundTaskFlowHistoryController,
  ManagedTaskFlowMutationResult,
  ManagedTaskFlowRecord,
  ManagedTaskFlowAutomationObligationResult,
  ManagedTaskFlowAutomationObligationMutation,
  ManagedTaskFlowCreateParams,
  PluginRuntimeTaskFlow,
} from "./runtime-taskflow.types.js";

function assertSessionKey(sessionKey: string | undefined, errorMessage: string): string {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    throw new Error(errorMessage);
  }
  return normalized;
}

function applyManagedFlowMutationForOwner(params: {
  flowId: string;
  ownerKey: string;
  mutate: (flowId: string) => TaskFlowUpdateResult;
}): ManagedTaskFlowMutationResult {
  // Authorization and mode checks must complete before the mutation can touch persistence.
  const flow = getTaskFlowByIdForOwner({
    flowId: params.flowId,
    callerOwnerKey: params.ownerKey,
  });
  if (!flow) {
    return { applied: false, code: "not_found" };
  }
  const managed = asManagedTaskFlowRecord(flow);
  if (!managed) {
    return { applied: false, code: "not_managed", current: flow };
  }
  return mapFlowUpdateResult(params.mutate(managed.flowId));
}

function assertManagedFlow(flow: TaskFlowRecord | undefined): ManagedTaskFlowRecord {
  const managed = asManagedTaskFlowRecord(flow);
  if (!managed) {
    throw new Error("Managed Flow obligation requires an owned managed Flow.");
  }
  return managed;
}

function isPreparedManagedTaskFlowMutation(
  value: ReturnType<typeof prepareManagedTaskFlowMutation>,
): value is Exclude<ReturnType<typeof prepareManagedTaskFlowMutation>, TaskFlowUpdateResult> {
  return "prepared" in value;
}

function managedObligationPatch(
  mutation: ManagedTaskFlowAutomationObligationMutation,
): Parameters<typeof prepareManagedTaskFlowMutation>[0]["patch"] {
  if (mutation.kind === "resume") {
    return {
      status: mutation.status ?? "queued",
      currentStep: mutation.currentStep,
      stateJson: mutation.stateJson,
      waitJson: null,
      blockedTaskId: null,
      blockedSummary: null,
      endedAt: null,
      updatedAt: mutation.updatedAt,
    };
  }
  return {
    status: mutation.blockedTaskId || mutation.blockedSummary ? "blocked" : "waiting",
    currentStep: mutation.currentStep,
    stateJson: mutation.stateJson,
    waitJson: mutation.waitJson,
    blockedTaskId: mutation.blockedTaskId,
    blockedSummary: mutation.blockedSummary,
    endedAt: null,
    updatedAt: mutation.updatedAt,
  };
}

function readCurrentManagedAutomationRun(runId: string | undefined) {
  const normalizedRunId = runId?.trim();
  const binding = normalizedRunId ? getCurrentPacedCronRunBinding(normalizedRunId) : undefined;
  if (!normalizedRunId || !binding) {
    throw new Error(
      "Managed Flow obligation is only available to the current paced Automation run.",
    );
  }
  return { runId: normalizedRunId, binding };
}

function assertCurrentManagedAutomationRun(params: {
  runId?: string;
  getRuntimeConfig?: () => OpenClawConfig | undefined;
}) {
  if (params.getRuntimeConfig?.()?.cron?.enabled === false) {
    throw new Error("Managed Flow obligation is unavailable while Automations are paused.");
  }
  const current = readCurrentManagedAutomationRun(params.runId);
  const { runId, binding } = current;
  if (binding.nextCheckSource === "next_check") {
    throw new Error("Managed Flow obligation conflicts with an existing cron next_check.");
  }
  return { runId, binding };
}

function readBoundAutomationJob(params: {
  db: DatabaseSync;
  ownerKey: string;
  binding: NonNullable<ReturnType<typeof getCurrentPacedCronRunBinding>>;
}) {
  const binding = params.binding;
  if (!binding) {
    throw new Error(
      "Managed Flow obligation is only available to the current paced Automation run.",
    );
  }
  const row = loadCronRows(params.db, binding.cronStoreKey).find(
    (entry) => entry.job_id === binding.jobId,
  );
  const job = row ? loadedCronStoreFromRows([row]).store.jobs[0] : undefined;
  if (
    !job ||
    job.enabled !== true ||
    job.pacing === undefined ||
    job.sessionKey !== params.ownerKey ||
    tryCronScheduleIdentity(job) !== binding.cronScheduleIdentity
  ) {
    throw new Error("Managed Flow obligation current Automation binding is no longer valid.");
  }
  return job;
}

function createBoundTaskFlowRuntime(params: {
  sessionKey: string;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  currentRunId?: string;
  getRuntimeConfig?: () => OpenClawConfig | undefined;
}): BoundTaskFlowRuntime {
  const ownerKey = assertSessionKey(
    params.sessionKey,
    "TaskFlow runtime requires a bound sessionKey.",
  );
  const requesterOrigin = params.requesterOrigin
    ? normalizeDeliveryContext(params.requesterOrigin)
    : undefined;
  const tryCreateManaged: BoundTaskFlowRuntime["tryCreateManaged"] = (input) => {
    const flow = createManagedTaskFlow({
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
    });
    return asManagedTaskFlowRecord(flow ?? undefined) ?? null;
  };

  const commitPreparedWithCurrentAutomation = (input: {
    prepared: Exclude<ReturnType<typeof prepareManagedTaskFlowMutation>, TaskFlowUpdateResult>;
    obligation: { triggerAtMs: number; triggerKind: string; triggerDigest: string };
  }): ManagedTaskFlowAutomationObligationResult => {
    const now = Date.now();
    if (
      !Number.isSafeInteger(input.obligation.triggerAtMs) ||
      input.obligation.triggerAtMs <= now
    ) {
      throw new Error("Managed Flow obligation trigger must be strictly future.");
    }
    const currentRun = assertCurrentManagedAutomationRun({
      runId: params.currentRunId,
      getRuntimeConfig: params.getRuntimeConfig,
    });
    const committed = runOpenClawStateWriteTransaction(
      ({ db }) => {
        const job = readBoundAutomationJob({
          db,
          ownerKey,
          binding: currentRun.binding,
        });
        const pacing = job.pacing;
        if (!pacing) {
          throw new Error("Managed Flow obligation current Automation pacing is unavailable.");
        }
        const scheduledAtMs = resolvePacedNextRunAtMs({
          nowMs: now,
          delayMs: input.obligation.triggerAtMs - now,
          pacing,
        });
        if (
          typeof scheduledAtMs !== "number" ||
          !Number.isSafeInteger(scheduledAtMs) ||
          scheduledAtMs <= now
        ) {
          throw new Error("Managed Flow obligation cannot resolve a paced next run.");
        }
        commitPreparedManagedTaskFlowMutationInStateTransaction(db, input.prepared);
        const obligation = upsertTaskFlowAutomationObligationInStateTransaction(db, {
          flowId: input.prepared.flow.flowId,
          expectedFlowRevision: input.prepared.flow.revision,
          controllerId: assertManagedFlow(input.prepared.flow).controllerId,
          cronStoreKey: currentRun.binding.cronStoreKey,
          cronJobId: currentRun.binding.jobId,
          cronScheduleIdentity: currentRun.binding.cronScheduleIdentity,
          sourceRunId: currentRun.runId,
          triggerAtMs: input.obligation.triggerAtMs,
          scheduledAtMs,
          triggerKind: input.obligation.triggerKind,
          triggerDigest: input.obligation.triggerDigest,
          now,
        });
        const currentScheduleReceipt = listTaskFlowAutomationObligationsForCronJobFromSqlite(db, {
          cronStoreKey: currentRun.binding.cronStoreKey,
          cronJobId: currentRun.binding.jobId,
          phases: ["bound"],
        }).find((entry) => entry.cronScheduleIdentity === currentRun.binding.cronScheduleIdentity);
        if (!currentScheduleReceipt || currentScheduleReceipt.scheduledAtMs <= now) {
          throw new Error("Managed Flow obligation has no future scheduler receipt.");
        }
        return { obligation, nextRunAtMs: currentScheduleReceipt.scheduledAtMs };
      },
      {},
      { operationLabel: "task-flow.automation-obligation-commit" },
    );
    const flow = assertManagedFlow(publishPreparedManagedTaskFlowMutation(input.prepared));
    recordManagedFlowAutomationObligationProposal({
      runId: currentRun.runId,
      jobId: currentRun.binding.jobId,
      delayMs: Math.max(1, committed.nextRunAtMs - now),
      scheduledAtMs: committed.nextRunAtMs,
    });
    return {
      flow,
      obligationId: committed.obligation.obligationId,
      boundJobId: currentRun.binding.jobId,
      nextRunAtMs: committed.nextRunAtMs,
    };
  };

  const createManagedWithCurrentAutomationObligation = (input: {
    flow: ManagedTaskFlowCreateParams;
    obligation: { triggerAtMs: number; triggerKind: string; triggerDigest: string };
    history?: import("../../tasks/task-flow-registry.store.types.js").TaskFlowHistoryRegistration;
  }) => {
    const prepared = prepareManagedTaskFlowMutation({
      ownerKey,
      controllerId: input.flow.controllerId,
      create: {
        requesterOrigin,
        status: input.flow.status,
        notifyPolicy: input.flow.notifyPolicy,
        goal: input.flow.goal,
        currentStep: input.flow.currentStep,
        stateJson: input.flow.stateJson,
        waitJson: input.flow.waitJson,
        cancelRequestedAt: input.flow.cancelRequestedAt,
        createdAt: input.flow.createdAt,
        updatedAt: input.flow.updatedAt,
        endedAt: input.flow.endedAt,
      },
      ...(input.history ? { history: input.history } : {}),
    });
    if (!isPreparedManagedTaskFlowMutation(prepared)) {
      throw new Error("Managed Flow creation could not be prepared.");
    }
    return commitPreparedWithCurrentAutomation({ prepared, obligation: input.obligation });
  };

  const commitTerminalManagedFlow = (input: {
    flowId: string;
    expectedRevision: number;
    patch: Parameters<typeof prepareManagedTaskFlowMutation>[0]["patch"];
  }): ManagedTaskFlowMutationResult => {
    const current = getTaskFlowByIdForOwner({ flowId: input.flowId, callerOwnerKey: ownerKey });
    const managed = asManagedTaskFlowRecord(current);
    if (!managed) {
      return {
        applied: false,
        code: current ? "not_managed" : "not_found",
        ...(current ? { current } : {}),
      };
    }
    const prepared = prepareManagedTaskFlowMutation({
      ownerKey,
      controllerId: managed.controllerId,
      flowId: managed.flowId,
      expectedRevision: input.expectedRevision,
      patch: input.patch,
    });
    if (!isPreparedManagedTaskFlowMutation(prepared)) {
      return mapFlowUpdateResult(prepared);
    }
    try {
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          commitPreparedManagedTaskFlowMutationInStateTransaction(db, prepared);
          removeTaskFlowAutomationObligationForTerminalFlowInStateTransaction(db, {
            flowId: prepared.flow.flowId,
            expectedFlowRevision: prepared.flow.revision,
            controllerId: managed.controllerId,
          });
        },
        {},
        { operationLabel: "task-flow.automation-obligation-terminal" },
      );
    } catch {
      return { applied: false, code: "persist_failed", current: managed };
    }
    return {
      applied: true,
      flow: assertManagedFlow(publishPreparedManagedTaskFlowMutation(prepared)),
    };
  };

  const registerHistoryController: BoundTaskFlowRuntime["registerHistoryController"] = ({
    controllerId,
  }) => {
    const normalizedControllerId = controllerId.trim();
    if (!normalizedControllerId) {
      throw new Error("Task Flow history controllerId is required.");
    }
    const tryCreateHistoryManaged: BoundTaskFlowHistoryController["tryCreateManaged"] = (input) => {
      const flow = createManagedTaskFlow({
        ownerKey,
        controllerId: normalizedControllerId,
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
        history: { controllerId: normalizedControllerId },
      });
      return asManagedTaskFlowRecord(flow ?? undefined) ?? null;
    };
    return {
      controllerId: normalizedControllerId,
      createManaged: (input) => {
        const flow = tryCreateHistoryManaged(input);
        if (!flow) {
          throw new Error("TaskFlow history persistence failed.");
        }
        return flow;
      },
      tryCreateManaged: tryCreateHistoryManaged,
      createManagedWithCurrentAutomationObligation: ({ flow, obligation }) =>
        createManagedWithCurrentAutomationObligation({
          flow: { ...flow, controllerId: normalizedControllerId },
          obligation,
          history: { controllerId: normalizedControllerId },
        }),
      enable: (input) =>
        enableTaskFlowHistoryForFlow({
          flowId: input.flowId,
          ownerKey,
          controllerId: normalizedControllerId,
          enabledAt: input.enabledAt,
        }),
      list: (input = {}) => {
        const listHistory = getTaskFlowRegistryStore().listHistory;
        if (!listHistory) {
          throw new Error("TaskFlow history is unavailable for this registry store.");
        }
        return listHistory({
          ownerKey,
          controllerId: normalizedControllerId,
          ...(input.flowId ? { flowId: input.flowId } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
      },
    };
  };

  return {
    sessionKey: ownerKey,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    createManaged: (input) => {
      const flow = tryCreateManaged(input);
      if (!flow) {
        throw new Error("TaskFlow persistence failed.");
      }
      return flow;
    },
    tryCreateManaged,
    hasCurrentAutomationObligationCapability: () => {
      try {
        readCurrentManagedAutomationRun(params.currentRunId);
        return true;
      } catch {
        return false;
      }
    },
    createManagedWithCurrentAutomationObligation: (input) =>
      createManagedWithCurrentAutomationObligation(input),
    registerHistoryController,
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
    setWaiting: (input) =>
      applyManagedFlowMutationForOwner({
        flowId: input.flowId,
        ownerKey,
        mutate: (flowId) =>
          setFlowWaiting({
            flowId,
            expectedRevision: input.expectedRevision,
            currentStep: input.currentStep,
            stateJson: input.stateJson,
            waitJson: input.waitJson,
            blockedTaskId: input.blockedTaskId,
            blockedSummary: input.blockedSummary,
            updatedAt: input.updatedAt,
          }),
      }),
    commitWithCurrentAutomationObligation: (input) => {
      const existing = getTaskFlowByIdForOwner({
        flowId: input.flowId,
        callerOwnerKey: ownerKey,
      });
      const managed = asManagedTaskFlowRecord(existing);
      if (!managed) {
        throw new Error("Managed Flow obligation requires an owned managed Flow.");
      }
      if (
        managed.endedAt != null ||
        managed.cancelRequestedAt != null ||
        ["succeeded", "failed", "cancelled", "lost"].includes(managed.status)
      ) {
        throw new Error("Managed Flow obligation cannot revive a terminal or cancelled Flow.");
      }
      const prepared = prepareManagedTaskFlowMutation({
        ownerKey,
        controllerId: managed.controllerId,
        flowId: managed.flowId,
        expectedRevision: input.expectedRevision,
        patch: managedObligationPatch(input.mutation),
      });
      if (!isPreparedManagedTaskFlowMutation(prepared)) {
        throw new Error(
          `Managed Flow obligation mutation was rejected (${prepared.applied ? "invalid" : prepared.reason}).`,
        );
      }
      return commitPreparedWithCurrentAutomation({ prepared, obligation: input.obligation });
    },
    resume: (input) =>
      applyManagedFlowMutationForOwner({
        flowId: input.flowId,
        ownerKey,
        mutate: (flowId) =>
          resumeFlow({
            flowId,
            expectedRevision: input.expectedRevision,
            status: input.status,
            currentStep: input.currentStep,
            stateJson: input.stateJson,
            updatedAt: input.updatedAt,
          }),
      }),
    finish: (input) =>
      commitTerminalManagedFlow({
        flowId: input.flowId,
        expectedRevision: input.expectedRevision,
        patch: {
          status: "succeeded",
          stateJson: input.stateJson,
          waitJson: null,
          blockedTaskId: null,
          blockedSummary: null,
          endedAt: input.endedAt ?? input.updatedAt ?? Date.now(),
          updatedAt: input.updatedAt ?? input.endedAt ?? Date.now(),
        },
      }),
    fail: (input) =>
      commitTerminalManagedFlow({
        flowId: input.flowId,
        expectedRevision: input.expectedRevision,
        patch: {
          status: "failed",
          stateJson: input.stateJson,
          waitJson: null,
          blockedTaskId: input.blockedTaskId,
          blockedSummary: input.blockedSummary,
          endedAt: input.endedAt ?? input.updatedAt ?? Date.now(),
          updatedAt: input.updatedAt ?? input.endedAt ?? Date.now(),
        },
      }),
    requestCancel: (input) =>
      applyManagedFlowMutationForOwner({
        flowId: input.flowId,
        ownerKey,
        mutate: (flowId) =>
          requestFlowCancel({
            flowId,
            expectedRevision: input.expectedRevision,
            cancelRequestedAt: input.cancelRequestedAt,
          }),
      }),
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
      return mapFlowTaskRunResult(created);
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
        currentRunId: ctx.runId,
        getRuntimeConfig: ctx.getRuntimeConfig ?? (() => ctx.runtimeConfig ?? ctx.config),
      }),
  };
}
