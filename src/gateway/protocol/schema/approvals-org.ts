/**
 * TypeBox schemas for Governance, Approvals, Activity Logs, and Config Revisions.
 */
import { Type } from "@sinclair/typebox";

// ── Shared Models ────────────────────────────────────────────────────────

export const ApprovalSchema = Type.Object(
  {
    id: Type.String(),
    workspaceId: Type.String(),
    type: Type.Union([
      Type.Literal("agent_hire"),
      Type.Literal("budget_override"),
      Type.Literal("config_change"),
    ]),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("revision_requested"),
      Type.Literal("approved"),
      Type.Literal("rejected"),
    ]),
    requesterId: Type.String(),
    requesterType: Type.Union([
      Type.Literal("agent"),
      Type.Literal("user"),
      Type.Literal("system"),
    ]),
    payloadJson: Type.Union([Type.String(), Type.Null()]),
    decisionNote: Type.Union([Type.String(), Type.Null()]),
    decidedBy: Type.Union([Type.String(), Type.Null()]),
    decidedAt: Type.Union([Type.Number(), Type.Null()]),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
  },
  { $id: "Approval" },
);

export const ActivityLogEntrySchema = Type.Object(
  {
    id: Type.Number(),
    workspaceId: Type.String(),
    actorType: Type.Union([Type.Literal("agent"), Type.Literal("user"), Type.Literal("system")]),
    actorId: Type.Union([Type.String(), Type.Null()]),
    action: Type.String(),
    entityType: Type.Union([Type.String(), Type.Null()]),
    entityId: Type.Union([Type.String(), Type.Null()]),
    detailsJson: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.Number(),
  },
  { $id: "ActivityLogEntry" },
);

export const AgentConfigRevisionSchema = Type.Object(
  {
    id: Type.String(),
    workspaceId: Type.String(),
    agentId: Type.String(),
    configJson: Type.String(),
    changedBy: Type.Union([Type.String(), Type.Null()]),
    changeNote: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.Number(),
  },
  { $id: "AgentConfigRevision" },
);

// ── Params ──────────────────────────────────────────────────────────────

export const ApprovalsListParamsSchema = Type.Object({
  workspaceId: Type.String(),
  status: Type.Optional(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("revision_requested"),
      Type.Literal("approved"),
      Type.Literal("rejected"),
    ]),
  ),
  type: Type.Optional(
    Type.Union([
      Type.Literal("agent_hire"),
      Type.Literal("budget_override"),
      Type.Literal("config_change"),
    ]),
  ),
});

export const ApprovalsGetParamsSchema = Type.Object({
  id: Type.String(),
});

export const ApprovalsCreateParamsSchema = Type.Object({
  workspaceId: Type.String(),
  type: Type.Union([
    Type.Literal("agent_hire"),
    Type.Literal("budget_override"),
    Type.Literal("config_change"),
  ]),
  requesterId: Type.String(),
  requesterType: Type.Optional(
    Type.Union([Type.Literal("agent"), Type.Literal("user"), Type.Literal("system")]),
  ),
  payload: Type.Optional(Type.Any()),
});

export const ApprovalsUpdatePayloadParamsSchema = Type.Object({
  id: Type.String(),
  payload: Type.Any(),
});

export const ApprovalsDecideParamsSchema = Type.Object({
  id: Type.String(),
  decision: Type.Union([
    Type.Literal("approved"),
    Type.Literal("rejected"),
    Type.Literal("revision_requested"),
  ]),
  decidedBy: Type.String(),
  decisionNote: Type.Optional(Type.String()),
});

export const ActivityLogsListParamsSchema = Type.Object({
  workspaceId: Type.String(),
  entityType: Type.Optional(Type.String()),
  entityId: Type.Optional(Type.String()),
  actorId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
  offset: Type.Optional(Type.Number()),
});

export const AgentConfigRevisionsListParamsSchema = Type.Object({
  workspaceId: Type.String(),
  agentId: Type.Optional(Type.String()),
});

export const AgentConfigRevisionsGetParamsSchema = Type.Object({
  id: Type.String(),
});

// ── Returns ──────────────────────────────────────────────────────────────

export const ApprovalsListReturnSchema = Type.Object({ approvals: Type.Array(ApprovalSchema) });
export const ApprovalsGetReturnSchema = ApprovalSchema;
export const ApprovalsCreateReturnSchema = ApprovalSchema;
export const ApprovalsUpdatePayloadReturnSchema = ApprovalSchema;
export const ApprovalsDecideReturnSchema = ApprovalSchema;

export const ActivityLogsListReturnSchema = Type.Object({
  logs: Type.Array(ActivityLogEntrySchema),
});

export const AgentConfigRevisionsListReturnSchema = Type.Object({
  revisions: Type.Array(AgentConfigRevisionSchema),
});
export const AgentConfigRevisionsGetReturnSchema = AgentConfigRevisionSchema;
