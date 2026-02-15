/**
 * Contract enforcement schemas for OpenClaw.
 *
 * This module exports strict validators for all internal message types
 * to ensure deterministic failure on schema violations.
 *
 * @module contracts
 */

export {
  // Schemas
  PlanRequestSchema,
  PlanArtifactSchema,
  TaskEnvelopeSchema,
  ResultSchema,
  EscalationSignalSchema,
  MemoryWriteSchema,
  // Types
  type PlanRequest,
  type PlanArtifact,
  type TaskEnvelope,
  type Result,
  type EscalationSignal,
  type MemoryWrite,
  // Validators (throwing)
  validatePlanRequest,
  validatePlanArtifact,
  validateTaskEnvelope,
  validateResult,
  validateEscalationSignal,
  validateMemoryWrite,
  // Safe validators (return result)
  safeParsePlanRequest,
  safeParsePlanArtifact,
  safeParseTaskEnvelope,
  safeParseResult,
  safeParseEscalationSignal,
  safeParseMemoryWrite,
} from "./schemas.js";

// Export Failure Economics - Error Taxonomy (Milestone D)
export {
  // Enums (D1)
  ErrorTaxonomy,
  ErrorSeverity,
  EscalationReason,
  EscalationAction,
  // Error classes (D2-D6)
  OpenClawError,
  SchemaViolationError,
  ModelFailureError,
  ToolFailureError,
  ResourceExhaustionError,
  InvariantViolationError,
  ContextOverflowError,
  TimeoutError,
  AbortError,
  // Response mapping (D7)
  ERROR_RESPONSE_MAP,
  getErrorResponseConfig,
  isRetryable,
  shouldEscalate,
  // Type guards
  isOpenClawError,
  isErrorTaxonomy,
  getErrorTaxonomy,
  // Types
  type ErrorResponseConfig,
} from "./error-taxonomy.js";
