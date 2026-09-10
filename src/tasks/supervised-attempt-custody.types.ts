import { z } from "zod";

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uuid = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const AttemptProcessSchema = z.strictObject({
  pid: z.number().int().positive(),
  startTime: timestamp,
});
export const AttemptLimitsSchema = z.strictObject({
  memoryBytes: z.number().int().positive(),
  tasks: z.number().int().positive(),
});
export const AttemptStorageLimitsSchema = z.strictObject({
  workingBytes: z
    .number()
    .int()
    .min(4096)
    .max(512 * 1024 * 1024),
  workingInodes: z.number().int().min(16).max(100_000),
});
export const AttemptPlanSchema = z.strictObject({
  resourceId: uuid,
  allocationId: uuid,
  storage: AttemptStorageLimitsSchema,
  flowId: z.string().min(1).max(128),
  episode: z.number().int().positive(),
  attemptId: uuid,
  attemptOwnerId: z.string().min(1).max(128),
  startedAt: timestamp,
  expiresAt: timestamp,
  launcher: AttemptProcessSchema,
  hostId: hash,
  bootId: uuid,
  limits: AttemptLimitsSchema,
  workspace: z
    .strictObject({
      contractHash: hash,
      sourceVersion: uuid,
      sourceHash: hash,
    })
    .nullable(),
});
export type SupervisedAttemptPlan = z.infer<typeof AttemptPlanSchema>;
export const AttemptScopeIdentitySchema = z.strictObject({
  resourceId: uuid,
  scopeName: z.string().min(1).max(128),
  invocationId: z.string().regex(/^[a-f0-9]{32}$/),
  controlGroup: z.string().min(1).max(4096),
  hostId: hash,
  bootId: uuid,
  custodian: AttemptProcessSchema,
  cgroupDevice: z.string().regex(/^\d+$/),
  cgroupInode: z.string().regex(/^[1-9]\d*$/),
  limits: AttemptLimitsSchema,
});
export type SupervisedAttemptScopeIdentity = z.infer<typeof AttemptScopeIdentitySchema>;
export const AttemptCleanupSchema = z.strictObject({
  nonce: uuid,
  supervisorId: z.string().min(1).max(128),
  process: AttemptProcessSchema,
  hostId: hash,
  bootId: uuid,
});
export type SupervisedAttemptCleanup = z.infer<typeof AttemptCleanupSchema>;
