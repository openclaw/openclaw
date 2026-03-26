/**
 * TypeBox schemas for Routines, Workspace Skills, and Portability RPC endpoints.
 * Adapted from Paperclip server routes (paperclip sync P3).
 */
import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

// ── Routine ──────────────────────────────────────────────────────────────────

export const RoutineSchema = Type.Object(
  {
    id: Type.String(),
    workspaceId: Type.String(),
    projectId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    goalId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    parentIssueId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    title: Type.String(),
    description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    assigneeAgentId: Type.String(),
    priority: Type.String(),
    status: Type.String(),
    concurrencyPolicy: Type.String(),
    catchUpPolicy: Type.String(),
    createdByAgentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    createdByUserId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    updatedByAgentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    updatedByUserId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    lastTriggeredAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    lastEnqueuedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
  },
  { $id: "Routine" },
);

export const RoutineTriggerSchema = Type.Object(
  {
    id: Type.String(),
    workspaceId: Type.String(),
    routineId: Type.String(),
    kind: Type.String(),
    label: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    enabled: Type.Boolean(),
    cronExpression: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    timezone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    nextRunAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    lastFiredAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    publicId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    secretSigningMode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    replayWindowSec: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    lastRotatedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    lastResult: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    createdByAgentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    createdByUserId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
  },
  { $id: "RoutineTrigger" },
);

export const RoutineRunSchema = Type.Object(
  {
    id: Type.String(),
    workspaceId: Type.String(),
    routineId: Type.String(),
    triggerId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    source: Type.String(),
    status: Type.String(),
    triggeredAt: Type.Number(),
    idempotencyKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    linkedIssueId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    coalescedIntoRunId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    failureReason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    completedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
  },
  { $id: "RoutineRun" },
);

// ── Routine Params ────────────────────────────────────────────────────────────

export const RoutinesListParamsSchema = Type.Object({
  workspaceId: Type.String(),
});

export const RoutinesGetParamsSchema = Type.Object({
  id: Type.String(),
});

export const RoutinesCreateParamsSchema = Type.Object({
  workspaceId: Type.String(),
  title: NonEmptyString,
  description: Type.Optional(Type.String()),
  assigneeAgentId: Type.String(),
  projectId: Type.Optional(Type.String()),
  goalId: Type.Optional(Type.String()),
  parentIssueId: Type.Optional(Type.String()),
  priority: Type.Optional(Type.String()),
  concurrencyPolicy: Type.Optional(Type.String()),
  catchUpPolicy: Type.Optional(Type.String()),
});

export const RoutinesUpdateParamsSchema = Type.Object({
  id: Type.String(),
  title: Type.Optional(NonEmptyString),
  description: Type.Optional(Type.String()),
  assigneeAgentId: Type.Optional(Type.String()),
  priority: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  concurrencyPolicy: Type.Optional(Type.String()),
  catchUpPolicy: Type.Optional(Type.String()),
});

export const RoutinesDeleteParamsSchema = Type.Object({
  id: Type.String(),
});

export const RoutinesTriggersListParamsSchema = Type.Object({
  routineId: Type.String(),
});

export const RoutinesTriggersCreateParamsSchema = Type.Object({
  routineId: Type.String(),
  kind: NonEmptyString,
  label: Type.Optional(Type.String()),
  cronExpression: Type.Optional(Type.String()),
  timezone: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
});

export const RoutinesTriggersDeleteParamsSchema = Type.Object({
  id: Type.String(),
});

export const RoutinesRunsListParamsSchema = Type.Object({
  routineId: Type.String(),
  limit: Type.Optional(Type.Number()),
});

export const RoutinesRunsGetParamsSchema = Type.Object({
  id: Type.String(),
});

// ── Routine Returns ───────────────────────────────────────────────────────────

export const RoutinesListReturnSchema = Type.Object({ routines: Type.Array(RoutineSchema) });
export const RoutinesGetReturnSchema = RoutineSchema;
export const RoutinesCreateReturnSchema = RoutineSchema;
export const RoutinesUpdateReturnSchema = RoutineSchema;
export const RoutinesDeleteReturnSchema = Type.Object({ ok: Type.Boolean() });
export const RoutinesTriggersListReturnSchema = Type.Object({ triggers: Type.Array(RoutineTriggerSchema) });
export const RoutinesTriggersCreateReturnSchema = RoutineTriggerSchema;
export const RoutinesTriggersDeleteReturnSchema = Type.Object({ ok: Type.Boolean() });
export const RoutinesRunsListReturnSchema = Type.Object({ runs: Type.Array(RoutineRunSchema) });
export const RoutinesRunsGetReturnSchema = RoutineRunSchema;

// ── Workspace Skill ───────────────────────────────────────────────────────────

export const WorkspaceSkillFileInventoryEntrySchema = Type.Object({
  path: Type.String(),
  kind: Type.String(),
  sizeBytes: Type.Optional(Type.Number()),
});

export const WorkspaceSkillSchema = Type.Object(
  {
    id: Type.String(),
    workspaceId: Type.String(),
    key: Type.String(),
    slug: Type.String(),
    name: Type.String(),
    description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    markdown: Type.String(),
    sourceType: Type.String(),
    sourceLocator: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sourceRef: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    trustLevel: Type.String(),
    compatibility: Type.String(),
    fileInventory: Type.Array(WorkspaceSkillFileInventoryEntrySchema),
    metadata: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
  },
  { $id: "WorkspaceSkill" },
);

