import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { listAgentIds, tryResolveAmbientOwnerAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentIdStrict } from "../routing/session-key.js";

/** Legacy reads select the default; an unscoped write must have only one possible owner. */
export function resolveSessionGroupAgent(
  cfg: OpenClawConfig,
  requested: string | undefined,
  access: "read" | "write",
) {
  const agents = listAgentIds(cfg);
  const explicit = requested === undefined ? undefined : normalizeAgentIdStrict(requested);
  if (explicit && (!explicit.ok || !agents.includes(explicit.value))) {
    return {
      ok: false as const,
      error: errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${requested}"`),
    };
  }
  if (!explicit && access === "write" && agents.length !== 1) {
    return {
      ok: false as const,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Group mutations require agentId when more than one agent is configured. Update the client or pass agentId.",
      ),
    };
  }
  const agentId = explicit?.ok ? explicit.value : tryResolveAmbientOwnerAgentId(cfg);
  return agentId
    ? { ok: true as const, agentId }
    : {
        ok: false as const,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Select an agentId or configure a default agent before using session groups.",
        ),
      };
}
