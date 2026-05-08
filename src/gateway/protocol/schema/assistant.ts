import { Type } from "typebox";

const SafeRecordSchema = Type.Record(Type.String(), Type.Unknown());

export const AssistantStatusParamsSchema = Type.Object({}, { additionalProperties: false });
export const AssistantDecisionsListParamsSchema = Type.Object({}, { additionalProperties: false });
export const AssistantContinueCandidatesParamsSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const AssistantContinueCandidateSchema = Type.Object(
  {
    taskId: Type.String(),
    title: Type.String(),
    workspace: Type.String(),
    source: Type.String(),
    status: Type.String(),
    risk: Type.String(),
    owner: Type.String(),
    allowedActions: Type.Array(Type.String()),
    handoffState: Type.String(),
    updatedAt: Type.String(),
    reason: Type.String(),
    record: SafeRecordSchema,
  },
  { additionalProperties: false },
);

export const AssistantStatusResultSchema = Type.Object(
  {
    generatedAt: Type.String(),
    taskIndexUpdatedAt: Type.Optional(Type.String()),
    taskCount: Type.Number(),
    activeTaskCount: Type.Number(),
    pendingDecisionCount: Type.Number(),
    continueCandidateCount: Type.Number(),
    tasks: Type.Array(SafeRecordSchema),
    decisions: Type.Array(SafeRecordSchema),
    continueCandidates: Type.Array(AssistantContinueCandidateSchema),
    safeSources: Type.Array(Type.String()),
    excludedSources: Type.Array(Type.String()),
    loadErrors: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const AssistantDecisionsListResultSchema = Type.Object(
  {
    generatedAt: Type.String(),
    count: Type.Number(),
    decisions: Type.Array(SafeRecordSchema),
    safeSources: Type.Array(Type.String()),
    excludedSources: Type.Array(Type.String()),
    loadErrors: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const AssistantContinueCandidatesResultSchema = Type.Object(
  {
    generatedAt: Type.String(),
    count: Type.Number(),
    candidates: Type.Array(AssistantContinueCandidateSchema),
    policy: Type.Object(
      {
        allowed: Type.String(),
        hardBoundary: Type.String(),
      },
      { additionalProperties: false },
    ),
    safeSources: Type.Array(Type.String()),
    excludedSources: Type.Array(Type.String()),
    loadErrors: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
