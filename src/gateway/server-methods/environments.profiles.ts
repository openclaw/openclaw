import { workerInferenceMetadata } from "../worker-environments/inference-placement.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext } from "./types.js";

export function listWorkerProfiles(context: GatewayRequestContext) {
  if (!context.workerEnvironmentService || !context.workerPlacementDispatchService) {
    return [];
  }
  const profiles = context.getRuntimeConfig().cloudWorkers?.profiles ?? {};
  return Object.entries(profiles)
    .flatMap(([id, profile]) => {
      const providerId = typeof profile.provider === "string" ? profile.provider.trim() : "";
      return id.trim() && providerId
        ? [
            {
              id: id.trim(),
              providerId,
              ...workerInferenceMetadata({ providerId, profileSnapshot: profile }),
            },
          ]
        : [];
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
export async function listWorkerProfilesWithMachines(context: GatewayRequestContext) {
  const summaries = listWorkerProfiles(context);
  return await Promise.all(
    summaries.map(async (summary) => {
      const executionModes = (["worker-turn", "remote-exec"] as const).filter(
        (mode) =>
          context.workerEnvironmentService?.supportsExecutionMode(summary.id, mode) === true,
      );
      const executionMode = executionModes[0];
      const providerDisplayId = context.workerEnvironmentService?.readProviderDisplayId(summary.id);
      const resolvedSummary = Object.assign(
        summary,
        executionMode ? { executionMode, executionModes } : {},
        providerDisplayId ? { providerDisplayId } : {},
      );
      try {
        const [options, operatingSystems] = await Promise.all([
          context.workerEnvironmentService?.listMachineOptions?.(summary.id),
          context.workerEnvironmentService?.listOperatingSystems?.(summary.id),
        ]);
        const machines = options ?? [];
        return Object.assign(
          resolvedSummary,
          machines.length > 0 ? { machines } : {},
          operatingSystems && operatingSystems.length > 1 ? { operatingSystems } : {},
        );
      } catch (error) {
        context.logGateway.warn(
          `worker machine catalog unavailable (${summary.id}): ${formatForLog(error)}`,
        );
        return resolvedSummary;
      }
    }),
  );
}
