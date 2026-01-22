import { Type } from "@sinclair/typebox";

import { NonEmptyString } from "./primitives.js";

export const ExecApprovalsAllowlistEntrySchema = Type.Object(
  {
    pattern: Type.String(),
    lastUsedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastUsedCommand: Type.Optional(Type.String()),
    lastResolvedPath: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ExecApprovalsDefaultsSchema = Type.Object(
  {
    security: Type.Optional(Type.String()),
    ask: Type.Optional(Type.String()),
    askFallback: Type.Optional(Type.String()),
    autoAllowSkills: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ExecApprovalsAgentSchema = Type.Object(
  {
    security: Type.Optional(Type.String()),
    ask: Type.Optional(Type.String()),
    askFallback: Type.Optional(Type.String()),
    autoAllowSkills: Type.Optional(Type.Boolean()),
    allowlist: Type.Optional(Type.Array(ExecApprovalsAllowlistEntrySchema)),
  },
  { additionalProperties: false },
);

export const ExecApprovalsFileSchema = Type.Object(
  {
    version: Type.Literal(1),
    socket: Type.Optional(
      Type.Object(
        {
          path: Type.Optional(Type.String()),
          token: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    defaults: Type.Optional(ExecApprovalsDefaultsSchema),
    agents: Type.Optional(Type.Record(Type.String(), ExecApprovalsAgentSchema)),
  },
  { additionalProperties: false },
);

export const ExecApprovalsSnapshotSchema = Type.Object(
  {
    path: NonEmptyString,
    exists: Type.Boolean(),
    hash: NonEmptyString,
    file: ExecApprovalsFileSchema,
  },
  { additionalProperties: false },
);

export const ExecApprovalsGetParamsSchema = Type.Object({}, { additionalProperties: false });

export const ExecApprovalsSetParamsSchema = Type.Object(
  {
    file: ExecApprovalsFileSchema,
    baseHash: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ExecApprovalsNodeGetParamsSchema = Type.Object(
  {
    nodeId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ExecApprovalsNodeSetParamsSchema = Type.Object(
  {
    nodeId: NonEmptyString,
    file: ExecApprovalsFileSchema,
    baseHash: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ExecApprovalRequestParamsSchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString),
    command: NonEmptyString,
    cwd: Type.Optional(Type.String()),
    host: Type.Optional(Type.String()),
    security: Type.Optional(Type.String()),
    ask: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    resolvedPath: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const ExecApprovalResolveParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    decision: NonEmptyString,
  },
  { additionalProperties: false },
);
