/**
 * TypeBox schemas for Budgets & Costs RPC endpoints.
 */
import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

// ── Shared Models ────────────────────────────────────────────────────────

export const BudgetPolicySchema = Type.Object(
  {
    id: Type.String(),
    workspaceId: Type.String(),
    scopeType: Type.Union([
      Type.Literal("workspace"),
      Type.Literal("agent"),
      Type.Literal("project"),
    ]),
    scopeId: Type.String(),
    amountMicrocents: Type.Number(),
    windowKind: Type.Union([Type.Literal("calendar_month_utc"), Type.Literal("lifetime")]),
    warnPercent: Type.Number(),
    hardStop: Type.Number(),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
  },
  { $id: "BudgetPolicy" },
);

export const BudgetIncidentSchema = Type.Object(
  {
    id: Type.String(),
    workspaceId: Type.String(),
    policyId: Type.String(),
    type: Type.Union([
      Type.Literal("warning"),
      Type.Literal("hard_stop"),
      Type.Literal("resolved"),
    ]),
    agentId: Type.Optional(Type.String()),
    spentMicrocents: Type.Number(),
    limitMicrocents: Type.Number(),
    message: Type.Optional(Type.String()),
    resolvedAt: Type.Optional(Type.Number()),
    createdAt: Type.Number(),
  },
  { $id: "BudgetIncident" },
);

export const CostEventSchema = Type.Object(
  {
    id: Type.String(),
    workspaceId: Type.String(),
    agentId: Type.String(),
    sessionId: Type.Optional(Type.String()),
    taskId: Type.Optional(Type.String()),
    projectId: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    inputTokens: Type.Number(),
    outputTokens: Type.Number(),
    costMicrocents: Type.Number(),
    occurredAt: Type.Number(),
  },
  { $id: "CostEvent" },
);

// ── Params ──────────────────────────────────────────────────────────────

export const BudgetPoliciesListParamsSchema = Type.Object({
  workspaceId: Type.String(),
  scopeType: Type.Optional(
    Type.Union([Type.Literal("workspace"), Type.Literal("agent"), Type.Literal("project")]),
  ),
  scopeId: Type.Optional(Type.String()),
});

export const BudgetPoliciesGetParamsSchema = Type.Object({
  id: Type.String(),
});

export const BudgetPoliciesCreateParamsSchema = Type.Object({
  workspaceId: Type.String(),
  scopeType: Type.Union([
    Type.Literal("workspace"),
    Type.Literal("agent"),
    Type.Literal("project"),
  ]),
  scopeId: NonEmptyString,
  amountMicrocents: Type.Number(),
  windowKind: Type.Optional(
    Type.Union([Type.Literal("calendar_month_utc"), Type.Literal("lifetime")]),
  ),
  warnPercent: Type.Optional(Type.Number()),
  hardStop: Type.Optional(Type.Number()),
});

export const BudgetPoliciesUpdateParamsSchema = Type.Object({
  id: Type.String(),
  amountMicrocents: Type.Optional(Type.Number()),
  warnPercent: Type.Optional(Type.Number()),
  hardStop: Type.Optional(Type.Number()),
});

export const BudgetPoliciesDeleteParamsSchema = Type.Object({
  id: Type.String(),
});

export const BudgetIncidentsListParamsSchema = Type.Object({
  workspaceId: Type.String(),
  policyId: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  type: Type.Optional(
    Type.Union([Type.Literal("warning"), Type.Literal("hard_stop"), Type.Literal("resolved")]),
  ),
});

export const BudgetIncidentsResolveParamsSchema = Type.Object({
  id: Type.String(),
});

export const CostEventsListParamsSchema = Type.Object({
  workspaceId: Type.String(),
  agentId: Type.Optional(Type.String()),
  projectId: Type.Optional(Type.String()),
  taskId: Type.Optional(Type.String()),
  sinceUtc: Type.Optional(Type.Number()),
  untilUtc: Type.Optional(Type.Number()),
});

// ── Returns ──────────────────────────────────────────────────────────────

export const BudgetPoliciesListReturnSchema = Type.Object({
  policies: Type.Array(BudgetPolicySchema),
});
export const BudgetPoliciesGetReturnSchema = BudgetPolicySchema;
export const BudgetPoliciesCreateReturnSchema = BudgetPolicySchema;
export const BudgetPoliciesUpdateReturnSchema = BudgetPolicySchema;
export const BudgetPoliciesDeleteReturnSchema = Type.Object({ success: Type.Boolean() });

export const BudgetIncidentsListReturnSchema = Type.Object({
  incidents: Type.Array(BudgetIncidentSchema),
});
export const BudgetIncidentsResolveReturnSchema = BudgetIncidentSchema;

export const CostEventsListReturnSchema = Type.Object({ events: Type.Array(CostEventSchema) });
