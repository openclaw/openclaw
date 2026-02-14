/**
 * Contract enforcement schemas for OpenClaw internal message types.
 *
 * These Zod schemas enforce strict validation on the core message types
 * that flow through the dispatcher pipeline. Any malformed message is
 * rejected deterministically rather than silently degrading.
 *
 * Type Mapping (conceptual → codebase):
 *   PlanRequest     → inbound request to the dispatcher for routing/planning
 *   PlanArtifact    → dispatcher's routing decision (model, provider, session)
 *   TaskEnvelope    → wrapper around a task dispatched to an executor
 *   Result          → execution result returned from an executor
 *   EscalationSignal → signal from executor requesting dispatcher intervention
 *
 * @module contracts/schemas
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// A1: PlanRequest — inbound request for the dispatcher to route
// ---------------------------------------------------------------------------

export const PlanRequestSchema = z
  .object({
    /** Unique request identifier (trace root). */
    requestId: z.string().min(1),
    /** Session identifier for context continuity. */
    sessionId: z.string().min(1),
    /** Session key (agent:channel:scope). */
    sessionKey: z.string().min(1),
    /** Originating channel (telegram, discord, slack, webchat, etc.). */
    channel: z.string().min(1),
    /** Inbound message body. */
    body: z.string(),
    /** Unix timestamp (ms) of the inbound message. */
    timestamp: z.number().int().positive(),
    /** Sender identifier. */
    sender: z.string().optional(),
    /** Chat type context. */
    chatType: z.enum(["direct", "group", "thread"]).optional(),
    /** Attached media URLs. */
    mediaUrls: z.array(z.string().url()).optional(),
    /** Whether this is a heartbeat-triggered request. */
    isHeartbeat: z.boolean().optional(),
    /** Caller identity — MUST be "dispatcher". Enforces A6. */
    callerRole: z.literal("dispatcher"),
  })
  .strict();

export type PlanRequest = z.infer<typeof PlanRequestSchema>;

// ---------------------------------------------------------------------------
// A2: PlanArtifact — the dispatcher's routing decision
// ---------------------------------------------------------------------------

export const PlanArtifactSchema = z
  .object({
    /** References the originating PlanRequest. */
    requestId: z.string().min(1),
    /** Selected provider for execution. */
    provider: z.string().min(1),
    /** Selected model for execution. */
    model: z.string().min(1),
    /** Thinking/reasoning level. */
    thinkLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
    /** Target session for the task. */
    sessionId: z.string().min(1),
    /** Session key for routing. */
    sessionKey: z.string().min(1),
    /** Agent identifier. */
    agentId: z.string().optional(),
    /** Whether to use a subagent. */
    useSubagent: z.boolean().optional(),
    /** Subagent label if spawning one. */
    subagentLabel: z.string().optional(),
    /** Context token budget. */
    contextBudget: z.number().int().positive().optional(),
    /** Output token budget. */
    outputBudget: z.number().int().positive().optional(),
    /** Skills to load for this session. */
    skillFilter: z.array(z.string()).optional(),
    /** Who produced this artifact — MUST be "dispatcher". Enforces A7. */
    producedBy: z.literal("dispatcher"),
    /** Timestamp of the routing decision. */
    decidedAt: z.number().int().positive(),
  })
  .strict();

export type PlanArtifact = z.infer<typeof PlanArtifactSchema>;

// ---------------------------------------------------------------------------
// A3: TaskEnvelope — wrapper for a dispatched task
// ---------------------------------------------------------------------------

export const TaskEnvelopeSchema = z
  .object({
    /** Trace id linking back to the original request. */
    requestId: z.string().min(1),
    /** Unique task identifier. */
    taskId: z.string().min(1),
    /** The plan artifact that produced this task. */
    planArtifact: PlanArtifactSchema,
    /** The prompt/message to execute. */
    prompt: z.string(),
    /** System prompt override, if any. */
    systemPromptOverride: z.string().optional(),
    /** Execution lane (nested, subagent, etc.). */
    lane: z.string().optional(),
    /** Abort signal identifier for cancellation. */
    abortSignalId: z.string().optional(),
    /** Maximum execution time (ms). */
    timeoutMs: z.number().int().positive().optional(),
    /** Who dispatched this task — MUST be "dispatcher". Enforces A6. */
    dispatchedBy: z.literal("dispatcher"),
    /** Dispatch timestamp. */
    dispatchedAt: z.number().int().positive(),
  })
  .strict();

export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;

// ---------------------------------------------------------------------------
// A4: Result — execution result from an executor
// ---------------------------------------------------------------------------

