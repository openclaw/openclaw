import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayRequestContext } from "./types.js";

export function resolveSkillsAgentWorkspace(
  params: { agentId?: string },
  context: GatewayRequestContext,
) {
  const cfg = context.getRuntimeConfig();
  const agentIdRaw = normalizeOptionalString(params.agentId);
  let agentId: string;
  try {
    agentId = agentIdRaw
      ? normalizeAgentId(agentIdRaw)
      : resolveDefaultAgentId(cfg, {
          surface: "skills workspace",
          hint: "Pass agentId to select a configured agent.",
        });
  } catch (error) {
    if (!(error instanceof AgentSelectionRequiredError)) {
      throw error;
    }
    return {
      ok: false as const,
      error: errorShape(ErrorCodes.INVALID_REQUEST, error.message),
    };
  }
  if (agentIdRaw && !listAgentIds(cfg).includes(agentId)) {
    return {
      ok: false as const,
      error: errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentIdRaw}"`),
    };
  }
  return {
    ok: true as const,
    cfg,
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
  };
}

export type ResolvedSkillsWorkspace = Extract<
  ReturnType<typeof resolveSkillsAgentWorkspace>,
  { ok: true }
>;
