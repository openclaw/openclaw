/**
 * TypeBox schemas for Workspaces RPC endpoints.
 */
import { Type } from "@sinclair/typebox";

export const WorkspaceSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    description: Type.Optional(Type.String()),
    status: Type.Union([
      Type.Literal("active"),
      Type.Literal("archived"),
      Type.Literal("suspended"),
    ]),
    taskPrefix: Type.String(),
    taskCounter: Type.Number(),
    budgetMonthlyMicrocents: Type.Optional(Type.Number()),
    spentMonthlyMicrocents: Type.Number(),
    brandColor: Type.Optional(Type.String()),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
  },
  { $id: "Workspace" },
);

export const WorkspaceAgentSchema = Type.Object(
  {
    workspaceId: Type.String(),
    agentId: Type.String(),
    role: Type.Optional(Type.String()),
    status: Type.Union([Type.Literal("active"), Type.Literal("inactive"), Type.Literal("paused")]),
    capabilities: Type.Array(Type.String()),
    joinedAt: Type.Number(),
  },
  { $id: "WorkspaceAgent" },
);

// ── Params ──────────────────────────────────────────────────────────────

export const WorkspacesListParamsSchema = Type.Object({});
export const WorkspacesGetParamsSchema = Type.Object({ id: Type.String() });
export const WorkspacesCreateParamsSchema = Type.Object({
  name: Type.String(),
  description: Type.Optional(Type.String()),
  taskPrefix: Type.Optional(Type.String()),
  brandColor: Type.Optional(Type.String()),
});
export const WorkspacesUpdateParamsSchema = Type.Object({
  id: Type.String(),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  brandColor: Type.Optional(Type.String()),
});
export const WorkspacesArchiveParamsSchema = Type.Object({ id: Type.String() });
export const WorkspacesAgentsParamsSchema = Type.Object({ workspaceId: Type.String() });
export const WorkspacesAssignAgentParamsSchema = Type.Object({
  workspaceId: Type.String(),
  agentId: Type.String(),
  role: Type.Optional(Type.String()),
});
export const WorkspacesRemoveAgentParamsSchema = Type.Object({
  workspaceId: Type.String(),
  agentId: Type.String(),
});

// ── Returns ──────────────────────────────────────────────────────────────

export const WorkspacesListReturnSchema = Type.Object({ workspaces: Type.Array(WorkspaceSchema) });
export const WorkspacesGetReturnSchema = WorkspaceSchema;
export const WorkspacesCreateReturnSchema = WorkspaceSchema;
export const WorkspacesUpdateReturnSchema = WorkspaceSchema;
export const WorkspacesArchiveReturnSchema = WorkspaceSchema;
export const WorkspacesAgentsReturnSchema = Type.Object({
  agents: Type.Array(WorkspaceAgentSchema),
});
export const WorkspacesAssignAgentReturnSchema = Type.Object({ ok: Type.Literal(true) });
export const WorkspacesRemoveAgentReturnSchema = Type.Object({ ok: Type.Literal(true) });
