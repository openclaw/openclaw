// Type definitions for the Phase 4E Validation-Only Canonical Path Registry.
// These types are derived from the Zod schemas in zod-schema.registry-validation.ts.
// The Zod schemas are the authoritative source of truth for validation.
// These types exist for ergonomic import in non-validation code paths.
export type {
  PathClass,
  EvidenceType,
  EvidenceConfidence,
  ResolutionStatus,
  CapabilityStatus,
  ConflictSeverity,
  EvidenceRecord,
  RegistryComponentDeclaration,
  RegistrySpecification,
  RuntimeObservation,
  EffectiveValueObservation,
  ResolutionResult,
  ConflictResult,
  RequirementContext,
  CapabilityStatusResult,
  ComponentValidationResult,
  ValidationSnapshot,
  ValidationReportSummary,
} from "./zod-schema.registry-validation.js";
