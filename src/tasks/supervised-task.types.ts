import { z } from "zod";

const text = z.string().trim().min(1).max(4096);
const id = z.string().min(1).max(128);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const SupervisedGoalSchema = z
  .strictObject({
    objective: text,
    success: z
      .array(z.strictObject({ id, description: text }))
      .min(1)
      .max(32),
    partial: z.array(id).max(32).default([]),
  })
  .superRefine((goal, ctx) => {
    const ids = new Set(goal.success.map((criterion) => criterion.id));
    if (
      ids.size !== goal.success.length ||
      new Set(goal.partial).size !== goal.partial.length ||
      goal.partial.some((value) => !ids.has(value))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Goal criteria must be unique; partial criteria must name success criteria",
      });
    }
  });
export type SupervisedGoal = z.infer<typeof SupervisedGoalSchema>;

const EvidenceSchema = z.strictObject({ criterionId: id, observation: text });
export const SupervisedDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("define_goal"), goal: SupervisedGoalSchema }),
  z.strictObject({ kind: z.literal("continue"), next: text }),
  z.strictObject({ kind: z.literal("wait"), next: text, wakeAt: timestamp }),
  z.strictObject({ kind: z.literal("input_required"), reason: text, question: text }),
  z.strictObject({ kind: z.literal("failed"), reason: text }),
  z.strictObject({
    kind: z.literal("succeeded"),
    summary: text,
    evidence: z.array(EvidenceSchema).min(1).max(32),
  }),
  z.strictObject({
    kind: z.literal("partial"),
    summary: text,
    evidence: z.array(EvidenceSchema).min(1).max(32),
  }),
]);
export type SupervisedDecision = z.infer<typeof SupervisedDecisionSchema>;

export const SupervisedPolicySchema = z.strictObject({
  deadlineAt: timestamp,
  maxAttempts: z.number().int().min(1).max(100),
  attemptTimeoutMs: z.number().int().min(1000).max(3_600_000),
});

const SupervisedTaskSchema = z.strictObject({
  version: z.literal(1),
  flowId: id,
  episode: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  agentId: id,
  model: id,
  runtime: z.enum(["codex", "claude-cli"]),
  prompt: text,
  goal: SupervisedGoalSchema.nullable(),
  goalSource: z.enum(["operator", "model"]).nullable(),
  policy: SupervisedPolicySchema,
  phase: z.enum([
    "ready",
    "waiting",
    "running",
    "succeeded",
    "partial",
    "input_required",
    "failed",
    "cancelled",
  ]),
  next: text,
  dueAt: timestamp,
  attempts: z.number().int().nonnegative(),
  lastAttemptId: id.nullable(),
  attempt: z
    .strictObject({
      id,
      ownerId: id,
      startedAt: timestamp,
      expiresAt: timestamp,
      dispatched: z.boolean(),
    })
    .nullable(),
  endpoint: z
    .strictObject({
      kind: z.enum(["succeeded", "partial", "input_required", "failed", "cancelled"]),
      reason: text,
      question: text.optional(),
      evidence: z.array(EvidenceSchema).max(32),
      acceptedBy: z.enum(["model", "operator", "supervisor"]),
      effects: z.enum(["attempt_completed", "unknown", "not_dispatched"]),
      at: timestamp,
    })
    .nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type SupervisedTask = z.infer<typeof SupervisedTaskSchema>;
export type SupervisedPolicy = z.infer<typeof SupervisedPolicySchema>;

export function validateSupervisedTask(value: unknown): SupervisedTask {
  const task = SupervisedTaskSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(task)) > 64 * 1024) {
    throw new Error("Supervised task record exceeds 64 KiB");
  }
  if ((task.phase === "running") !== (task.attempt !== null)) {
    throw new Error("Running supervision requires an exact attempt owner");
  }
  const active = ["ready", "waiting", "running"].includes(task.phase);
  if (active === (task.endpoint !== null) || (task.endpoint && task.endpoint.kind !== task.phase)) {
    throw new Error("Supervised endpoint does not match episode phase");
  }
  if (
    (task.goal === null) !== (task.goalSource === null) ||
    task.attempts > task.policy.maxAttempts
  ) {
    throw new Error("Supervised goal provenance or attempt budget is invalid");
  }
  if (
    task.attempt &&
    (task.attempt.startedAt >= task.attempt.expiresAt ||
      task.attempt.expiresAt > task.policy.deadlineAt)
  ) {
    throw new Error("Supervised attempt exceeds its bounded deadline");
  }
  return task;
}
