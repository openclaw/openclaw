import {
  SkillsStatusParamsSchema,
  type SkillsStatusParams,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
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
 * defaults. An explicit session key selects the target alone; the injected agent id
 * is not paired with it, so the Gateway resolves one consistent target. */
export function resolveSkillsStatusParams(
  params: SkillsStatusParams,
  context: { agentId?: string; sessionKey?: string },
): SkillsStatusParams {
  if (params.sessionKey !== undefined) {
    return {
      sessionKey: params.sessionKey,
      ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
      ...(params.refresh !== undefined ? { refresh: params.refresh } : {}),
    };
  }
  const agentId = params.agentId ?? (context.agentId || undefined);
  const sessionKey = context.sessionKey || undefined;
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
