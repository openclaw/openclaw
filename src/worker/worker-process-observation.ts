import { Value } from "typebox/value";
import { z } from "zod";
import {
  SessionsProcessesListResultSchema,
  SessionsProcessesStopResultSchema,
  type SessionsProcessesListResult,
  type SessionsProcessesStopResult,
} from "../../packages/gateway-protocol/src/schema/session-processes.js";
import {
  WorkerGatewayNamespace,
  workerProtocolIdentifier,
  workerProtocolObject,
} from "./protocol-record.js";

const identifier = workerProtocolIdentifier;
const binding = {
  environmentId: identifier("environmentId"),
  sessionId: identifier("sessionId"),
  ownerEpoch: z.number().int().nonnegative(),
};
const operation = z.union([
  workerProtocolObject({ action: z.literal("list") }),
  workerProtocolObject({
    action: z.literal("stop"),
    processId: identifier("processId"),
    instanceId: identifier("instanceId"),
  }),
]);
export type WorkerProcessOperation = z.infer<typeof operation>;
const nodeRequest = workerProtocolObject({
  ...binding,
  gatewayNamespace: WorkerGatewayNamespace,
  placementGeneration: z.number().int().nonnegative(),
  expectedBundleHash: z.string().regex(/^[a-f0-9]{64}$/u),
  operation,
});
export type NodeWorkerProcessInput = z.infer<typeof nodeRequest>;
export function parseNodeWorkerProcessInput(raw?: string | null): NodeWorkerProcessInput {
  if (!raw || Buffer.byteLength(raw, "utf8") > 4096) {
    throw new Error("INVALID_REQUEST: invalid worker process request");
  }
  return nodeRequest.parse(JSON.parse(raw));
}
export const WorkerProcessObservationRequestSchema = workerProtocolObject({
  type: z.literal("process"),
  requestId: identifier("requestId"),
  ...binding,
  operation,
});
export type WorkerProcessObservationRequest = z.infer<typeof WorkerProcessObservationRequestSchema>;
export const WorkerProcessObservationResultSchema = workerProtocolObject({
  type: z.literal("process-result"),
  requestId: identifier("requestId"),
  result: z
    .union([
      z.custom<SessionsProcessesListResult>((value) =>
        Value.Check(SessionsProcessesListResultSchema, value),
      ),
      z.custom<SessionsProcessesStopResult>((value) =>
        Value.Check(SessionsProcessesStopResultSchema, value),
      ),
    ])
    .optional(),
  error: z.string().max(512).optional(),
}).refine((value) => (value.result !== undefined) !== (value.error !== undefined));
export type WorkerProcessObservationResult = z.infer<typeof WorkerProcessObservationResultSchema>;
