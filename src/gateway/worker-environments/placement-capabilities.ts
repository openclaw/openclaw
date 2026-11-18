import { OPENCLAW_AGENT_RUNTIME_ID } from "../../agents/agent-runtime-id.js";
import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import type { GatewayAgentRuntime } from "../../shared/session-types.js";
import type {
  WorkerPlacementExecutionMode,
  WorkerSessionPlacementRecord,
} from "./placement-record.js";

export function resolveWorkerPlacementRuntimeChangeError(
  placement: Pick<WorkerSessionPlacementRecord, "executionMode" | "state">,
  executionMode: WorkerPlacementExecutionMode | undefined,
  sessionLabel = "Session",
): string | undefined {
  if (executionMode === placement.executionMode) {
    return undefined;
  }
  return executionMode
    ? `${sessionLabel} cannot change cloud placement execution mode while placement is ${placement.state}.`
    : `${sessionLabel} cannot select a runtime without cloud placement support while cloud worker placement is ${placement.state}.`;
}

/** Returns the bounded placement contract declared by one active agent runtime. */
export function resolveWorkerPlacementCapabilities(runtime: string): {
  executionMode?: WorkerPlacementExecutionMode;
  devicePlacement?: NonNullable<GatewayAgentRuntime["devicePlacement"]>;
} {
  const runtimeId = runtime.trim();
  if (runtimeId === OPENCLAW_AGENT_RUNTIME_ID) {
    return {
      executionMode: "worker-turn",
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
    };
  }
  const placement = getRegisteredAgentHarness(runtimeId)?.harness.cloudPlacement;
  if (!placement) {
    return {};
  }
  const requirement = placement.devicePlacement;
  if (!requirement) {
    return { executionMode: placement.mode };
  }
  const requiredNodeCommands = [...new Set(requirement.requiredNodeCommands)].toSorted();
  // Invalid declarations disable placement. Dropping a command would silently weaken authority.
  if (
    requiredNodeCommands.length > 32 ||
    requiredNodeCommands.some(
      (command) => command.length === 0 || command.length > 128 || command.trim() !== command,
    )
  ) {
    return { executionMode: placement.mode };
  }
  return {
    executionMode: placement.mode,
    devicePlacement: { requiredNodeCommands, consumesWorkerSlot: requirement.consumesWorkerSlot },
  };
}
