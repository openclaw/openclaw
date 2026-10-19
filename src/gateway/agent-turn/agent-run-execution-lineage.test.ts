import { describe, expect, it, onTestFinished } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { executionIdentitySpawnAdmission } from "../../audit/execution-identity-spawn-admission.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { withAgentRuntimeExecutionLineage } from "../agent-runtime-execution-lineage.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { prepareAgentRunExecutionIdentityFacts } from "./agent-run-execution-lineage.js";

function parentAdmission(params: {
  runtime: "acp" | "subagent";
  withToken: boolean;
  depth?: number;
}) {
  const operationalRunInstance = { instanceId: "parent-instance", runId: "parent-run" };
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  onTestFinished(() => void releaseAgentRunDelegatedAuthority(delegatedAuthority));
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: "parent-agent",
    sessionKey: "agent:parent:main",
    operationalRunInstance,
    delegatedAuthority: { ...delegatedAuthority, kind: "local" },
    ...(params.withToken
      ? {
          executionIdentity: createExecutionIdentityAdmissionToken("parent-run", {
            contextId: "parent-context",
            executionId: "parent-execution",
          }),
        }
      : {}),
    sessionSpawnContext: withAgentRuntimeExecutionLineage(
      { inheritedToolPolicy: { version: 1, allow: ["read"], deny: ["exec"] } },
      {
        relation: "sessions_spawn",
        requesterRef: "agent:parent:main",
        controllerRef: "agent:controller:main",
        depth: params.depth ?? 1,
        applicableGrantRefs: ["tool:sessions_spawn"],
        localPolicyRefs: ["local-policy"],
        runtimeAssuranceRefs: [`spawn-runtime:${params.runtime}`],
        targetPolicyRefs: ["target-policy"],
        externalNativeActions: params.runtime === "acp" ? "unsupported" : "observable",
      },
    ),
  };
  return {
    client: { internal: { agentRuntimeIdentity: identity } },
    context: {
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    },
    isRestartRecoveryResumeRun: false,
  };
}

describe("child execution identity lineage", () => {
  it("consumes the exact parent correlation and all narrowing-input categories", () => {
    const facts = prepareAgentRunExecutionIdentityFacts(
      parentAdmission({ runtime: "subagent", withToken: true, depth: 3 }),
      {},
    );

    expect(facts).toMatchObject({
      ingress: { kind: "subagent", boundary: "sessions_spawn.subagent" },
      invoker: { state: "present", kind: "agent", rawPrincipalRef: "parent-agent" },
      applicableGrants: [{ rawGrantRef: "tool:sessions_spawn", state: "present" }],
    });
    expect(
      executionIdentitySpawnAdmission({
        operation: "parse",
        value: facts?.spawnAdmission ?? "",
      }),
    ).toEqual([
      {
        parentContextId: "parent-context",
        parentExecutionId: "parent-execution",
        parentRunId: "parent-run",
        parentAgentId: "parent-agent",
        relation: "sessions_spawn",
        rawRequesterRef: "agent:parent:main",
        rawControllerRef: "agent:controller:main",
        depth: 3,
        localPolicyRefs: ["local-policy"],
        targetPolicyRefs: ["target-policy"],
      },
      [],
    ]);
    expect(facts?.assurance).toEqual([
      {
        kind: "spawn-lineage",
        rawEvidenceRef: "agent:parent:main",
        strength: "boundary-verified",
      },
      {
        kind: "runtime-binding",
        rawEvidenceRef: "spawn-runtime:subagent",
        strength: "boundary-verified",
      },
    ]);
  });

  it("reports missing parent evidence and unsupported ACP-native callbacks without inference", () => {
    const facts = prepareAgentRunExecutionIdentityFacts(
      parentAdmission({ runtime: "acp", withToken: false }),
      {},
    );

    expect(facts?.ingress.kind).toBe("acp");
    const [lineage, missingEvidence] = executionIdentitySpawnAdmission({
      operation: "parse",
      value: facts?.spawnAdmission ?? "",
    });
    expect(lineage).not.toHaveProperty("parentContextId");
    expect(missingEvidence).toEqual([
      "lineage.parent-context",
      "lineage.parent-execution",
      "lineage.parent-run",
      "acp.native-action-callback",
    ]);
    expect(JSON.stringify(facts)).not.toMatch(/task|prompt|externalSession/i);
  });
});
