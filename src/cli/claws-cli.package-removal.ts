import { resolveClawMonitorCleanupBinding } from "../claws/monitor-cleanup-binding.js";
import {
  clawPackageRemovalResultSchema,
  type ClawPackageRemovalGateway,
} from "../claws/package-remove-contract.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { callGatewayFromCli } from "./gateway-rpc.js";

export const clawPackageRemovalGateway: ClawPackageRemovalGateway = async (request) =>
  clawPackageRemovalResultSchema.parse(
    await callGatewayFromCli(
      "claws.packages.remove",
      { timeout: "600000" },
      {
        ...request,
        binding: resolveClawMonitorCleanupBinding(
          resolveCronJobsStorePathFromConfig(getRuntimeConfig()),
        ),
      },
    ),
  );
