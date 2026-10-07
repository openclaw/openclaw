import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isGatewayProtocolResponseError } from "../../packages/gateway-client/src/protocol-request.js";
import {
  clawAutomationMutationResultSchema,
  type ClawAutomationMutationGateway,
} from "../claws/automation-mutation-contract.js";
import { resolveClawMonitorCleanupBinding } from "../claws/monitor-cleanup-binding.js";
import { ClawPortableMutationUncertainError } from "../claws/portable-heartbeat-write.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { callGatewayFromCli } from "./gateway-rpc.js";

export const clawAutomationMutationGateway: ClawAutomationMutationGateway = async (request) => {
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
      ),
    );
  } catch (error) {
    if (
      isGatewayProtocolResponseError(error) &&
      ((isRecord(error.details) && error.details.outcomeUnknown === false) ||
        error.gatewayCode === "INVALID_REQUEST" ||
        error.gatewayCode === "FORBIDDEN")
    ) {
      throw error;
    }
    throw new ClawPortableMutationUncertainError(error);
  }
};
