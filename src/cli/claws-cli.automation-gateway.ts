import {
  clawAutomationMutationResultSchema,
  isDefiniteClawAutomationFailure,
  type ClawAutomationMutationGateway,
} from "../claws/automation-mutation-contract.js";
import { resolveClawMonitorCleanupBinding } from "../claws/monitor-cleanup-binding.js";
import { ClawPortableMutationUncertainError } from "../claws/portable-heartbeat-write.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { callGatewayFromCli } from "./gateway-rpc.js";

export const clawAutomationMutationGateway: ClawAutomationMutationGateway = async (
  request,
  options,
) => {
  try {
    return clawAutomationMutationResultSchema.parse(
      await callGatewayFromCli(
        "claws.automations.mutate",
        { timeout: "600000" },
        {
          ...request,
          binding: resolveClawMonitorCleanupBinding(
            resolveCronJobsStorePathFromConfig(getRuntimeConfig()),
          ),
        },
        { signal: options?.signal },
      ),
    );
  } catch (error) {
    if (isDefiniteClawAutomationFailure(error)) {
      throw error;
    }
    throw new ClawPortableMutationUncertainError(error);
  }
};
