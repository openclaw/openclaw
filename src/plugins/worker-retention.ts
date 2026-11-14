import { z } from "zod";
import type {
  WorkerEnvironmentRetention,
  WorkerRetentionObservation,
  WorkerRetentionPolicy,
} from "./worker-retention.types.js";

const identity = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[!-~]+$/u);
const workerRetentionPolicySchema = z.strictObject({
  version: z.literal(1),
  ownerBinding: identity,
  computeWindowSeconds: z
    .number()
    .int()
    .positive()
    .max(Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
});
export const workerWorkspaceDurabilitySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("mirrored") }),
  z.strictObject({
    mode: z.literal("retained-disk"),
    computeWindowSeconds: workerRetentionPolicySchema.shape.computeWindowSeconds,
  }),
]);
const workerRetentionOperationSchema = z.strictObject({
  id: identity,
  action: z.enum(["pause", "resume"]),
  expectedClaimRevision: identity,
});
const workerRetentionObservationSchema = z.strictObject({
  claimRevision: identity,
  state: z.enum(["running", "suspended", "transitioning", "expired", "unavailable"]),
  computeExpiresAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  operation: workerRetentionOperationSchema
    .extend({ phase: z.enum(["pending", "observed"]) })
    .optional(),
});
const environmentRetentionSchema = z.strictObject({
  policy: workerRetentionPolicySchema,
  runtimeReady: z.boolean(),
  operation: workerRetentionOperationSchema.nullable(),
  observation: workerRetentionObservationSchema.nullable(),
});
export function requireWorkerEnvironmentRetention(value: unknown): WorkerEnvironmentRetention {
  return environmentRetentionSchema.parse(value);
}
export function requireWorkerRetentionPolicy(value: unknown): WorkerRetentionPolicy {
  return workerRetentionPolicySchema.parse(value);
}
export function requireWorkerRetentionObservation(value: unknown): WorkerRetentionObservation {
  return workerRetentionObservationSchema.parse(value);
}
