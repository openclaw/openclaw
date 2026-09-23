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

/** Private JSONL protocol between one node supervisor and its environment-owned worker. */
export type WorkerProcessInput =
  | { type: "turn"; turnId: string; descriptor: WorkerLaunchDescriptor }
  | { type: "cancel"; turnId: string };

export function buildWorkerProcessTurn<T extends WorkerLaunchPlan>(descriptor: T) {
  return { type: "turn" as const, turnId: descriptor.assignment.turnId, descriptor };
}

export function measureWorkerProcessTurnBytes(plan: WorkerLaunchPlan): number {
  // The node supplies the endpoint privately. Replace only its JSON null placeholder
  // with the parser-owned bound; the managed envelope is the sender's exact shape.
  return (
    Buffer.byteLength(
      JSON.stringify(buildWorkerProcessTurn({ ...plan, connectionEndpoint: null })),
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
const ProcessResultSchema = workerProtocolObject({
  type: z.literal("result"),
  turnId: z
    .string()
    .refine(
      (value) => Boolean(value.trim()) && value.length <= WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
    ),
  result: RuntimeResultSchema,
  retainWorker: z.boolean(),
}).refine(
  ({ result, retainWorker }) =>
    !retainWorker || result.status === "completed" || result.status === "failed",
);

export type WorkerRuntimeResult = z.infer<typeof RuntimeResultSchema>;
export type WorkerProcessResult = z.infer<typeof ProcessResultSchema>;

export function parseWorkerProcessRequest(value: unknown): WorkerProcessInput {
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
  if (value.type === "turn" && hasExactOwnKeys(value, ["type", "turnId", "descriptor"])) {
    const descriptor = parseWorkerLaunchDescriptor(value.descriptor);
    if (descriptor.assignment.turnId !== value.turnId) {
      throw new Error("managed worker request disagrees with its assigned turn");
    }
    return { type: "turn", turnId: value.turnId, descriptor };
  }
  throw new Error("invalid managed worker request");
}

export function parseWorkerRuntimeResult(value: unknown): WorkerRuntimeResult | null {
  const parsed = RuntimeResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseWorkerProcessResult(value: unknown): WorkerProcessResult | null {
  const parsed = ProcessResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
