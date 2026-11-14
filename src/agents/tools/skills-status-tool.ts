import {
  SkillsStatusParamsSchema,
  type SkillsStatusParams,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import {
  classifySessionKeyShape,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import type { SkillStatusReport } from "../../skills/discovery/status.types.js";
import { bindActiveOperatorTurnAuthority } from "../cron-creator-authority-context.js";
import { jsonResult, type AnyAgentTool } from "./common.js";
import { bindAgentToolGatewayRequest } from "./in-process-gateway.js";
import { capturePresenceToolAuthority } from "./presence-tool-authority.js";
import {
  SKILLS_STATUS_TIMEOUT_MS,
  SKILLS_STATUS_TOOL_DESCRIPTION,
} from "./skills-status-tool-contract.js";

/** Omitted selectors fall back to the assembled session context, never to ambient
 * defaults. An explicit session key resolves its own agent so the Gateway sees one
 * consistent target; an explicit agent-only query does not inherit another agent's
 * active session. */
export function resolveSkillsStatusParams(
  params: SkillsStatusParams,
  context: { agentId?: string; sessionKey?: string },
): SkillsStatusParams {
  if (params.sessionKey !== undefined) {
    const shape = classifySessionKeyShape(params.sessionKey);
    // Only a key that carries an agent prefix can be resolved here; unqualified aliases
    // ("main") stay untouched so the Gateway owner applies its configured default.
    const inferredAgentId =
      shape === "agent" || shape === "malformed_agent"
        ? resolveAgentIdFromSessionKey(params.sessionKey)
        : undefined;
    const agentId = params.agentId ?? inferredAgentId;
    return {
      sessionKey: params.sessionKey,
      ...(agentId ? { agentId } : {}),
      ...(params.refresh !== undefined ? { refresh: params.refresh } : {}),
    };
  }
  const agentId = params.agentId ?? (context.agentId || undefined);
  const sessionKey = params.agentId !== undefined ? undefined : context.sessionKey || undefined;
  return {
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(params.refresh !== undefined ? { refresh: params.refresh } : {}),
  };
}

export function createSkillsStatusTool(options?: {
  runId?: string;
  sessionAgentId?: string;
  /** Logical session key (agent:<id>:...), never the ephemeral session UUID. */
  sessionKey?: string;
  assertSourceCurrent?: () => void;
}): AnyAgentTool {
  const ownerAuthority = bindActiveOperatorTurnAuthority(options?.runId);
  return {
    name: "skills_status",
    label: "Skill Status",
    description: SKILLS_STATUS_TOOL_DESCRIPTION,
    parameters: SkillsStatusParamsSchema,
    execute: async (_toolCallId, params: SkillsStatusParams, signal) => {
      const assertSourceCurrent =
        options?.assertSourceCurrent ??
        capturePresenceToolAuthority({
          runId: options?.runId,
          ownerAuthority,
          surfaceName: "Skill status",
        });
      assertSourceCurrent();
      const request = bindAgentToolGatewayRequest({ hostedOnly: true });
      const result = await request<SkillStatusReport>({
        method: "skills.status",
        params: resolveSkillsStatusParams(params, {
          agentId: options?.sessionAgentId,
          sessionKey: options?.sessionKey,
        }),
        signal,
        assertDispatchCurrent: assertSourceCurrent,
        timeoutMs: SKILLS_STATUS_TIMEOUT_MS,
      });
      assertSourceCurrent();
      return jsonResult(result);
    },
  };
}
