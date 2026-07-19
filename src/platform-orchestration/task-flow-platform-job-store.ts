import type { JsonValue } from "../tasks/task-flow-registry.types.js";
import {
  createManagedTaskFlow,
  failFlow,
  finishFlow,
  getTaskFlowById,
  setFlowWaiting,
  updateFlowRecordByIdExpectedRevision,
  type TaskFlowUpdateResult,
} from "../tasks/task-flow-runtime-internal.js";
import { assertPlatformContract } from "./contracts-runtime.js";
import type {
  PlatformJobFlowState,
  PlatformJobStatePort,
  StoredPlatformJob,
} from "./platform-job-ports.js";

const CONTROLLER_ID = "core/platform-job/v1";

function serializeState(state: PlatformJobFlowState): JsonValue {
  return structuredClone(state) as unknown as JsonValue;
}

function parseState(value: JsonValue | undefined): PlatformJobFlowState {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("platform job flow has no state");
  }
  const candidate = value as Record<string, JsonValue>;
  if (candidate.stateVersion !== 1 || !candidate.job) {
    throw new Error("platform job flow state version is unsupported");
  }
  assertPlatformContract("JobResponse", candidate.job);
  return candidate as unknown as PlatformJobFlowState;
}

function unwrapUpdate(result: TaskFlowUpdateResult): StoredPlatformJob {
  if (!result.applied) {
    throw new Error(`platform job state update failed: ${result.reason}`);
  }
  return {
    flowId: result.flow.flowId,
    revision: result.flow.revision,
    state: parseState(result.flow.stateJson),
  };
}

export class TaskFlowPlatformJobStore implements PlatformJobStatePort {
  create(state: PlatformJobFlowState): StoredPlatformJob {
    const flow = createManagedTaskFlow({
      controllerId: CONTROLLER_ID,
      ownerKey: `platform:${state.job.project_id}:${state.job.job_id}`,
      status: "running",
      notifyPolicy: "silent",
      goal: state.job.task,
      currentStep: state.job.status,
      stateJson: serializeState(state),
      createdAt: Date.parse(state.job.created_at),
      updatedAt: Date.parse(state.job.updated_at),
    });
    if (!flow) {
      throw new Error("platform job state create failed");
    }
    return { flowId: flow.flowId, revision: flow.revision, state };
  }

  get(flowId: string): StoredPlatformJob | undefined {
    const flow = getTaskFlowById(flowId);
    if (!flow || flow.controllerId !== CONTROLLER_ID) {
      return undefined;
    }
    return { flowId, revision: flow.revision, state: parseState(flow.stateJson) };
  }

  save(flowId: string, expectedRevision: number, state: PlatformJobFlowState): StoredPlatformJob {
    const common = {
      flowId,
      expectedRevision,
      currentStep: state.job.status,
      stateJson: serializeState(state),
      updatedAt: Date.parse(state.job.updated_at),
    };
    if (state.job.status === "completed") {
      return unwrapUpdate(finishFlow(common));
    }
    if (state.job.status === "failed") {
      return unwrapUpdate(failFlow(common));
    }
    if (state.job.status === "cancelled") {
      return unwrapUpdate(
        updateFlowRecordByIdExpectedRevision({
          flowId,
          expectedRevision,
          patch: {
            status: "cancelled",
            currentStep: state.job.status,
            stateJson: common.stateJson,
            waitJson: null,
            endedAt: common.updatedAt,
            updatedAt: common.updatedAt,
          },
        }),
      );
    }
    if (state.job.status === "changes_requested" || state.job.status === "awaiting_input") {
      return unwrapUpdate(setFlowWaiting(common));
    }
    return unwrapUpdate(
      updateFlowRecordByIdExpectedRevision({
        flowId,
        expectedRevision,
        patch: {
          status: "running",
          currentStep: state.job.status,
          stateJson: common.stateJson,
          updatedAt: common.updatedAt,
        },
      }),
    );
  }
}
