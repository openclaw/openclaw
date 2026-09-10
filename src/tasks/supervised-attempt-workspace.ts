import {
  AttemptPlanSchema,
  type SupervisedAttemptPlan,
} from "./supervised-attempt-custody.types.js";
import {
  prepareSupervisedRuntimeWorkspace,
  supervisedRuntimeWorkspacePayloadPrefix,
  harvestSupervisedRuntimeWorkspace,
  type PreparedSupervisedRuntimeWorkspace,
} from "./supervised-runtime-workspace.js";

export type PreparedSupervisedAttemptWorkspace = PreparedSupervisedRuntimeWorkspace;
export const supervisedAttemptWorkspacePayloadPrefix = supervisedRuntimeWorkspacePayloadPrefix;
export const harvestSupervisedAttemptWorkspace = harvestSupervisedRuntimeWorkspace;

/** Actual attempt authorization stays with the attempt owner; shared mount code
 * receives only neutral filesystem facts, never a fabricated attempt grant. */
export async function prepareSupervisedAttemptWorkspace(
  params: Omit<Parameters<typeof prepareSupervisedRuntimeWorkspace>[0], "plan"> & {
    plan: SupervisedAttemptPlan;
  },
): Promise<PreparedSupervisedAttemptWorkspace> {
  const plan = AttemptPlanSchema.parse(params.plan);
  return prepareSupervisedRuntimeWorkspace({
    ...params,
    plan: {
      resourceId: plan.resourceId,
      allocationId: plan.allocationId,
      storage: plan.storage,
      workspace: plan.workspace && {
        sourceVersion: plan.workspace.sourceVersion,
        sourceHash: plan.workspace.sourceHash,
      },
    },
  });
}
