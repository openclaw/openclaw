import {
  insertOperatorApproval,
  resolveOperatorApproval,
} from "../gateway/operator-approval-store.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  configureExecutionIdentityAdmissionSink,
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionEnvelope,
  type ExecutionIdentityAdmissionFacts,
} from "./execution-identity-admission.js";
import { processExecutionIdentityAdmissionWorkInDatabase } from "./execution-identity-context.js";

export function executionIdentityFacts(
  runId: string,
  overrides: Partial<ExecutionIdentityAdmissionFacts> = {},
): ExecutionIdentityAdmissionFacts {
  return {
    runId,
    agentId: "main",
    ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
    runtime: { kind: "embedded" },
    ...overrides,
  };
}

export function captureExecutionIdentityAdmissionEnvelope(
  admissionFacts: ExecutionIdentityAdmissionFacts,
  options: Pick<
    Parameters<typeof enqueueExecutionIdentityContextAtAdmission>[1],
    "now" | "contextId" | "executionId" | "runtimeInstanceId"
  > = {},
): ExecutionIdentityAdmissionEnvelope {
  const { contextId, executionId, runtimeInstanceId, now } = options;
  let envelope: ExecutionIdentityAdmissionEnvelope | undefined;
  const clear = configureExecutionIdentityAdmissionSink((captured) => {
    if (captured.kind === "capture") {
      envelope = captured.envelope;
    }
    return true;
  });
  try {
    const result = enqueueExecutionIdentityContextAtAdmission(admissionFacts, {
      enabled: true,
      contextId,
      executionId,
      runtimeInstanceId,
      now,
    });
    if (!result || !envelope) {
      throw new Error("expected admission envelope");
    }
    return envelope;
  } finally {
    clear();
  }
}

export function persistExecutionIdentityAdmissionEnvelope(
  envelope: ExecutionIdentityAdmissionEnvelope,
  options: Partial<Parameters<typeof processExecutionIdentityAdmissionWorkInDatabase>[1]> = {},
) {
  return processExecutionIdentityAdmissionWorkInDatabase(
    { kind: "capture", envelope },
    { ...options, database: openOpenClawStateDatabase(options) },
  );
}

export function prepareExecutionIdentityContextAtAdmission(
  admissionFacts: ExecutionIdentityAdmissionFacts,
  options: Parameters<typeof captureExecutionIdentityAdmissionEnvelope>[1] &
    Parameters<typeof persistExecutionIdentityAdmissionEnvelope>[1] = {},
) {
  return persistExecutionIdentityAdmissionEnvelope(
    captureExecutionIdentityAdmissionEnvelope(admissionFacts, options),
    options,
  );
}

export async function recordDeniedApprovalForRun(
  runId: string,
  database: OpenClawStateDatabaseOptions,
  id: string,
  binding: { contextId: string; executionId: string },
): Promise<void> {
  await insertOperatorApproval({
    approval: {
      id,
      kind: "exec",
      presentation: {
        kind: "exec",
        commandText: "details withheld",
        allowedDecisions: ["allow-once", "deny"],
      },
      source: { runId, toolCallId: "private-tool-call", toolName: "exec" },
      runtimeEpoch: "runtime-1",
      createdAtMs: 100,
      expiresAtMs: 1_000,
      executionIdentityToken: createExecutionIdentityAdmissionToken(runId, {
        contextId: binding.contextId,
        executionId: binding.executionId,
        now: 100,
      }),
    },
    databaseOptions: database,
  });
  await resolveOperatorApproval({
    id,
    decision: "deny",
    resolver: { kind: "device", id: "private-reviewer-device" },
    nowMs: 200,
    databaseOptions: database,
  });
}
