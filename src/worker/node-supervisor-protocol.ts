import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { parseWorkerLaunchPlan, type WorkerLaunchPlan } from "./launch-descriptor.js";
import { workerProtocolObject } from "./protocol-record.js";

const IDENTIFIER_MAX_CHARS = 256;
const GATEWAY_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const NODE_WORKER_SUPERVISOR_CONTROL_REQUEST_MAX_BYTES = 4 * 1024;
const NODE_WORKER_RESULT_JSON_MAX_BYTES = 64 * 1024;
const NODE_WORKER_ERROR_TEXT_MAX_BYTES = 4 * 1024;
const NODE_WORKER_CONNECTION_FAILURE_CAUSE_MAX_BYTES = 64 * 1024;
export const NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE = "openclaw-worker-connection-failure-v1";

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlanHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

const identifier = (label: string, maxChars = IDENTIFIER_MAX_CHARS) =>
  z.custom<string>(
    (value) =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= maxChars &&
      value.trim() === value &&
      !value.includes("\0"),
    { error: `INVALID_REQUEST: ${label} must be a bounded non-empty identifier` },
  );
const nonNegativeInteger = (label: string) =>
  z.custom<number>(isNonNegativeInteger, {
    error: `INVALID_REQUEST: ${label} must be a non-negative safe integer`,
  });
const GatewayNamespace = identifier("gatewayNamespace").refine(
  (value) => typeof value === "string" && GATEWAY_NAMESPACE_PATTERN.test(value),
  { error: "INVALID_REQUEST: gatewayNamespace must be a safe bounded path component" },
);
const IdentityShape = {
  launchId: identifier("launchId"),
  planHash: z.custom<string>(isPlanHash, {
    error: "INVALID_REQUEST: planHash must be 64 lowercase hexadecimal characters",
  }),
  environmentId: identifier("environmentId"),
  sessionId: identifier("sessionId"),
  ownerEpoch: nonNegativeInteger("ownerEpoch"),
  placementGeneration: nonNegativeInteger("placementGeneration"),
  runId: identifier("runId"),
};
const Identity = workerProtocolObject(IdentityShape);
const EnvironmentStop = workerProtocolObject({
  gatewayNamespace: GatewayNamespace,
  environmentId: IdentityShape.environmentId,
  sessionId: IdentityShape.sessionId,
  ownerEpoch: IdentityShape.ownerEpoch,
});
const LaunchInput = workerProtocolObject({
  environmentSession: z.literal(1, {
    error: "INVALID_REQUEST: node worker environment lifetime support required",
  }),
  sessionKey: identifier("sessionKey", 1_024).optional(),
  launchId: IdentityShape.launchId,
  gatewayNamespace: GatewayNamespace,
  expectedBundleHash: z.custom<string>(isPlanHash, {
    error: "INVALID_REQUEST: expectedBundleHash must be 64 lowercase hexadecimal characters",
  }),
  descriptor: z.transform((value, context) => {
    try {
      return parseWorkerLaunchPlan(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "INVALID_REQUEST: invalid worker launch descriptor",
      });
      return z.NEVER;
    }
  }),
  placementGeneration: IdentityShape.placementGeneration,
});
const Lookup = workerProtocolObject({ launchId: IdentityShape.launchId });
const Receipt = z.union([
  workerProtocolObject({ ...IdentityShape, state: z.enum(["pending", "running"]) }),
  workerProtocolObject({
    ...IdentityShape,
    state: z.literal("completed"),
    resultJson: z.custom<string>(isBoundedResultJson),
  }),
  workerProtocolObject({
    ...IdentityShape,
    state: z.enum(["failed", "interrupted", "cancelled"]),
    errorText: z.custom<string>(isBoundedErrorText),
  }),
]);
const ConnectionFailure = workerProtocolObject({
  type: z.literal(NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE),
  cause: z
    .string()
    .min(1)
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= NODE_WORKER_CONNECTION_FAILURE_CAUSE_MAX_BYTES,
    )
    .nullable(),
});

