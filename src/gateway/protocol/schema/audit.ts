/**
 * Audit RPC schemas
 */

import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const AuditCategorySchema = Type.Union([
  Type.Literal("config"),
  Type.Literal("agent"),
  Type.Literal("security"),
  Type.Literal("token"),
]);

const AuditSeveritySchema = Type.Union([
  Type.Literal("info"),
  Type.Literal("warn"),
  Type.Literal("error"),
]);

const AuditEventSchema = Type.Object({
  id: NonEmptyString,
  ts: Type.Number(),
  category: AuditCategorySchema,
  action: NonEmptyString,
  severity: AuditSeveritySchema,
  actorId: Type.Optional(Type.String()),
  detail: Type.Record(Type.String(), Type.Unknown()),
});

// =============================================================================
// audit.query
// =============================================================================

export const AuditQueryParamsSchema = Type.Object(
  {
    category: Type.Optional(AuditCategorySchema),
    action: Type.Optional(Type.String()),
    severity: Type.Optional(AuditSeveritySchema),
    startTs: Type.Optional(Type.Integer({ minimum: 0 })),
    endTs: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const AuditQueryResultSchema = Type.Object(
  {
    events: Type.Array(AuditEventSchema),
    total: Type.Number(),
    hasMore: Type.Boolean(),
  },
  { additionalProperties: false },
);
