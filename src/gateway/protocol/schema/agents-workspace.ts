import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

// Entry type enum
export const WorkspaceEntryTypeSchema = Type.Union([
  Type.Literal("file"),
  Type.Literal("directory"),
  Type.Literal("symlink"),
]);

// Directory entry
export const WorkspaceEntrySchema = Type.Object(
  {
    name: NonEmptyString,
    path: NonEmptyString,
    type: WorkspaceEntryTypeSchema,
    size: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    createdAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

// agents.workspace.list
export const AgentsWorkspaceListParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    path: Type.Optional(Type.String()),
    recursive: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentsWorkspaceListResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    path: Type.String(),
    entries: Type.Array(WorkspaceEntrySchema),
  },
  { additionalProperties: false },
);

// agents.workspace.get
export const AgentsWorkspaceGetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    path: NonEmptyString,
    encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])),
  },
  { additionalProperties: false },
);

export const AgentsWorkspaceGetResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    path: NonEmptyString,
    content: Type.String(),
    encoding: Type.Union([Type.Literal("utf8"), Type.Literal("base64")]),
    size: Type.Integer(),
    updatedAtMs: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);

// agents.workspace.set
export const AgentsWorkspaceSetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    path: NonEmptyString,
    content: Type.String(),
    encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])),
    createDirs: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentsWorkspaceSetResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    path: NonEmptyString,
    size: Type.Integer(),
    updatedAtMs: Type.Integer(),
  },
  { additionalProperties: false },
);

// agents.workspace.delete
export const AgentsWorkspaceDeleteParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    path: NonEmptyString,
    recursive: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentsWorkspaceDeleteResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    path: NonEmptyString,
    deleted: Type.Boolean(),
  },
  { additionalProperties: false },
);

// agents.workspace.mkdir
export const AgentsWorkspaceMkdirParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    path: NonEmptyString,
    parents: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentsWorkspaceMkdirResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    path: NonEmptyString,
    created: Type.Boolean(),
  },
  { additionalProperties: false },
);

// agents.workspace.move
export const AgentsWorkspaceMoveParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    from: NonEmptyString,
    to: NonEmptyString,
    overwrite: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentsWorkspaceMoveResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    from: NonEmptyString,
    to: NonEmptyString,
  },
  { additionalProperties: false },
);

// agents.workspace.stat
export const AgentsWorkspaceStatParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    path: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsWorkspaceStatResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    path: NonEmptyString,
    type: WorkspaceEntryTypeSchema,
    size: Type.Optional(Type.Integer()),
    updatedAtMs: Type.Optional(Type.Integer()),
    createdAtMs: Type.Optional(Type.Integer()),
    isWritable: Type.Boolean(),
  },
  { additionalProperties: false },
);
