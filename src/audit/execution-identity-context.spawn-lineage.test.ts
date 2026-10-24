import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { ExecutionIdentityAdmissionFacts } from "./execution-identity-admission.js";
import { executionIdentitySpawnAdmission } from "./execution-identity-spawn-admission.js";
import {
  executionIdentityFacts,
  prepareExecutionIdentityContextAtAdmission,
} from "./execution-identity.test-support.js";

afterEach(closeOpenClawStateDatabaseForTest);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function prepareContext(
  runId: string,
  overrides: Partial<ExecutionIdentityAdmissionFacts> & {
    spawnLineage?: Record<string, unknown>;
    spawnMissingEvidence?: string[];
  },
) {
  const { spawnLineage, spawnMissingEvidence = [], ...admissionOverrides } = overrides;
  const admissionFacts: ExecutionIdentityAdmissionFacts = executionIdentitySpawnAdmission({
    operation: "attach",
    value: executionIdentityFacts(runId, admissionOverrides),
    extra: executionIdentitySpawnAdmission({
      operation: "serialize",
      value: spawnLineage,
      extra: spawnMissingEvidence,
    }),
  });
  return prepareExecutionIdentityContextAtAdmission(admissionFacts, {
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-lineage-") },
  });
}

describe("execution identity child lineage", () => {
  it("projects copied spawn facts without retaining raw owner refs", () => {
    const context = prepareContext("child-run", {
      ingress: { kind: "subagent", boundary: "sessions_spawn.subagent", state: "present" },
      invoker: { state: "present", kind: "agent", rawPrincipalRef: "parent-agent" },
      representedSubject: {
        state: "present",
        kind: "person",
        rawPrincipalRef: "selected-person",
      },
      applicableGrants: [{ rawGrantRef: "tool:sessions_spawn", state: "present" }],
      assurance: [
        {
          kind: "spawn-lineage",
          rawEvidenceRef: "native-spawn-proof",
          strength: "boundary-verified",
        },
      ],
      spawnLineage: {
        parentContextId: "parent-context",
        parentExecutionId: "parent-execution",
        parentRunId: "parent-run",
        parentAgentId: "parent-agent",
        relation: "sessions_spawn",
        rawRequesterRef: "agent:main:private-requester",
        rawControllerRef: "agent:main:private-controller",
        depth: 2,
        localPolicyRefs: ["local-policy-secret"],
        targetPolicyRefs: ["target-policy-secret"],
      },
    });

    expect(context.coverageState).toBe("attribution-only");
    expect(context.invoker.principal?.kind).toBe("agent");
    expect(context.representedSubject).toEqual({
      state: "present",
      principal: {
        kind: "person",
        domainRef: context.trustDomain.domainRef,
        principalRef: expect.stringMatching(/^hmac-sha256:v1:/u),
      },
    });
    expect(context.lineage).toMatchObject({
      parentContextId: "parent-context",
      parentExecutionId: "parent-execution",
      parentRunId: "parent-run",
      parentAgentPrincipal: { kind: "agent", principalRef: "parent-agent" },
      depth: 2,
      delegationRef: expect.any(String),
    });
    expect(context.applicableGrants).toHaveLength(1);
    expect(context.assurance).toHaveLength(1);
    expect(context.missingEvidence).toEqual([]);
    expect(JSON.stringify(context)).not.toMatch(
      /selected-person|private-requester|private-controller|local-policy-secret|target-policy-secret|native-spawn-proof|tool:sessions_spawn/,
    );
  });

  it("keeps lineage attribution and deduplicates missing parent, invoker, and ACP evidence", () => {
    const context = prepareContext("acp-child", {
      ingress: { kind: "acp", boundary: "sessions_spawn.acp", state: "present" },
      spawnLineage: {
        parentAgentId: "parent-agent",
        relation: "sessions_spawn",
        rawRequesterRef: "requester",
        rawControllerRef: "controller",
        depth: 1,
        localPolicyRefs: [],
        targetPolicyRefs: [],
      },
      spawnMissingEvidence: [
        "lineage.parent-context",
        "lineage.parent-execution",
        "lineage.parent-run",
        "acp.native-action-callback",
        "invoker.principal",
      ],
    });

    expect(context.coverageState).toBe("attribution-only");
    expect(context.lineage).toMatchObject({ depth: 1 });
    expect(context.lineage).not.toHaveProperty("parentContextId");
    expect(context.missingEvidence).toEqual([
      "acp.native-action-callback",
      "invoker.principal",
      "lineage.parent-context",
      "lineage.parent-execution",
      "lineage.parent-run",
    ]);
  });
});
