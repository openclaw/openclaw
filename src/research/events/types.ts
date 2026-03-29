import { z } from "zod";

export const RewardSignalKindSchema = z.enum(["binary", "directional", "combined"]);

export const RewardSignalSchema = z
  .object({
    kind: RewardSignalKindSchema,
    source: z.enum(["user_explicit", "user_implicit", "env_outcome", "approval_decision"]),
    confidence: z.number().min(0).max(1),
    scalar: z.number().min(-1).max(1).optional(),
    hintText: z.string().optional(),
  })
  .strict();

export type RewardSignal = z.infer<typeof RewardSignalSchema>;
export type RewardSignalKind = z.infer<typeof RewardSignalKindSchema>;

const ResearchEventBaseSchema = z
  .object({
    v: z.literal(1),
    ts: z.number().int().nonnegative(),
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    sessionKey: z.string().min(1).optional(),
    agentId: z.string().min(1),
    kind: z.string().min(1),
    /** Tagged by the learning-bridge reward classifier (not written to JSONL in v1 unless explicitly emitted). */
    reward: RewardSignalSchema.optional(),
    /** Reserved for PR10B+ hive flows; must remain unset in PR10A. */
    hiveEligible: z.boolean().optional(),
    /** Reserved for PR10B+ hive flows; must remain unset in PR10A. */
    hiveContributionId: z.string().optional(),
  })
  .strict();

const RunStartEventSchema = ResearchEventBaseSchema.extend({
  kind: z.literal("run.start"),
  payload: z
    .object({
      provider: z.string().optional(),
      model: z.string().optional(),
      trigger: z.string().optional(),
    })
    .strict(),
});

const RunEndEventSchema = ResearchEventBaseSchema.extend({
  kind: z.literal("run.end"),
  payload: z
    .object({
      durationMs: z.number().int().nonnegative().optional(),
      aborted: z.boolean().optional(),
      timedOut: z.boolean().optional(),
      usage: z
        .object({
          input: z.number().int().nonnegative().optional(),
          output: z.number().int().nonnegative().optional(),
          total: z.number().int().nonnegative().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
});

const LlmRequestEventSchema = ResearchEventBaseSchema.extend({
  kind: z.literal("llm.request"),
  payload: z
    .object({
      provider: z.string().optional(),
      model: z.string().optional(),
      promptChars: z.number().int().nonnegative().optional(),
      /** When enabled, carries scrubbed prompt text suitable for tokenization/export. */
      promptScrubbed: z.string().optional(),
      imageCount: z.number().int().nonnegative().optional(),
    })
    .strict(),
});

const LlmResponseEventSchema = ResearchEventBaseSchema.extend({
  kind: z.literal("llm.response"),
  payload: z
    .object({
      provider: z.string().optional(),
      model: z.string().optional(),
      stopReason: z.string().optional(),
      /** When enabled, carries scrubbed response text suitable for tokenization/export. */
      responseScrubbed: z.string().optional(),
      usage: z
        .object({
          input: z.number().int().nonnegative().optional(),
          output: z.number().int().nonnegative().optional(),
          total: z.number().int().nonnegative().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
});

const ToolStartEventSchema = ResearchEventBaseSchema.extend({
  kind: z.literal("tool.start"),
  payload: z
    .object({
      toolName: z.string().min(1),
      toolCallId: z.string().min(1),
      argsSummary: z.string().optional(),
      argsHash: z.string().optional(),
    })
    .strict(),
});

const ToolEndEventSchema = ResearchEventBaseSchema.extend({
  kind: z.literal("tool.end"),
  payload: z
    .object({
      toolName: z.string().min(1),
      toolCallId: z.string().min(1),
      ok: z.boolean(),
      resultSummary: z.string().optional(),
      resultHash: z.string().optional(),
    })
    .strict(),
});

const ApprovalRequestEventSchema = ResearchEventBaseSchema.extend({
  kind: z.literal("approval.request"),
  payload: z
    .object({
      approvalId: z.string().min(1),
      /** Echo of the agent invocation `runId` when known (distinct from `approvalId`). */
      agentRunId: z.string().min(1).optional(),
      host: z.union([z.literal("gateway"), z.literal("node")]).optional(),
      commandSummary: z.string().optional(),
    })
    .strict(),
});

const ApprovalAllowEventSchema = ResearchEventBaseSchema.extend({
  kind: z.literal("approval.allow"),
  payload: z
    .object({
      approvalId: z.string().min(1),
      agentRunId: z.string().min(1).optional(),
      decision: z.string().optional(),
    })
    .strict(),
});

const ApprovalDenyEventSchema = ResearchEventBaseSchema.extend({
  kind: z.literal("approval.deny"),
  payload: z
    .object({
      approvalId: z.string().min(1),
      agentRunId: z.string().min(1).optional(),
      decision: z.string().optional(),
      reason: z.string().optional(),
    })
    .strict(),
});

export const ResearchEventV1Schema = z.discriminatedUnion("kind", [
  RunStartEventSchema,
  RunEndEventSchema,
  LlmRequestEventSchema,
  LlmResponseEventSchema,
  ToolStartEventSchema,
  ToolEndEventSchema,
  ApprovalRequestEventSchema,
  ApprovalAllowEventSchema,
  ApprovalDenyEventSchema,
]);

export type ResearchEventV1 = z.infer<typeof ResearchEventV1Schema>;
