import { attachAgentCommandAdmissionFacts } from "../../agents/agent-command-admission-facts.js";
import type { AgentCommandExecutionIdentitySpawnFacts } from "../../agents/agent-command-execution-identity-spawn.js";
import { executionIdentitySpawnAdmission } from "../../audit/execution-identity-spawn-admission.js";
import {
  consumeAgentRuntimeExecutionLineage,
  readAgentRuntimeExecutionLineage,
} from "../agent-runtime-execution-lineage.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { getGatewayLocalUserIngress } from "../local-user-ingress.js";
import type { StartAgentRunExecutionParams } from "./agent-run-execution-types.js";

export function prepareAgentRunExecutionIdentityFacts(
  params: {
    client: Pick<NonNullable<StartAgentRunExecutionParams["client"]>, "internal"> | null;
    context: Pick<StartAgentRunExecutionParams["context"], "validateAgentRuntimeApprovalAuthority">;
  },
  runContext: object,
  representedProfileId?: string,
): AgentCommandExecutionIdentitySpawnFacts | undefined {
  const agentRuntimeIdentity = params.client?.internal?.agentRuntimeIdentity;
  const currentAgentRuntimeIdentity =
    agentRuntimeIdentity &&
    params.context.validateAgentRuntimeApprovalAuthority?.(agentRuntimeIdentity) === true
      ? agentRuntimeIdentity
      : undefined;
  const spawnFacts = resolveExecutionIdentitySpawnFacts(
    currentAgentRuntimeIdentity,
    representedProfileId,
  );
  const localUserIngress = getGatewayLocalUserIngress(params.client);
  const invokingAgentId =
    params.client?.internal?.agentToolCaller?.agentId ?? currentAgentRuntimeIdentity?.agentId;
  if (invokingAgentId) {
    attachAgentCommandAdmissionFacts(runContext, {
      ingress: { kind: "api", boundary: "gateway.agent-tool", state: "present" },
      invoker: { state: "present", kind: "agent", rawPrincipalRef: invokingAgentId },
      ...(representedProfileId !== undefined
        ? {
            representedSubject: {
              state: "present",
              kind: "person",
              rawPrincipalRef: representedProfileId,
            },
          }
        : {}),
    });
  } else if (localUserIngress) {
    attachAgentCommandAdmissionFacts(runContext, localUserIngress.facts);
  }
  return spawnFacts;
}

/** Consume authenticated spawn provenance once, at the child admission owner. */
function resolveExecutionIdentitySpawnFacts(
  identity: AgentRuntimeIdentity | undefined,
  representedProfileId?: string,
): AgentCommandExecutionIdentitySpawnFacts | undefined {
  const lineage = readAgentRuntimeExecutionLineage(identity?.sessionSpawnContext);
  if (!identity || !lineage || !consumeAgentRuntimeExecutionLineage(identity)) {
    return undefined;
  }
  const parent = identity.executionIdentity;
  return {
    ingress: {
      kind: lineage.externalNativeActions === "unsupported" ? "acp" : "subagent",
      boundary: `sessions_spawn.${lineage.externalNativeActions === "unsupported" ? "acp" : "subagent"}`,
      state: "present",
    },
    invoker: { state: "present", kind: "agent", rawPrincipalRef: identity.agentId },
    ...(representedProfileId
      ? {
          representedSubject: {
            state: "present" as const,
            kind: "person" as const,
            rawPrincipalRef: representedProfileId,
          },
        }
      : {}),
    applicableGrants: lineage.applicableGrantRefs.map((rawGrantRef) => ({
      rawGrantRef,
      state: "present",
    })),
    assurance: [
      {
        kind: "spawn-lineage",
        rawEvidenceRef: lineage.requesterRef,
        strength: "boundary-verified",
      },
      ...lineage.runtimeAssuranceRefs.map((rawEvidenceRef) => ({
        kind: "runtime-binding" as const,
        rawEvidenceRef,
        strength: "boundary-verified" as const,
      })),
    ],
    spawnAdmission: executionIdentitySpawnAdmission({
      operation: "serialize",
      value: {
        ...(parent?.contextId ? { parentContextId: parent.contextId } : {}),
        ...(parent?.executionId ? { parentExecutionId: parent.executionId } : {}),
        ...(parent?.runId ? { parentRunId: parent.runId } : {}),
        parentAgentId: identity.agentId,
        relation: lineage.relation,
        rawRequesterRef: lineage.requesterRef,
        rawControllerRef: lineage.controllerRef,
        depth: lineage.depth,
        localPolicyRefs: lineage.localPolicyRefs,
        targetPolicyRefs: lineage.targetPolicyRefs,
      },
      extra: [
        ...(!parent?.contextId ? ["lineage.parent-context"] : []),
        ...(!parent?.executionId ? ["lineage.parent-execution"] : []),
        ...(!parent?.runId ? ["lineage.parent-run"] : []),
        ...(lineage.externalNativeActions === "unsupported" ? ["acp.native-action-callback"] : []),
      ],
    }),
  };
}
