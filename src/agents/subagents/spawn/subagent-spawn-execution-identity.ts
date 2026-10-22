import { createHash } from "node:crypto";
import type { ExecutionIdentityAdmissionToken } from "../../../audit/execution-identity-admission.js";
import { withAgentRuntimeExecutionLineage } from "../../../gateway/agent-runtime-execution-lineage.js";
import type { AgentRuntimeSessionSpawnContext } from "../../../gateway/agent-runtime-identity-token.js";
import { createPrivateContextCarrier } from "../../../shared/private-context-carrier.js";

type SubagentGatewayExecutionIdentity = {
  sessionSpawnContext?: AgentRuntimeSessionSpawnContext;
  parentExecutionIdentityToken?: ExecutionIdentityAdmissionToken;
};

const identities = createPrivateContextCarrier<SubagentGatewayExecutionIdentity>();

function spawnInputRef(kind: string, value: unknown): string {
  return `${kind}:${createHash("sha256").update(JSON.stringify(value)).digest("base64url")}`;
}

export function buildSubagentExecutionSessionSpawnContext(params: {
  enabled: boolean;
  backend: "acp" | "subagent";
  parentAgentId: string;
  requesterRef: string;
  controllerRef: string;
  depth: number;
  maxDepth?: number;
  targetAgentId: string;
  sandbox: "inherit" | "require";
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
}): AgentRuntimeSessionSpawnContext | undefined {
  if (!params.enabled) {
    return undefined;
  }
  const allow = params.inheritedToolAllowlist ?? [];
  const deny = params.inheritedToolDenylist ?? [];
  return withAgentRuntimeExecutionLineage(
    {
      inheritedToolPolicy: { version: 1, allow, deny },
    },
    {
      relation: "sessions_spawn",
      requesterRef: params.requesterRef,
      controllerRef: params.controllerRef,
      depth: params.depth,
      applicableGrantRefs: ["tool:sessions_spawn"],
      localPolicyRefs: [
        spawnInputRef("spawn-depth-policy", [params.depth, params.maxDepth]),
        spawnInputRef("sandbox-policy", [params.backend, params.sandbox]),
        spawnInputRef("inherited-tool-policy", {
          allow: allow.toSorted(),
          deny: deny.toSorted(),
        }),
      ],
      runtimeAssuranceRefs: [`spawn-runtime:${params.backend}`],
      targetPolicyRefs: [
        spawnInputRef("target-policy", [params.parentAgentId, params.targetAgentId]),
      ],
      externalNativeActions: params.backend === "acp" ? "unsupported" : "observable",
    },
  );
}

export function withSubagentGatewayExecutionIdentity<T extends object>(
  params: T,
  facts: SubagentGatewayExecutionIdentity,
): T {
  return identities.carry(params, facts);
}

export const readSubagentGatewayExecutionIdentity = identities.read;
