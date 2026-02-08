/**
 * Zod schema for spool event validation.
 */

import { z } from "zod";

export const spoolPrioritySchema = z.enum(["low", "normal", "high", "critical"]);

export const spoolDeliverySchema = z
  .object({
    enabled: z.boolean().optional(),
    channel: z.string().optional(),
    to: z.string().optional(),
  })
  .strict();

export const spoolAgentTurnPayloadSchema = z
  .object({
    kind: z.literal("agentTurn"),
    message: z.string().min(1, "message is required"),
    agentId: z.string().optional(),
    sessionKey: z.string().optional(),
    model: z.string().optional(),
    thinking: z.string().optional(),
    delivery: spoolDeliverySchema.optional(),
  })
  .strict();

export const spoolPayloadSchema = spoolAgentTurnPayloadSchema;

export const spoolEventSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid("id must be a valid UUID"),
    createdAt: z.string().datetime("createdAt must be ISO 8601"),
    createdAtMs: z.number().int().positive(),
    priority: spoolPrioritySchema.optional(),
    maxRetries: z.number().int().min(0).optional(),
    retryCount: z.number().int().min(0).optional(),
    expiresAt: z.string().datetime().optional(),
    payload: spoolPayloadSchema,
  })
  .strict();

export const SPOOL_PRIORITY_VALUES = ["low", "normal", "high", "critical"] as const;

export const spoolEventCreateSchema = z
  .object({
    version: z.literal(1),
    priority: spoolPrioritySchema.optional(),
    maxRetries: z.number().int().min(0).optional(),
    expiresAt: z.string().datetime().optional(),
    payload: spoolPayloadSchema,
  })
  .strict();

// Generic validation helper - internal use
function validateWith<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
): { valid: true; data: T } | { valid: false; error: string } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { valid: true, data: result.data };
  }
  const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  return { valid: false, error: issues };
}

// Public validation API - preserves named return fields for compatibility
export function validateSpoolEventCreate(
  data: unknown,
):
  | { valid: true; create: z.infer<typeof spoolEventCreateSchema> }
  | { valid: false; error: string } {
  const r = validateWith(spoolEventCreateSchema, data);
  return r.valid ? { valid: true, create: r.data } : r;
}

export function validateSpoolEvent(
  data: unknown,
): { valid: true; event: z.infer<typeof spoolEventSchema> } | { valid: false; error: string } {
  const r = validateWith(spoolEventSchema, data);
  return r.valid ? { valid: true, event: r.data } : r;
}

export function validateSpoolPayload(
  data: unknown,
): { valid: true; payload: z.infer<typeof spoolPayloadSchema> } | { valid: false; error: string } {
  const r = validateWith(spoolPayloadSchema, data);
  return r.valid ? { valid: true, payload: r.data } : r;
}
