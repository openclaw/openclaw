import type { ClawRemovePlanAction } from "../claws/lifecycle-remove-contract.js";
import { resolveClawMonitorCleanupBinding } from "../claws/monitor-cleanup-binding.js";
import {
  clawPackageRemovalResultSchema,
  type ClawPackageRemovalGateway,
} from "../claws/package-remove-contract.js";
import { clawsPackageHandlers } from "./server-methods/claws-packages.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/types.js";

/** Keep package cleanup under the initiating Gateway request, not a CLI credential. */
export function createServingClawPackageRemovalGateway(
  context: Pick<
    GatewayRequestContext,
    "cronStorePath" | "applyPluginLifecycleChange" | "getRuntimeConfig"
  >,
  assertCurrent: () => void,
  reviewedPackageActions: readonly ClawRemovePlanAction[],
  signal?: AbortSignal,
): ClawPackageRemovalGateway {
  return async (request) => {
    assertCurrent();
    let response: unknown;
    let failure: string | undefined;
    const respond: RespondFn = (ok, payload, error) => {
      if (ok) {
        response = payload;
      } else {
        failure = error?.message ?? "Gateway package cleanup failed.";
      }
    };
    await clawsPackageHandlers["claws.packages.remove"]({
      params: {
        ...request,
        binding: resolveClawMonitorCleanupBinding(context.cronStorePath),
      },
      context,
      respond,
      signal,
      sessionMutationCommitGuard: assertCurrent,
      reviewedPackageActions,
    });
    assertCurrent();
    if (failure) {
      throw new Error(failure);
    }
    return clawPackageRemovalResultSchema.parse(response);
  };
}
