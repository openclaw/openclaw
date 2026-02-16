import { Type, type Static } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const MeshPlanStepSchema = Type.Object(
  {
    id: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    prompt: NonEmptyString,
    dependsOn: Type.Optional(Type.Array(NonEmptyString, { maxItems: 64 })),
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    thinking: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 3_600_000 })),
  },
  { additionalProperties: false },
);

export const MeshWorkflowPlanSchema = Type.Object(
  {
    planId: NonEmptyString,
    goal: NonEmptyString,
    createdAt: Type.Integer({ minimum: 0 }),
    steps: Type.Array(MeshPlanStepSchema, { minItems: 1, maxItems: 128 }),
  },
  { additionalProperties: false },
);

export const MeshPlanParamsSchema = Type.Object(
  {
    goal: NonEmptyString,
    steps: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.Optional(NonEmptyString),
            name: Type.Optional(NonEmptyString),
            prompt: NonEmptyString,
            dependsOn: Type.Optional(Type.Array(NonEmptyString, { maxItems: 64 })),
            agentId: Type.Optional(NonEmptyString),
            sessionKey: Type.Optional(NonEmptyString),
            thinking: Type.Optional(Type.String()),
            timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 3_600_000 })),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 128 },
      ),
    ),
  },
  { additionalProperties: false },
);

export const MeshRunParamsSchema = Type.Object(
  {
    plan: MeshWorkflowPlanSchema,
    continueOnError: Type.Optional(Type.Boolean()),
    maxParallel: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
    defaultStepTimeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 3_600_000 })),
    lane: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const MeshPlanAutoParamsSchema = Type.Object(
  {
    goal: NonEmptyString,
    maxSteps: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    thinking: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 3_600_000 })),
    lane: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const MeshStatusParamsSchema = Type.Object(
  {
    runId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const MeshRetryParamsSchema = Type.Object(
  {
    runId: NonEmptyString,
    stepIds: Type.Optional(Type.Array(NonEmptyString, { minItems: 1, maxItems: 128 })),
  },
  { additionalProperties: false },
);

export type MeshPlanParams = Static<typeof MeshPlanParamsSchema>;
export type MeshWorkflowPlan = Static<typeof MeshWorkflowPlanSchema>;
export type MeshRunParams = Static<typeof MeshRunParamsSchema>;
export type MeshPlanAutoParams = Static<typeof MeshPlanAutoParamsSchema>;
export type MeshStatusParams = Static<typeof MeshStatusParamsSchema>;
export type MeshRetryParams = Static<typeof MeshRetryParamsSchema>;