export const ResultSchema = z
  .object({
    /** References the task that produced this result. */
    taskId: z.string().min(1),
    /** References the original request. */
    requestId: z.string().min(1),
    /** Whether execution succeeded. */
    ok: z.boolean(),
    /** Output payloads (text, media, etc.). */
    payloads: z
      .array(
        z.object({
          text: z.string().optional(),
          mediaUrl: z.string().optional(),
          mediaUrls: z.array(z.string()).optional(),
          replyToId: z.string().optional(),
          isError: z.boolean().optional(),
        }),
      )
      .optional(),
    /** Error information if !ok. */
    error: z
      .object({
        kind: z.enum([
          "schema_violation",
          "model_failure",
          "tool_failure",
          "resource_exhaustion",
          "invariant_violation",
          "context_overflow",
          "compaction_failure",
          "timeout",
          "abort",
          "unknown",
        ]),
        message: z.string(),
        retryable: z.boolean().optional(),
      })
      .optional(),
    /** Execution metadata. */
    meta: z
      .object({
        provider: z.string().optional(),
        model: z.string().optional(),
        durationMs: z.number().int().nonnegative().optional(),
        usage: z
          .object({
            input: z.number().int().nonnegative().optional(),
            output: z.number().int().nonnegative().optional(),
            cacheRead: z.number().int().nonnegative().optional(),
            total: z.number().int().nonnegative().optional(),
          })
          .optional(),
        stopReason: z.string().optional(),
      })
      .optional(),
    /** Who produced this result. */
    producedBy: z.enum(["executor", "dispatcher"]),
    /** Completion timestamp. */
    completedAt: z.number().int().positive(),
  })
  .strict();

export type Result = z.infer<typeof ResultSchema>;

// ---------------------------------------------------------------------------
// A5: EscalationSignal — request for dispatcher intervention
// ---------------------------------------------------------------------------

export const EscalationSignalSchema = z
  .object({
    /** References the task that triggered escalation. */
    taskId: z.string().min(1),
    /** References the original request. */
    requestId: z.string().min(1),
    /** Reason for escalation. */
    reason: z.enum([
      "repeated_failure",
      "context_overflow",
      "model_refusal",
      "budget_exceeded",
      "invariant_violation",
      "tool_unavailable",
      "user_requested",
    ]),
    /** Human-readable description. */
    description: z.string().min(1),
    /** The failing result, if any. */
    failedResult: ResultSchema.optional(),
    /** Suggested action. */
    suggestedAction: z
      .enum(["retry_different_model", "retry_with_compaction", "abort", "ask_user", "fallback"])
      .optional(),
    /** Retry count so far. */
    retryCount: z.number().int().nonnegative().optional(),
    /** Who raised this escalation — MUST be "dispatcher". Enforces A8. */
    escalatedBy: z.literal("dispatcher"),
    /** Escalation timestamp. */
    escalatedAt: z.number().int().positive(),
  })
  .strict();

export type EscalationSignal = z.infer<typeof EscalationSignalSchema>;

// ---------------------------------------------------------------------------
// Memory write contract — enforces A9
// ---------------------------------------------------------------------------

export const MemoryWriteSchema = z
  .object({
    /** Session context. */
    sessionId: z.string().min(1),
    /** What to write. */
    content: z.string().min(1),
    /** Target file/path. */
    target: z.string().min(1),
    /** Write mode. */
    mode: z.enum(["append", "overwrite", "merge"]).optional(),
    /** Who initiated this write — MUST be "dispatcher". Enforces A9. */
    writtenBy: z.literal("dispatcher"),
    /** Write timestamp. */
    writtenAt: z.number().int().positive(),
  })
  .strict();

export type MemoryWrite = z.infer<typeof MemoryWriteSchema>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function validatePlanRequest(data: unknown): PlanRequest {
  return PlanRequestSchema.parse(data);
}

export function validatePlanArtifact(data: unknown): PlanArtifact {
  return PlanArtifactSchema.parse(data);
}

export function validateTaskEnvelope(data: unknown): TaskEnvelope {
  return TaskEnvelopeSchema.parse(data);
}

export function validateResult(data: unknown): Result {
  return ResultSchema.parse(data);
}

export function validateEscalationSignal(data: unknown): EscalationSignal {
  return EscalationSignalSchema.parse(data);
}

export function validateMemoryWrite(data: unknown): MemoryWrite {
  return MemoryWriteSchema.parse(data);
}

/**
 * Safe validation (returns result instead of throwing).
 */
export function safeParsePlanRequest(data: unknown) {
  return PlanRequestSchema.safeParse(data);
}

export function safeParsePlanArtifact(data: unknown) {
  return PlanArtifactSchema.safeParse(data);
}

export function safeParseTaskEnvelope(data: unknown) {
  return TaskEnvelopeSchema.safeParse(data);
}

export function safeParseResult(data: unknown) {
  return ResultSchema.safeParse(data);
}

export function safeParseEscalationSignal(data: unknown) {
  return EscalationSignalSchema.safeParse(data);
}

export function safeParseMemoryWrite(data: unknown) {
  return MemoryWriteSchema.safeParse(data);
}
