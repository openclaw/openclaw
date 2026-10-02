import { resolveClawMonitorCleanupBinding } from "../claws/monitor-cleanup-binding.js";
import {
  clawMonitorDrainSchema,
  clawMonitorInventorySchema,
  type ClawMonitorCleanupGateway,
} from "../claws/monitor-cleanup-contract.js";
import { clawsMonitorHandlers, type ClawMonitorContext } from "./server-methods/claws-monitors.js";
import type { RespondFn } from "./server-methods/types.js";

/** Use the serving Gateway's monitor owner for in-process Claw lifecycle operations. */
export function createServingClawMonitorCleanupGateway(
  context: ClawMonitorContext,
  assertCurrent?: () => void,
): ClawMonitorCleanupGateway {
  const invoke = async (params: Record<string, unknown>) => {
    assertCurrent?.();
    let response: unknown;
    let failure: string | undefined;
    const respond: RespondFn = (ok, payload, error) => {
      if (ok) {
        response = payload;
      } else {
        failure = error?.message ?? "Gateway monitor cleanup failed.";
      }
    };
    await clawsMonitorHandlers["claws.monitors"]({
      params: {
        ...params,
        binding: resolveClawMonitorCleanupBinding(context.cronStorePath),
      },
      context,
      respond,
      assertAuthority: assertCurrent,
    });
    assertCurrent?.();
    if (failure) {
      throw new Error(failure);
    }
    return response;
  };
  return {
    inspect: async (agentId) =>
      clawMonitorInventorySchema.parse(await invoke({ phase: "inspect", agentId })).monitors,
    quiesce: async (agentId, operationId, monitors) => {
      clawMonitorDrainSchema.parse(
        await invoke({ phase: "quiesce", agentId, operationId, monitors }),
      );
    },
    drain: async (agentId, operationId) => {
      clawMonitorDrainSchema.parse(await invoke({ phase: "drain", agentId, operationId }));
    },
  };
}
