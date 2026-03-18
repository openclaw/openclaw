/**
 * TypeBox schemas for Goals RPC endpoints.
 */
import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

// ── Shared Models ────────────────────────────────────────────────────────

export const GoalSchema = Type.Object(
  {
    id: Type.String(),
    workspaceId: Type.String(),
    parentId: Type.Optional(Type.String()),
    title: Type.String(),
    description: Type.Optional(Type.String()),
    level: Type.Union([
      Type.Literal("vision"),
      Type.Literal("objective"),
      Type.Literal("key_result"),
    ]),
    status: Type.Union([
      Type.Literal("planned"),
      Type.Literal("in_progress"),
      Type.Literal("achieved"),
      Type.Literal("abandoned"),
    ]),
    ownerAgentId: Type.Optional(Type.String()),
    progress: Type.Number(),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
  },
  { $id: "Goal" },
);

// ── Params ──────────────────────────────────────────────────────────────

export const GoalsListParamsSchema = Type.Object({
  workspaceId: Type.Optional(Type.String()),
  status: Type.Optional(
    Type.Union([
      Type.Literal("planned"),
      Type.Literal("in_progress"),
      Type.Literal("achieved"),
      Type.Literal("abandoned"),
    ]),
  ),
  parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export const GoalsGetParamsSchema = Type.Object({
  id: Type.String(),
});

export const GoalsCreateParamsSchema = Type.Object({
  workspaceId: Type.String(),
  title: NonEmptyString,
  description: Type.Optional(Type.String()),
  parentId: Type.Optional(Type.String()),
  level: Type.Optional(
    Type.Union([Type.Literal("vision"), Type.Literal("objective"), Type.Literal("key_result")]),
  ),
  ownerAgentId: Type.Optional(Type.String()),
});

export const GoalsUpdateParamsSchema = Type.Object({
  id: Type.String(),
  title: Type.Optional(NonEmptyString),
  description: Type.Optional(Type.String()),
  status: Type.Optional(
    Type.Union([
      Type.Literal("planned"),
      Type.Literal("in_progress"),
      Type.Literal("achieved"),
      Type.Literal("abandoned"),
    ]),
  ),
  level: Type.Optional(
    Type.Union([Type.Literal("vision"), Type.Literal("objective"), Type.Literal("key_result")]),
  ),
  progress: Type.Optional(Type.Number()),
  ownerAgentId: Type.Optional(Type.String()),
  parentId: Type.Optional(Type.String()),
});

export const GoalsDeleteParamsSchema = Type.Object({
  id: Type.String(),
});

// ── Returns ──────────────────────────────────────────────────────────────

export const GoalsListReturnSchema = Type.Object({ goals: Type.Array(GoalSchema) });
export const GoalsGetReturnSchema = GoalSchema;
export const GoalsCreateReturnSchema = GoalSchema;
export const GoalsUpdateReturnSchema = GoalSchema;
export const GoalsDeleteReturnSchema = Type.Object({ success: Type.Boolean() });
