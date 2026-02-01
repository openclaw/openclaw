/**
 * Token RPC schemas
 */

import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const TokenScopeSchema = Type.Union([
  Type.Literal("agent:read"),
  Type.Literal("agent:write"),
  Type.Literal("config:read"),
  Type.Literal("config:write"),
  Type.Literal("audit:read"),
  Type.Literal("sessions:read"),
  Type.Literal("sessions:write"),
  Type.Literal("*"),
]);

const TokenInfoSchema = Type.Object({
  id: NonEmptyString,
  name: NonEmptyString,
  prefix: NonEmptyString,
  scopes: Type.Array(TokenScopeSchema),
  createdAt: Type.Number(),
  expiresAt: Type.Union([Type.Number(), Type.Null()]),
  lastUsedAt: Type.Union([Type.Number(), Type.Null()]),
  revokedAt: Type.Union([Type.Number(), Type.Null()]),
});

// =============================================================================
// tokens.list
// =============================================================================

export const TokensListParamsSchema = Type.Object({}, { additionalProperties: false });

export const TokensListResultSchema = Type.Object(
  {
    tokens: Type.Array(TokenInfoSchema),
  },
  { additionalProperties: false },
);

// =============================================================================
// tokens.create
// =============================================================================

export const TokensCreateParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    scopes: Type.Array(TokenScopeSchema, { minItems: 1 }),
    expiresInDays: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  },
  { additionalProperties: false },
);

export const TokensCreateResultSchema = Type.Object(
  {
    token: TokenInfoSchema,
    fullToken: NonEmptyString,
  },
  { additionalProperties: false },
);

// =============================================================================
// tokens.revoke
// =============================================================================

export const TokensRevokeParamsSchema = Type.Object(
  {
    tokenId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const TokensRevokeResultSchema = Type.Object(
  {
    success: Type.Boolean(),
  },
  { additionalProperties: false },
);
