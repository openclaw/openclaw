import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * UPC (User Protocol Credential) verification protocol schemas
 * Defines request/response structures for UPC-based security challenges
 */

/**
 * Request to verify a UPC credential for a high-risk task
 */
export const UPCVerificationRequestSchema = Type.Object(
  {
    upcInput: NonEmptyString, // User's attempt at the UPC credential
    taskName: NonEmptyString, // Name of the high-risk task being performed
    taskDescription: Type.Optional(Type.String()), // Human-readable description of the task
  },
  { additionalProperties: false },
);

export type UPCVerificationRequest = typeof UPCVerificationRequestSchema.static;

/**
 * Response from UPC verification attempt
 */
export const UPCVerificationResponseSchema = Type.Object(
  {
    verified: Type.Boolean(),
    remainingAttempts: Type.Optional(Type.Integer({ minimum: 0 })),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type UPCVerificationResponse = typeof UPCVerificationResponseSchema.static;

/**
 * Request to set or update the UPC credential
 */
export const UPCSetRequestSchema = Type.Object(
  {
    credential: NonEmptyString, // New UPC credential (will be hashed)
  },
  { additionalProperties: false },
);

export type UPCSetRequest = typeof UPCSetRequestSchema.static;

/**
 * Response from UPC set operation
 */
export const UPCSetResponseSchema = Type.Object(
  {
    success: Type.Boolean(),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type UPCSetResponse = typeof UPCSetResponseSchema.static;

/**
 * Request to get UPC status
 */
export const UPCStatusRequestSchema = Type.Object({}, { additionalProperties: false });

export type UPCStatusRequest = typeof UPCStatusRequestSchema.static;

/**
 * Response containing UPC status
 */
export const UPCStatusResponseSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    hasUPC: Type.Boolean(),
    isLocked: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type UPCStatusResponse = typeof UPCStatusResponseSchema.static;

/**
 * Approval request payload for UPC verification
 * Similar to ExecApprovalRequestPayload but specific to UPC challenges
 */
export const UPCApprovalRequestSchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString), // Unique approval request ID
    taskName: NonEmptyString, // Name of the task requiring UPC
    taskDescription: Type.Optional(Type.String()), // Description of the task
    createdAtMs: Type.Optional(Type.Integer({ minimum: 0 })), // Request creation timestamp
  },
  { additionalProperties: false },
);

export type UPCApprovalRequest = typeof UPCApprovalRequestSchema.static;