export const WorkspaceSkillListItemSchema = Type.Object(
  {
    id: Type.String(),
    workspaceId: Type.String(),
    key: Type.String(),
    slug: Type.String(),
    name: Type.String(),
    description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sourceType: Type.String(),
    sourceLocator: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sourceRef: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    trustLevel: Type.String(),
    compatibility: Type.String(),
    fileInventory: Type.Array(WorkspaceSkillFileInventoryEntrySchema),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
    attachedAgentCount: Type.Number(),
  },
  { $id: "WorkspaceSkillListItem" },
);

// ── Workspace Skill Params ────────────────────────────────────────────────────

export const WorkspaceSkillsListParamsSchema = Type.Object({
  workspaceId: Type.String(),
});

export const WorkspaceSkillsGetParamsSchema = Type.Object({
  id: Type.String(),
});

export const WorkspaceSkillsCreateParamsSchema = Type.Object({
  workspaceId: Type.String(),
  key: NonEmptyString,
  slug: NonEmptyString,
  name: NonEmptyString,
  description: Type.Optional(Type.String()),
  markdown: Type.String(),
  sourceType: Type.String(),
  sourceLocator: Type.Optional(Type.String()),
  sourceRef: Type.Optional(Type.String()),
  trustLevel: Type.Optional(Type.String()),
  compatibility: Type.Optional(Type.String()),
  fileInventory: Type.Optional(Type.Array(WorkspaceSkillFileInventoryEntrySchema)),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export const WorkspaceSkillsUpdateParamsSchema = Type.Object({
  id: Type.String(),
  name: Type.Optional(NonEmptyString),
  description: Type.Optional(Type.String()),
  markdown: Type.Optional(Type.String()),
  sourceRef: Type.Optional(Type.String()),
  trustLevel: Type.Optional(Type.String()),
  compatibility: Type.Optional(Type.String()),
  fileInventory: Type.Optional(Type.Array(WorkspaceSkillFileInventoryEntrySchema)),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export const WorkspaceSkillsDeleteParamsSchema = Type.Object({
  id: Type.String(),
});

// ── Workspace Skill Returns ───────────────────────────────────────────────────

export const WorkspaceSkillsListReturnSchema = Type.Object({ skills: Type.Array(WorkspaceSkillListItemSchema) });
export const WorkspaceSkillsGetReturnSchema = WorkspaceSkillSchema;
export const WorkspaceSkillsCreateReturnSchema = WorkspaceSkillSchema;
export const WorkspaceSkillsUpdateReturnSchema = WorkspaceSkillSchema;
export const WorkspaceSkillsDeleteReturnSchema = Type.Object({ ok: Type.Boolean() });

// ── Portability ───────────────────────────────────────────────────────────────

export const PortabilityIncludeSchema = Type.Object({
  agents: Type.Optional(Type.Boolean()),
  workspaces: Type.Optional(Type.Boolean()),
  skills: Type.Optional(Type.Boolean()),
  goals: Type.Optional(Type.Boolean()),
  routines: Type.Optional(Type.Boolean()),
});

export const PortabilityExportSchema = Type.Object(
  {
    id: Type.String(),
    workspaceId: Type.String(),
    exportedBy: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    include: PortabilityIncludeSchema,
    status: Type.String(),
    assetPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    createdAt: Type.Number(),
    completedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  },
  { $id: "PortabilityExport" },
);

export const PortabilityImportSchema = Type.Object(
  {
    id: Type.String(),
    workspaceId: Type.String(),
    importedBy: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sourceRef: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    collisionStrategy: Type.String(),
    status: Type.String(),
    result: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
    error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    createdAt: Type.Number(),
    completedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  },
  { $id: "PortabilityImport" },
);

// ── Portability Params ────────────────────────────────────────────────────────

export const PortabilityExportsListParamsSchema = Type.Object({
  workspaceId: Type.Optional(Type.String()),
});

export const PortabilityExportsCreateParamsSchema = Type.Object({
  workspaceId: Type.String(),
  include: PortabilityIncludeSchema,
  exportedBy: Type.Optional(Type.String()),
});

export const PortabilityExportsGetParamsSchema = Type.Object({
  id: Type.String(),
});

export const PortabilityImportsListParamsSchema = Type.Object({
  workspaceId: Type.Optional(Type.String()),
});

export const PortabilityImportsCreateParamsSchema = Type.Object({
  workspaceId: Type.String(),
  sourceRef: Type.Optional(Type.String()),
  collisionStrategy: Type.Optional(Type.String()),
  importedBy: Type.Optional(Type.String()),
});

export const PortabilityImportsGetParamsSchema = Type.Object({
  id: Type.String(),
});

// ── Portability Returns ───────────────────────────────────────────────────────

export const PortabilityExportsListReturnSchema = Type.Object({ exports: Type.Array(PortabilityExportSchema) });
export const PortabilityExportsGetReturnSchema = PortabilityExportSchema;
export const PortabilityExportsCreateReturnSchema = PortabilityExportSchema;
export const PortabilityImportsListReturnSchema = Type.Object({ imports: Type.Array(PortabilityImportSchema) });
export const PortabilityImportsGetReturnSchema = PortabilityImportSchema;
export const PortabilityImportsCreateReturnSchema = PortabilityImportSchema;
