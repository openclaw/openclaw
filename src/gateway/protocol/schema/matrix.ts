import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Parameters for matrix.verify.recoveryKey method.
 */
export const MatrixVerifyRecoveryKeyParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    accountId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export type MatrixVerifyRecoveryKeyParams = Static<typeof MatrixVerifyRecoveryKeyParamsSchema>;

/**
 * Parameters for matrix.verify.status method.
 */
export const MatrixVerifyStatusParamsSchema = Type.Object(
  {
    accountId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export type MatrixVerifyStatusParams = Static<typeof MatrixVerifyStatusParamsSchema>;
