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

export type SpoolEventSchemaType = z.infer<typeof spoolEventSchema>;

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

export type SpoolEventCreateSchemaType = z.infer<typeof spoolEventCreateSchema>;

export function validateSpoolEventCreate(
  data: unknown,
): { valid: true; create: SpoolEventCreateSchemaType } | { valid: false; error: string } {
  const result = spoolEventCreateSchema.safeParse(data);
  if (result.success) {
    return { valid: true, create: result.data };
  }
  const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  return { valid: false, error: issues };
}

export function validateSpoolEvent(
  data: unknown,
): { valid: true; event: SpoolEventSchemaType } | { valid: false; error: string } {
  const result = spoolEventSchema.safeParse(data);
  if (result.success) {
    return { valid: true, event: result.data };
  }
  const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  return { valid: false, error: issues };
}

export type SpoolPayloadSchemaType = z.infer<typeof spoolPayloadSchema>;

export function validateSpoolPayload(
  data: unknown,
): { valid: true; payload: SpoolPayloadSchemaType } | { valid: false; error: string } {
  const result = spoolPayloadSchema.safeParse(data);
  if (result.success) {
    return { valid: true, payload: result.data };
  }
  const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  return { valid: false, error: issues };
}
