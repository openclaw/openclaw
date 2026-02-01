/**
 * Security RPC schemas
 */

import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

// =============================================================================
// security.getState
// =============================================================================

export const SecurityGetStateParamsSchema = Type.Object({}, { additionalProperties: false });

export const SecurityGetStateResultSchema = Type.Object(
  {
    lockEnabled: Type.Boolean(),
    isUnlocked: Type.Boolean(),
    session: Type.Union([
      Type.Object({
        id: NonEmptyString,
        createdAt: Type.Number(),
        expiresAt: Type.Number(),
        valid: Type.Boolean(),
      }),
      Type.Null(),
    ]),
    twoFactorEnabled: Type.Boolean(),
    requiresSetup: Type.Boolean(),
  },
  { additionalProperties: false },
);

// =============================================================================
// security.setupPassword
// =============================================================================

export const SecuritySetupPasswordParamsSchema = Type.Object(
  {
    password: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SecuritySetupPasswordResultSchema = Type.Object(
  {
    success: Type.Boolean(),
    session: Type.Optional(
      Type.Object({
        id: NonEmptyString,
        createdAt: Type.Number(),
        expiresAt: Type.Number(),
        valid: Type.Boolean(),
      }),
    ),
  },
  { additionalProperties: false },
);

// =============================================================================
// security.changePassword
// =============================================================================

export const SecurityChangePasswordParamsSchema = Type.Object(
  {
    currentPassword: NonEmptyString,
    newPassword: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SecurityChangePasswordResultSchema = Type.Object(
  {
    success: Type.Boolean(),
  },
  { additionalProperties: false },
);

// =============================================================================
// security.unlock
// =============================================================================

export const SecurityUnlockParamsSchema = Type.Object(
  {
    password: NonEmptyString,
    totpCode: Type.Optional(Type.String()),
    recoveryCode: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SecurityUnlockResultSchema = Type.Object(
  {
    success: Type.Boolean(),
    session: Type.Optional(
      Type.Object({
        id: NonEmptyString,
        createdAt: Type.Number(),
        expiresAt: Type.Number(),
        valid: Type.Boolean(),
      }),
    ),
    requires2fa: Type.Optional(Type.Boolean()),
    failureReason: Type.Optional(Type.String()),
    attemptsRemaining: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

// =============================================================================
// security.lock
// =============================================================================

export const SecurityLockParamsSchema = Type.Object({}, { additionalProperties: false });

export const SecurityLockResultSchema = Type.Object(
  {
    success: Type.Boolean(),
  },
  { additionalProperties: false },
);

// =============================================================================
// security.disable
// =============================================================================

export const SecurityDisableParamsSchema = Type.Object(
  {
    password: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SecurityDisableResultSchema = Type.Object(
  {
    success: Type.Boolean(),
  },
  { additionalProperties: false },
);

// =============================================================================
// security.setup2fa
// =============================================================================

export const SecuritySetup2faParamsSchema = Type.Object(
  {
    password: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SecuritySetup2faResultSchema = Type.Object(
  {
    success: Type.Optional(Type.Boolean()),
    setupData: Type.Optional(
      Type.Object({
        secret: NonEmptyString,
        otpauthUrl: NonEmptyString,
        qrCodeDataUrl: NonEmptyString,
      }),
    ),
  },
  { additionalProperties: false },
);

// =============================================================================
// security.verify2fa
// =============================================================================

export const SecurityVerify2faParamsSchema = Type.Object(
  {
    code: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SecurityVerify2faResultSchema = Type.Object(
  {
    success: Type.Boolean(),
    recoveryCodes: Type.Optional(
      Type.Object({
        codes: Type.Array(NonEmptyString),
        generatedAt: Type.Number(),
      }),
    ),
  },
  { additionalProperties: false },
);

// =============================================================================
// security.disable2fa
// =============================================================================

export const SecurityDisable2faParamsSchema = Type.Object(
  {
    password: NonEmptyString,
    code: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SecurityDisable2faResultSchema = Type.Object(
  {
    success: Type.Boolean(),
  },
  { additionalProperties: false },
);

// =============================================================================
// security.getHistory
// =============================================================================

export const SecurityGetHistoryParamsSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const SecurityGetHistoryResultSchema = Type.Object(
  {
    events: Type.Array(
      Type.Object({
        id: NonEmptyString,
        ts: Type.Number(),
        success: Type.Boolean(),
        failureReason: Type.Optional(Type.String()),
        ipAddress: Type.Optional(Type.String()),
        userAgent: Type.Optional(Type.String()),
        deviceFingerprint: Type.Optional(Type.String()),
      }),
    ),
    total: Type.Number(),
  },
  { additionalProperties: false },
);
