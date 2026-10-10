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
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionEnvelope,
  type ExecutionIdentityAdmissionFacts,
} from "./execution-identity-admission.js";
import { processExecutionIdentityAdmissionWorkInDatabase } from "./execution-identity-context.js";

export function captureExecutionIdentityAdmissionEnvelope(
  admissionFacts: ExecutionIdentityAdmissionFacts,
  options: {
    now?: number;
    contextId?: string;
    executionId?: string;
    runtimeInstanceId?: string;
  } = {},
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
      ...(contextId !== undefined ? { contextId } : {}),
      ...(executionId !== undefined ? { executionId } : {}),
      ...(runtimeInstanceId !== undefined ? { runtimeInstanceId } : {}),
      ...(now !== undefined ? { now } : {}),
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
  options: Omit<Parameters<typeof processExecutionIdentityAdmissionWorkInDatabase>[1], "database"> &
    Pick<OpenClawStateDatabaseOptions, "database"> = {},
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
  const { contextId, executionId, runtimeInstanceId, now, limits, ...database } = options;
  const envelope = captureExecutionIdentityAdmissionEnvelope(admissionFacts, {
    ...(contextId !== undefined ? { contextId } : {}),
    ...(executionId !== undefined ? { executionId } : {}),
    ...(runtimeInstanceId !== undefined ? { runtimeInstanceId } : {}),
    ...(now !== undefined ? { now } : {}),
  });
  return persistExecutionIdentityAdmissionEnvelope(envelope, {
    ...database,
    ...(now !== undefined ? { now } : {}),
    ...(limits !== undefined ? { limits } : {}),
  });
}

export async function recordDeniedApprovalForRun(
  runId: string,
  database: OpenClawStateDatabaseOptions,
  id = "denied-approval",
  binding?: { contextId: string; executionId: string },
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
      ...(binding
        ? {
            executionIdentityToken: {
              tokenVersion: 1,
              createdAt: 100,
              runId,
              contextId: binding.contextId,
              executionId: binding.executionId,
            },
          }
        : {}),
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
