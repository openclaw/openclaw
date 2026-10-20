import { expect, it, onTestFinished } from "vitest";
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

function childFacts(runtime: "acp" | "subagent", withToken: boolean, depth = 1) {
  const operationalRunInstance = { instanceId: "parent-instance", runId: "parent-run" };
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  onTestFinished(() => void releaseAgentRunDelegatedAuthority(delegatedAuthority));
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: "parent-agent",
    sessionKey: "agent:parent:main",
    operationalRunInstance,
    delegatedAuthority: { ...delegatedAuthority, kind: "local" },
    ...(withToken
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
        depth,
        applicableGrantRefs: ["tool:sessions_spawn"],
        localPolicyRefs: ["local-policy"],
        runtimeAssuranceRefs: [`spawn-runtime:${runtime}`],
        targetPolicyRefs: ["target-policy"],
        externalNativeActions: runtime === "acp" ? "unsupported" : "observable",
      },
    ),
  };
  const facts = prepareAgentRunExecutionIdentityFacts(
    {
      client: { internal: { agentRuntimeIdentity: identity } },
      context: {
        validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
      },
      isRestartRecoveryResumeRun: false,
    },
    {},
  );
  return {
    facts,
    parsed: executionIdentitySpawnAdmission({
      operation: "parse",
      value: facts?.spawnAdmission ?? "",
    }),
  };
}

it("consumes the exact parent correlation and all narrowing-input categories", () => {
  const { facts, parsed } = childFacts("subagent", true, 3);

  expect(facts).toMatchObject({
    ingress: { kind: "subagent", boundary: "sessions_spawn.subagent" },
    invoker: { state: "present", kind: "agent", rawPrincipalRef: "parent-agent" },
    applicableGrants: [{ rawGrantRef: "tool:sessions_spawn", state: "present" }],
  });
  expect(parsed).toEqual([
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
  expect(facts?.assurance).toEqual(
    [
      ["spawn-lineage", "agent:parent:main"],
      ["runtime-binding", "spawn-runtime:subagent"],
    ].map(([kind, rawEvidenceRef]) => ({ kind, rawEvidenceRef, strength: "boundary-verified" })),
  );
});

it("reports missing parent evidence and unsupported ACP-native callbacks without inference", () => {
  const {
    facts,
    parsed: [lineage, missingEvidence],
  } = childFacts("acp", false);

  expect(facts?.ingress.kind).toBe("acp");
  expect(lineage).not.toHaveProperty("parentContextId");
  expect(missingEvidence).toEqual([
    "lineage.parent-context",
    "lineage.parent-execution",
    "lineage.parent-run",
    "acp.native-action-callback",
  ]);
  expect(JSON.stringify(facts)).not.toMatch(/task|prompt|externalSession/i);
});
