import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  configureExecutionIdentityAdmissionSink,
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionEnvelope,
  type ExecutionIdentityAdmissionFacts,
} from "./execution-identity-admission.js";
import { processExecutionIdentityAdmissionWorkInDatabase } from "./execution-identity-context.js";
import { executionIdentitySpawnAdmission } from "./execution-identity-spawn-admission.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function facts(
  runId: string,
  overrides: Partial<ExecutionIdentityAdmissionFacts> & {
    spawnLineage?: Record<string, unknown>;
    spawnMissingEvidence?: string[];
  } = {},
): ExecutionIdentityAdmissionFacts {
  const { spawnLineage, spawnMissingEvidence, ...admissionOverrides } = overrides;
  return executionIdentitySpawnAdmission({
    operation: "attach",
    value: {
      runId,
      agentId: "main",
      ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
      runtime: { kind: "embedded" },
      ...admissionOverrides,
    },
    extra:
      spawnLineage || spawnMissingEvidence
        ? executionIdentitySpawnAdmission({
            operation: "serialize",
            value: spawnLineage,
            extra: spawnMissingEvidence ?? [],
          })
        : undefined,
  });
}

function prepareContext(
  admissionFacts: ExecutionIdentityAdmissionFacts,
  ids: { contextId: string; executionId: string; now?: number },
) {
  let envelope: ExecutionIdentityAdmissionEnvelope | undefined;
  const clear = configureExecutionIdentityAdmissionSink((captured) => {
    if (captured.kind === "capture") {
      envelope = captured.envelope;
    }
    return true;
  });
  try {
    enqueueExecutionIdentityContextAtAdmission(admissionFacts, {
      enabled: true,
      contextId: ids.contextId,
      executionId: ids.executionId,
      ...(ids.now !== undefined ? { now: ids.now } : {}),
    });
  } finally {
    clear();
  }
  if (!envelope) {
    throw new Error("expected admission envelope");
  }
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-lineage-") } };
  return processExecutionIdentityAdmissionWorkInDatabase(
    { kind: "capture", envelope },
    {
      ...options,
      database: openOpenClawStateDatabase(options),
      ...(ids.now !== undefined ? { now: ids.now } : {}),
    },
  );
}

describe("execution identity child lineage", () => {
  it("projects copied spawn facts without retaining raw owner refs", () => {
    const context = prepareContext(
      {
        ...facts("child-run", {
          ingress: { kind: "subagent", boundary: "sessions_spawn.subagent", state: "present" },
          invoker: { state: "present", kind: "agent", rawPrincipalRef: "parent-agent" },
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
        }),
      },
      { contextId: "child-context", executionId: "child-execution", now: 100 },
    );

    expect(context.coverageState).toBe("attribution-only");
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
      /private-requester|private-controller|local-policy-secret|target-policy-secret|native-spawn-proof|tool:sessions_spawn/,
    );
  });

  it("keeps attribution visible when parent evidence and ACP callbacks are unavailable", () => {
    const context = prepareContext(
      facts("acp-child", {
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
      }),
      { contextId: "acp-context", executionId: "acp-execution" },
    );

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
    const context = prepareContext(
      facts("missing-invoker", {
        spawnMissingEvidence: ["invoker.principal", "acp.native-action-callback"],
      }),
      { contextId: "missing-invoker-context", executionId: "missing-invoker-execution" },
    );

    expect(context.missingEvidence).toEqual(["acp.native-action-callback", "invoker.principal"]);
  });
});
