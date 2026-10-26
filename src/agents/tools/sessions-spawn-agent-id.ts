import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listAgentIds } from "../agent-scope-config.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { describeAcpSpawnTargetParameter } from "../subagents/spawn/acp-spawn-target.js";
import {
  describeSubagentSpawnTargetParameter,
  resolveSubagentSpawnTargetConfig,
} from "../subagents/spawn/subagent-target-policy.js";

/**
 * Describe the `sessions_spawn` `agentId` parameter for the requester's admitted targets.
 * Returns undefined when neither runtime has a target choice worth describing.
 */
export function describeSessionsSpawnAgentId(params: {
  cfg: OpenClawConfig;
  requesterAgentId?: string;
  requesterIsSubagent: boolean;
  acpAvailable: boolean;
  collectDefaultAgentId?: string;
  /** Inherited sender restrictions; they narrow the admitted targets. */
  spawnContext?: Pick<
    SpawnedToolContext,
    "inheritedToolPolicySource" | "workspaceDir" | "sessionPermissionPolicy"
  >;
}): string | undefined {
  const requesterAgentId = params.requesterAgentId ?? "";
  const { inheritedToolPolicySource, workspaceDir, sessionPermissionPolicy } =
    params.spawnContext ?? {};
  const native = describeSubagentSpawnTargetParameter({
    requesterAgentId,
    ...resolveSubagentSpawnTargetConfig(params.cfg, requesterAgentId),
    configuredAgentIds: listAgentIds(params.cfg),
    collectDefaultAgentId: params.collectDefaultAgentId,
    inheritedToolPolicySource,
  });
  if (!params.acpAvailable) {
    return native;
  }
  // ACP spawn admission applies subagent target policy to subagent and sender-restricted requesters.
  const subagentRequesterId =
    params.requesterIsSubagent || inheritedToolPolicySource === "sender"
      ? requesterAgentId
      : undefined;
  const acp = describeAcpSpawnTargetParameter(params.cfg, subagentRequesterId, {
    requesterAgentId,
    inheritedToolPolicySource,
    workspaceDir,
    sessionPermissionPolicy,
  });
  const nativeClause = native ? `With runtime="subagent" (default): ${native} ` : "";
  return `${nativeClause}With runtime="acp": ${acp}`;
}
