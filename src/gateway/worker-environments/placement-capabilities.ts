import { normalizeBoundedOptionalString } from "@openclaw/normalization-core/string-coerce";
import { OPENCLAW_AGENT_RUNTIME_ID } from "../../agents/agent-runtime-id.js";
import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import type { GatewayAgentRuntime } from "../../shared/session-types.js";
import type { WorkerPlacementExecutionMode } from "./placement-record.js";

/** Returns the bounded placement contract of one active runtime. */
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
  const harness = getRegisteredAgentHarness(runtimeId)?.harness;
  const placement = harness?.cloudPlacement;
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
  const label = normalizeBoundedOptionalString(requirement.setup?.label, 80);
  const missingCommandHint = normalizeBoundedOptionalString(
    requirement.setup?.missingCommandHint,
    500,
  );
  return {
    executionMode: placement.mode,
    devicePlacement: {
      requiredNodeCommands,
      consumesWorkerSlot: requirement.consumesWorkerSlot,
      ...(label && missingCommandHint ? { setup: { label, missingCommandHint } } : {}),
    },
  };
}
