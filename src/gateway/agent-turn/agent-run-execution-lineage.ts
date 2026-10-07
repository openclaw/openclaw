import type { ExecutionIdentityAdmissionFacts } from "../../audit/execution-identity-admission.js";
import { executionIdentitySpawnAdmission } from "../../audit/execution-identity-spawn-admission.js";
import { runWithDelegatedExecutionLineage } from "../../delegation/delegated-execution-scope.js";
import {
  consumeAgentRuntimeExecutionLineage,
  readAgentRuntimeExecutionLineage,
} from "../agent-runtime-execution-lineage.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";

type ExecutionIdentitySpawnFacts = Pick<
  ExecutionIdentityAdmissionFacts,
  "applicableGrants" | "assurance" | "ingress" | "invoker"
> & {
  spawnAdmission: string;
};

/** Consume authenticated spawn provenance once, at the child admission owner. */
export function resolveExecutionIdentitySpawnFacts(
  identity: AgentRuntimeIdentity | undefined,
): ExecutionIdentitySpawnFacts | undefined {
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

/**
 * Raised when a trusted Gateway identity carried a delegated execution lineage
 * but that identity is no longer current. Dropping the relation would let the
 * child run as DIRECT, so the child run is refused instead (fail closed).
 */
export class DelegatedExecutionChildLineageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegatedExecutionChildLineageError";
  }
}

/**
 * The delegated execution lineage a child run inherits from the trusted Gateway
 * identity that launched it.
 *
 * The lineage is carried alongside sessionSpawnContext/parentExecutionIdentityToken
 * on the Host-owned identity. It is only re-bound after the caller has validated
 * that identity; a value carried by a missing or stale identity is never trusted
 * and fails closed rather than silently running the child as unrelated work.
 */
export function resolveChildRunDelegatedExecutionLineage(params: {
  identity: AgentRuntimeIdentity | undefined;
  identityCurrent: boolean;
}): string | undefined {
  const lineageRef = params.identity?.delegatedExecutionLineage;
  if (typeof lineageRef !== "string" || lineageRef.length === 0) {
    return undefined;
  }
  if (!params.identityCurrent) {
    throw new DelegatedExecutionChildLineageError(
      "delegated execution lineage requires a current trusted parent identity",
    );
  }
  return lineageRef;
}

/**
 * Runs a child execution inside the delegated lineage it proved. The ambient
 * Host scope is what lets the already-wired agent/tool admission gates see the
 * inherited relation automatically; an unrelated child runs with no scope.
 */
export function runWithChildRunDelegatedExecutionLineage<T>(
  lineageRef: string | undefined,
  run: () => T,
): T {
  return lineageRef ? runWithDelegatedExecutionLineage(lineageRef, run) : run();
}
