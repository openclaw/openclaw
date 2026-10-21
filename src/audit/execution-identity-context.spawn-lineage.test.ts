import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { ExecutionIdentityAdmissionFacts } from "./execution-identity-admission.js";
import { executionIdentitySpawnAdmission } from "./execution-identity-spawn-admission.js";
import { prepareExecutionIdentityContextAtAdmission } from "./execution-identity.test-support.js";

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
    value: {
      runId,
      agentId: "main",
      ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
      runtime: { kind: "embedded" },
      ...admissionOverrides,
    },
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

  it("keeps attribution visible when parent evidence and ACP callbacks are unavailable", () => {
    const context = prepareContext("acp-child", {
      ingress: { kind: "acp", boundary: "sessions_spawn.acp", state: "present" },
      invoker: { state: "present", kind: "agent", rawPrincipalRef: "parent-agent" },
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
      ],
    });

    expect(context.coverageState).toBe("attribution-only");
    expect(context.lineage).toMatchObject({ depth: 1 });
    expect(context.lineage).not.toHaveProperty("parentContextId");
    expect(context.missingEvidence).toEqual([
      "acp.native-action-callback",
      "lineage.parent-context",
      "lineage.parent-execution",
      "lineage.parent-run",
    ]);
  });

  it("deduplicates sorted missing invoker evidence across admission and spawn lineage", () => {
    const context = prepareContext("missing-invoker", {
      spawnMissingEvidence: ["invoker.principal", "acp.native-action-callback"],
    });

    expect(context.missingEvidence).toEqual(["acp.native-action-callback", "invoker.principal"]);
  });
});
