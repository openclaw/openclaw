import type { UnknownAgentIdErrorDetails } from "../../../packages/gateway-protocol/src/gateway-error-details.js";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { listAgentIds, resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentIdStrict } from "../../routing/session-key.js";

type ModelAuthAgentScopeResult =
  | { ok: true; agentId: string; agentDir: string }
  | { ok: false; error: ReturnType<typeof errorShape> };

/** Resolves model-auth RPC scope without letting explicit garbage reach the default store. */
export function resolveModelAuthAgentScope(
  cfg: OpenClawConfig,
  requestedAgentId: unknown,
): ModelAuthAgentScopeResult {
  let agentId: string;
  if (requestedAgentId === undefined || requestedAgentId === "") {
    try {
      agentId = resolveDefaultAgentId(cfg, {
        surface: "model auth",
        hint: "Pass agentId to select a configured agent.",
      });
    } catch (error) {
      if (!(error instanceof AgentSelectionRequiredError)) {
        throw error;
      }
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, error.message),
      };
    }
  } else {
    if (typeof requestedAgentId !== "string") {
      return unknownAgentScope(requestedAgentId === null ? "null" : typeof requestedAgentId);
    }
    const rawAgentId = requestedAgentId.trim();
    // Only the literal empty string keeps the omitted-param default; a
    // whitespace-only value is an explicit target and must not use default auth.
    if (!rawAgentId) {
      return unknownAgentScope(requestedAgentId);
    }
    const normalized = normalizeAgentIdStrict(rawAgentId);
    if (!normalized.ok || !listAgentIds(cfg).includes(normalized.value)) {
      return unknownAgentScope(rawAgentId);
    }
    agentId = normalized.value;
  }
  return { ok: true, agentId, agentDir: resolveAgentDir(cfg, agentId) };
}

function unknownAgentScope(agentId: string): ModelAuthAgentScopeResult {
  const details: UnknownAgentIdErrorDetails = {
    code: GatewayErrorDetailCodes.UNKNOWN_AGENT_ID,
    agentId,
  };
  return {
    ok: false,
    error: errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentId}"`, { details }),
  };
}
