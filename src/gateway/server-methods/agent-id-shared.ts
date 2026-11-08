import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  AgentSelectionRequiredError,
  listAgentIds,
  resolveDefaultAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentIdStrict } from "../../routing/session-key.js";
import type { RespondFn } from "./types.js";

export function resolveConfiguredAgentIdOrRespondError(
  rawAgentId: string,
  cfg: OpenClawConfig,
  respond: RespondFn,
): string | null {
  const normalized = normalizeAgentIdStrict(rawAgentId);
  if (normalized.ok && listAgentIds(cfg).includes(normalized.value)) {
    return normalized.value;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `agent "${rawAgentId}" not found`),
  );
  return null;
}

export function resolveAgentIdOrRespondError(params: {
  rawAgentId: unknown;
  respond: RespondFn;
  cfg: OpenClawConfig;
}) {
  const knownAgents = listAgentIds(params.cfg);
  const requestedAgentId = normalizeOptionalString(params.rawAgentId) ?? "";
  let agentId: string;
  try {
    agentId =
      requestedAgentId ||
      tryResolveLegacyCompatibilityAgentId(params.cfg) ||
      resolveDefaultAgentId(params.cfg, {
        surface: "this Gateway request",
        hint: "Set agentId to one of the configured agents.",
      });
  } catch (error) {
    if (!(error instanceof AgentSelectionRequiredError)) {
      throw error;
    }
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    return null;
  }
  if (requestedAgentId && !knownAgents.includes(agentId)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return { cfg: params.cfg, agentId };
}