export type NodeWorkerLaunchInput = z.infer<typeof LaunchInput>;
export type NodeWorkerSupervisorIdentity = z.infer<typeof Identity>;
export type NodeWorkerEnvironmentStopInput = z.infer<typeof EnvironmentStop>;
export type NodeWorkerSupervisorReceipt = z.infer<typeof Receipt>;
export type NodeWorkerConnectionFailureMessage = z.infer<typeof ConnectionFailure>;

function parseRequest<T>(schema: z.ZodType<T>, value: unknown, operation: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      issue?.path.length
        ? issue.message
        : `INVALID_REQUEST: invalid node worker ${operation} request`,
    );
  }
  return parsed.data;
}

function decodeRequest(raw?: string | null): unknown {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("INVALID_REQUEST: paramsJSON malformed JSON");
  }
}

function assertNodeWorkerLaunchIdentity(
  input: Pick<NodeWorkerLaunchInput, "launchId" | "expectedBundleHash">,
  descriptor: WorkerLaunchPlan,
): void {
  if (descriptor.assignment.turnId !== input.launchId) {
    throw new Error("INVALID_REQUEST: launchId must match descriptor assignment turnId");
  }
  if (descriptor.admission.handshake.bundleHash !== input.expectedBundleHash) {
    throw new Error("INVALID_REQUEST: descriptor bundle hash does not match expectedBundleHash");
  }
}

export function parseNodeWorkerLaunchInput(raw?: string | null): NodeWorkerLaunchInput {
  return validateNodeWorkerLaunchInput(decodeRequest(raw));
}

export function validateNodeWorkerLaunchInput(value: unknown): NodeWorkerLaunchInput {
  const input = parseRequest(LaunchInput, value, "launch");
  assertNodeWorkerLaunchIdentity(input, input.descriptor);
  if (input.sessionKey === undefined) {
    delete input.sessionKey;
  }
  return input;
}

export function parseNodeWorkerLookupInput(raw?: string | null): { launchId: string } {
  return parseRequest(Lookup, decodeRequest(raw), "lookup");
}

export function parseNodeWorkerCancelInput(raw?: string | null): NodeWorkerSupervisorIdentity {
  if (!raw || Buffer.byteLength(raw, "utf8") > NODE_WORKER_SUPERVISOR_CONTROL_REQUEST_MAX_BYTES) {
    throw new Error("INVALID_REQUEST: invalid node worker cancel request");
  }
  return parseRequest(Identity, decodeRequest(raw), "cancel");
}

export function parseNodeWorkerEnvironmentStopInput(
  raw?: string | null,
): NodeWorkerEnvironmentStopInput {
  if (!raw || Buffer.byteLength(raw, "utf8") > NODE_WORKER_SUPERVISOR_CONTROL_REQUEST_MAX_BYTES) {
    throw new Error("INVALID_REQUEST: invalid node worker environment stop request");
  }
  return parseRequest(EnvironmentStop, decodeRequest(raw), "environment stop");
}

export function nodeWorkerPlanHash(
  input: Pick<
    NodeWorkerLaunchInput,
    "descriptor" | "expectedBundleHash" | "gatewayNamespace" | "placementGeneration" | "sessionKey"
  >,
): string {
  return createHash("sha256")
    .update(
      stableStringify({
        expectedBundleHash: input.expectedBundleHash,
        descriptor: input.descriptor,
        gatewayNamespace: input.gatewayNamespace,
        placementGeneration: input.placementGeneration,
        ...(input.sessionKey === undefined ? {} : { sessionKey: input.sessionKey }),
      }),
    )
    .digest("hex");
}

function isBoundedResultJson(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > NODE_WORKER_RESULT_JSON_MAX_BYTES
  ) {
    return false;
  }
  try {
    return isRecord(JSON.parse(value) as unknown);
  } catch {
    return false;
  }
}

function isBoundedErrorText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= NODE_WORKER_ERROR_TEXT_MAX_BYTES &&
    !/[\r\n]/u.test(value)
  );
}

export function parseNodeWorkerConnectionFailureMessage(
  value: unknown,
): NodeWorkerConnectionFailureMessage | null {
  return ConnectionFailure.safeParse(value).data ?? null;
}

export function parseNodeWorkerSupervisorReceipt(
  value: unknown,
): NodeWorkerSupervisorReceipt | null {
  return Receipt.safeParse(value).data ?? null;
}
