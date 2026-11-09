// Frozen published worker-response parser from v2026.9.4, commit 3a9d69db306cd7f081e06254cb89c4bcc14a7107.
// src/infra/update-repair-protocol.ts, blob 32a2e9e3a086b767cef11bfb199b959082619078.
// Keep this upgrade reader independent of the candidate protocol.
import { z } from "zod";

const updateRepairValidationSchema = z.object({
  ok: z.boolean(),
  score: z.number().finite(),
  summary: z.string(),
  stopReason: z.string().max(1024).optional(),
});
const text = z.string().max(1024);
const wireValidation = updateRepairValidationSchema.extend({ summary: text });
const status = z.enum(["repaired", "improved", "unrepaired", "unavailable", "aborted"]);
const turn = z.number().int().positive();
const attempt = z.object({
  turn,
  model: text,
  provider: text,
  durationMs: z.number().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  validation: wireValidation,
  summary: text,
});
const event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("route-selected"), model: text, provider: text }),
  z.object({ type: z.literal("turn-started"), turn, model: text, provider: text }),
  attempt.extend({ type: z.literal("turn-finished") }),
  z.object({
    type: z.literal("validation"),
    turn: z.number().int().nonnegative(),
    validation: wireValidation,
  }),
  z.object({ type: z.literal("stopped"), status, reason: text.optional() }),
]);
export const updateRepairWorkerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("validate"), id: turn }),
  z.object({ type: z.literal("cancel-validation"), id: turn }),
  z.object({ type: z.literal("event"), event }),
  z.object({
    type: z.literal("result"),
    result: z.object({
      status,
      attempts: z.array(attempt),
      finalValidation: wireValidation,
      reason: text.optional(),
    }),
  }),
]);
