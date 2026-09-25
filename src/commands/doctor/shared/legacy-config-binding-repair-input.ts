import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds } from "../../../agents/agent-roster.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

/** Decide whether ownership repair applies before loading channel and routing machinery. */
export function resolveChannelAccountBindingRepairInput(cfg: OpenClawConfig) {
  const agentIds = new Set(listAgentIds(cfg));
  const bindings = cfg.bindings === undefined ? [] : cfg.bindings;
  // Malformed or ownerless bindings cannot establish an explicit repair owner.
  if (
    agentIds.size < 2 ||
    cfg.plugins?.enabled === false ||
    !Array.isArray(bindings) ||
    !bindings.every(
      (binding) =>
        isRecord(binding) &&
        isRecord(binding.match) &&
        typeof binding.agentId === "string" &&
        binding.agentId.trim().length > 0 &&
        typeof binding.match.channel === "string" &&
        (binding.match.accountId === undefined || typeof binding.match.accountId === "string"),
    )
  ) {
    return undefined;
  }
  return { agentIds, bindings };
}
