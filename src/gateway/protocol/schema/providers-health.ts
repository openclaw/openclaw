/**
 * Protocol schemas for providers.health endpoint.
 */

import { Type, type Static } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

// Usage window entry (quota per time period)
export const UsageWindowSchema = Type.Object(
  {
    label: Type.String(),
    usedPercent: Type.Number(),
    resetAt: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);

// Provider health entry
export const ProviderHealthEntrySchema = Type.Object(
  {
    id: NonEmptyString,
    name: NonEmptyString,
    detected: Type.Boolean(),
    authSource: Type.Optional(Type.String()),
    authMode: Type.Optional(Type.String()),
    tokenValidity: Type.Optional(Type.String()),
    tokenExpiresAt: Type.Optional(Type.Integer()),
    tokenRemainingMs: Type.Optional(Type.Integer()),
    healthStatus: Type.String(),
    inCooldown: Type.Optional(Type.Boolean()),
    cooldownRemainingMs: Type.Optional(Type.Integer()),
    cooldownEndsAt: Type.Optional(Type.Integer()),
    errorCount: Type.Optional(Type.Integer()),
    disabledReason: Type.Optional(Type.String()),
    lastUsed: Type.Optional(Type.String()),
    usageWindows: Type.Optional(Type.Array(UsageWindowSchema)),
    usagePlan: Type.Optional(Type.String()),
    usageError: Type.Optional(Type.String()),
    isLocal: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

// providers.health params
export const ProvidersHealthParamsSchema = Type.Object(
  {
    all: Type.Optional(Type.Boolean()),
    includeUsage: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

// providers.health result
export const ProvidersHealthResultSchema = Type.Object(
  {
    providers: Type.Array(ProviderHealthEntrySchema),
    updatedAt: Type.Integer(),
  },
  { additionalProperties: false },
);

// Type exports
export type UsageWindow = Static<typeof UsageWindowSchema>;
export type ProviderHealthEntry = Static<typeof ProviderHealthEntrySchema>;
export type ProvidersHealthParams = Static<typeof ProvidersHealthParamsSchema>;
export type ProvidersHealthResult = Static<typeof ProvidersHealthResultSchema>;
