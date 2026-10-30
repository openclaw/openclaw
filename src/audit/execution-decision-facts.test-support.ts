import type {
  DecisionReceiptV1,
  ExecutionIdentityContextV1,
} from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { createExecutionIdentityAdmissionToken } from "./execution-identity-admission.js";
import { prepareExecutionIdentityContextAtAdmission } from "./execution-identity.test-support.js";

export function receipt(id: string, occurredAt = 100): DecisionReceiptV1 {
  return {
    schemaVersion: 1,
    receiptId: id,
    contextId: "context-1",
    executionId: "execution-1",
    runId: "run-1",
    actionId: `action-${id}`,
    occurredAt,
    action: { family: "tool", operation: "policy" },
    decision: { outcome: "denied", reasonCode: "tool_policy_denied" },
    enforcement: {
      coverageState: "enforced",
      evaluatorRef: "tool-policy",
      policyRefs: ["tool-policy:deny"],
      grantRefs: [],
      contextFieldsUsed: ["runId"],
    },
    source: {
      owner: "tool-policy",
      recordRef: `record-${id}`,
      decisionBoundary: "agent-tool.before-call",
    },
    missingEvidence: [],
    remediation: [{ code: "choose_allowed_tool", text: "Choose an allowed tool and retry." }],
  };
}

export function seedExecutionContext(
  database: OpenClawStateDatabaseOptions,
  overrides: {
    runId?: string;
    contextId?: string;
    executionId?: string;
  } = {},
): ExecutionIdentityContextV1 {
  const runId = overrides.runId ?? "run-1";
  const contextId = overrides.contextId ?? "context-1";
  const executionId = overrides.executionId ?? "execution-1";
  const stored = prepareExecutionIdentityContextAtAdmission(
    {
      runId,
      agentId: "main",
      ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
      runtime: { kind: "embedded" },
    },
    { ...database, now: 50, contextId, executionId, runtimeInstanceId: "runtime-1" },
  );
  if (
    stored.contextId !== contextId ||
    stored.executionId !== executionId ||
    stored.runId !== runId
  ) {
    throw new Error(`unexpected execution context: ${JSON.stringify(stored)}`);
  }
  return stored;
}

export function tokenForContext(context: ExecutionIdentityContextV1) {
  return createExecutionIdentityAdmissionToken(context.runId, {
    contextId: context.contextId,
    executionId: context.executionId,
    now: context.createdAt,
  });
}

export function createUnattributedExecutionContext(): ExecutionIdentityContextV1 {
  return {
    schemaVersion: 1,
    contextId: "context-1",
    executionId: "execution-1",
    runId: "run-1",
    createdAt: 50,
    trustDomain: { kind: "gateway-cell", domainRef: "domain-1", state: "present" },
    invoker: { state: "absent" },
    ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
    agentPrincipal: { kind: "agent", domainRef: "domain-1", principalRef: "agent-main" },
    agentDefinition: { definitionRef: "main", state: "present" },
    runtimeInstance: { runtimeRef: "runtime-1", kind: "embedded", state: "present" },
    applicableGrants: [],
    assurance: [],
    coverageState: "unattributed",
    missingEvidence: [],
  };
}
