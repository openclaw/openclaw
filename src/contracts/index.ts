/**
 * Contract enforcement module for OpenClaw.
 *
 * This module provides Zod schemas and validation functions for all
 * internal message types that flow through the dispatcher pipeline.
 *
 * @module contracts
 *
 * @example
 * ```ts
 * import { validatePlanRequest, PlanRequestSchema } from './contracts/index.js';
 *
 * // Validate a plan request
 * const planRequest = validatePlanRequest({
 *   requestId: 'req-001',
 *   sessionId: 'session-abc',
 *   sessionKey: 'agent:main:telegram',
 *   channel: 'telegram',
 *   body: 'Hello',
 *   timestamp: Date.now(),
 *   callerRole: 'dispatcher',
 * });
 *
 * // Or use safe parsing
 * const result = PlanRequestSchema.safeParse(data);
 * if (!result.success) {
 *   console.error('Invalid plan request:', result.error);
 * }
 * ```
 */

// Export all schemas and types
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
  // Validation functions (throwing)
  validatePlanRequest,
  validatePlanArtifact,
  validateTaskEnvelope,
  validateResult,
  validateEscalationSignal,
  validateMemoryWrite,
  // Safe validation functions (non-throwing)
  safeParsePlanRequest,
  safeParsePlanArtifact,
  safeParseTaskEnvelope,
  safeParseResult,
  safeParseEscalationSignal,
  safeParseMemoryWrite,
} from "./schemas.js";
