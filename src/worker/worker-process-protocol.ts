import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH } from "../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import {
  parseWorkerLaunchDescriptor,
  type WorkerLaunchDescriptor,
  type WorkerLaunchPlan,
} from "./launch-descriptor.js";
import { hasExactOwnKeys, workerProtocolObject } from "./protocol-record.js";
import { WorkerAdmissionDeadlineResultSchema } from "./worker-connection-contract.js";
import { WORKER_CONNECTION_ENDPOINT_MAX_JSON_BYTES } from "./worker-connection-endpoint.js";
import {
  WorkerProcessObservationRequestSchema,
  WorkerProcessObservationResultSchema,
  type WorkerProcessObservationRequest,
} from "./worker-process-observation.js";

/** Private JSONL protocol between one node supervisor and its environment-owned worker. */
export type WorkerProcessInput =
  | { type: "turn"; turnId: string; descriptor: WorkerLaunchDescriptor; idleRetention?: true }
  | { type: "cancel"; turnId: string }
  | WorkerProcessObservationRequest;

export function buildWorkerProcessTurn<T extends WorkerLaunchPlan>(
  descriptor: T,
  idleRetention = false,
) {
  return {
    type: "turn" as const,
    turnId: descriptor.assignment.turnId,
    descriptor,
    ...(idleRetention ? { idleRetention: true as const } : {}),
  };
}

export function measureWorkerProcessTurnBytes(
  plan: WorkerLaunchPlan,
  idleRetention = false,
): number {
  // The node supplies the endpoint privately. Replace only its JSON null placeholder
  // with the parser-owned bound; the managed envelope is the sender's exact shape.
  return (
    Buffer.byteLength(
      JSON.stringify(buildWorkerProcessTurn({ ...plan, connectionEndpoint: null }, idleRetention)),
    ) -
    "null".length +
    WORKER_CONNECTION_ENDPOINT_MAX_JSON_BYTES
  );
}

export function serializeWorkerProcessInput(message: WorkerProcessInput): string {
  const json = JSON.stringify(message);
  if (Buffer.byteLength(json, "utf8") > WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) {
    throw new Error("managed worker request exceeds the protocol payload limit");
  }
  return `${json}\n`;
}

const TranscriptResultFields = {
  transcriptLeafId: z.string().nullable(),
  transcriptNextSeq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
};
const RuntimeResultSchema = z.union([
  WorkerAdmissionDeadlineResultSchema,
  workerProtocolObject({
    status: z.literal("fenced"),
    reason: z.enum(["credential-replaced", "owner-epoch-mismatch"]),
  }),
  workerProtocolObject({ status: z.literal("completed"), ...TranscriptResultFields }),
  workerProtocolObject({
    status: z.literal("failed"),
    reason: z.literal("turn-failed"),
    ...TranscriptResultFields,
  }),
]);
const TurnIdSchema = z
  .string()
  .refine(
    (value) => Boolean(value.trim()) && value.length <= WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  );
const ProcessResultSchema = workerProtocolObject({
  type: z.literal("result"),
  turnId: TurnIdSchema,
  result: RuntimeResultSchema,
  retainWorker: z.boolean(),
  retention: z.enum(["background", "idle"]).optional(),
}).refine(
  ({ result, retainWorker, retention }) =>
    (retention === undefined || retainWorker) &&
    (!retainWorker || result.status === "completed" || result.status === "failed"),
);
const ProcessMessageSchema = z.union([
  WorkerProcessObservationResultSchema,
  ProcessResultSchema,
  workerProtocolObject({
    type: z.literal("idle-ready"),
    turnId: TurnIdSchema,
  }),
]);

export type WorkerRuntimeResult = z.infer<typeof RuntimeResultSchema>;
export type WorkerProcessResult = z.infer<typeof ProcessResultSchema>;
export type WorkerProcessMessage = z.infer<typeof ProcessMessageSchema>;

export function parseWorkerProcessRequest(value: unknown): WorkerProcessInput {
  const observation = WorkerProcessObservationRequestSchema.safeParse(value);
  if (observation.success) {
    return observation.data;
  }
  if (
    !isRecord(value) ||
    typeof value.turnId !== "string" ||
    !value.turnId.trim() ||
    value.turnId.length > WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH
  ) {
    throw new Error("invalid managed worker request");
  }
  if (value.type === "cancel" && hasExactOwnKeys(value, ["type", "turnId"])) {
    return { type: "cancel", turnId: value.turnId };
  }
  if (
    value.type === "turn" &&
    hasExactOwnKeys(value, ["type", "turnId", "descriptor"], ["idleRetention"]) &&
    (value.idleRetention === undefined || value.idleRetention === true)
  ) {
    const descriptor = parseWorkerLaunchDescriptor(value.descriptor);
    if (descriptor.assignment.turnId !== value.turnId) {
      throw new Error("managed worker request disagrees with its assigned turn");
    }
    return buildWorkerProcessTurn(descriptor, value.idleRetention === true);
  }
  throw new Error("invalid managed worker request");
}

export function parseWorkerRuntimeResult(value: unknown): WorkerRuntimeResult | null {
  return RuntimeResultSchema.safeParse(value).data ?? null;
}

export function parseWorkerProcessMessage(value: unknown): WorkerProcessMessage | null {
  return ProcessMessageSchema.safeParse(value).data ?? null;
}
