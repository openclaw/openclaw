import {
  configureExecutionIdentityAdmissionSink,
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionEnvelope,
  type ExecutionIdentityAdmissionFacts,
} from "./execution-identity-admission.js";
import { processExecutionIdentityAdmissionWork } from "./execution-identity-context.js";

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
  options: Parameters<typeof processExecutionIdentityAdmissionWork>[1] = {},
) {
  return processExecutionIdentityAdmissionWork({ kind: "capture", envelope }, options);
}
