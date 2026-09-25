import { createHash } from "node:crypto";
import type { ExecutionIdentityAdmissionToken } from "../../../audit/execution-identity-admission.js";
import { withAgentRuntimeExecutionLineage } from "../../../gateway/agent-runtime-execution-lineage.js";
import type { AgentRuntimeSessionSpawnContext } from "../../../gateway/agent-runtime-identity-token.js";
import {
  parseInheritedToolPolicyV2,
  type InheritedToolPolicyV2,
} from "../../inherited-tool-policy.schema.js";

type SubagentGatewayExecutionIdentity = {
  sessionSpawnContext?: AgentRuntimeSessionSpawnContext;
  parentExecutionIdentityToken?: ExecutionIdentityAdmissionToken;
};

const subagentGatewayExecutionIdentities = new WeakMap<object, SubagentGatewayExecutionIdentity>();

function spawnInputRef(kind: string, value: unknown): string {
  return `${kind}:${createHash("sha256").update(JSON.stringify(value)).digest("base64url")}`;
}

export function buildSubagentExecutionSessionSpawnContext(
  params: {
    enabled: boolean;
    parentAgentId: string;
    requesterRef: string;
    controllerRef: string;
    depth: number;
    maxDepth?: number;
    targetAgentId: string;
    sandbox: "inherit" | "require";
  } & (
    | { backend: "subagent"; inheritedToolPolicy: InheritedToolPolicyV2 }
    | {
        backend: "acp";
        inheritedToolPolicy?: InheritedToolPolicyV2;
        inheritedToolAllowlist?: string[];
        inheritedToolDenylist?: string[];
      }
  ),
): AgentRuntimeSessionSpawnContext | undefined {
  if (!params.enabled) {
    return undefined;
  }
  const inheritedToolPolicy =
    params.backend === "subagent" || params.inheritedToolPolicy
      ? { version: 2 as const, policy: parseInheritedToolPolicyV2(params.inheritedToolPolicy) }
      : {
          version: 1 as const,
          allow: params.inheritedToolAllowlist ?? [],
          deny: params.inheritedToolDenylist ?? [],
        };
  return withAgentRuntimeExecutionLineage(
    {
      inheritedToolPolicy,
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
        spawnInputRef(
          "inherited-tool-policy",
          inheritedToolPolicy.version === 2
            ? inheritedToolPolicy
            : {
                allow: inheritedToolPolicy.allow.toSorted(),
                deny: inheritedToolPolicy.deny.toSorted(),
              },
        ),
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
  const carried = { ...params };
  subagentGatewayExecutionIdentities.set(carried, facts);
  return carried;
}

export function readSubagentGatewayExecutionIdentity(
  params: object,
): SubagentGatewayExecutionIdentity | undefined {
  return subagentGatewayExecutionIdentities.get(params);
}
