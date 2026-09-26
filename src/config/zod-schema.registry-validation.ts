// Zod schemas for the Phase 4E Validation-Only Canonical Path Registry.
// These are machine-readable contracts only. No runtime observation or validation behavior.
// All schemas reject unknown properties unless explicitly noted.
import { z } from "zod";

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const PathClassSchema = z.enum([
  "NATIVE_RUNTIME",
  "CONFIGURED_WORKSPACE",
  "JOINT_OPERATIONAL",
  "EXTERNAL_SERVICE",
]);

export const EvidenceTypeSchema = z.enum([
  "CODE",
  "CONFIG",
  "FILESYSTEM",
  "PROCESS",
  "HTTP",
  "USER",
  "MANUAL",
  "HISTORICAL_DOCUMENT",
]);

export const EvidenceConfidenceSchema = z.enum(["HIGH", "MEDIUM", "LOW"]);

export const ResolutionStatusSchema = z.enum([
  "VERIFIED",
  "MISMATCH",
  "MISSING",
  "UNREADABLE",
  "UNREACHABLE",
  "UNKNOWN",
  "ERROR",
]);

export const CapabilityStatusSchema = z.enum([
  "HEALTHY",
  "DEGRADED",
  "FALLBACK_ACTIVE",
  "UNAVAILABLE",
  "BLOCKED",
  "UNKNOWN",
]);

export const ConflictSeveritySchema = z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

export const SchemaVersionSchema = z.object({
  schemaId: z.string().min(1),
  version: z.string().min(1),
  compatibilityPolicy: z.enum(["exact", "forward", "backward"]),
});

// Supported schema versions — unsupported versions must fail validation.
export const SUPPORTED_SCHEMA_VERSIONS = new Map<string, string[]>([
  ["openclaw.registry-specification", ["1.0.0"]],
  ["openclaw.validation-snapshot", ["1.0.0"]],
]);

export function isSupportedSchemaVersion(schemaId: string, version: string): boolean {
  const supported = SUPPORTED_SCHEMA_VERSIONS.get(schemaId);
  return supported ? supported.includes(version) : false;
}

// ---------------------------------------------------------------------------
// EvidenceRecord
// ---------------------------------------------------------------------------

export const EvidenceRecordSchema = z.object(
  {
    evidenceType: EvidenceTypeSchema,
    source: z.string().min(1),
    collectedAt: z.string().datetime(),
    collector: z.string().min(1),
    confidence: EvidenceConfidenceSchema,
    valueHash: z.string().nullable(),
    notes: z.string().nullable(),
  },
  { message: "EvidenceRecord must contain exactly the defined fields" },
);

// ---------------------------------------------------------------------------
// RegistryComponentDeclaration (persisted declaration — no runtime fields)
// ---------------------------------------------------------------------------

export const RegistryComponentDeclarationSchema = z
  .object({
    componentId: z.string().min(1),
    pathClass: PathClassSchema,
    logicalName: z.string().min(1),
    declarationRule: z.string().nullable(),
    declaredValue: z.string().nullable(),
    declarationSource: z.string().min(1),
    lifecycle: z.string().min(1),
    startupRequirementRule: z.union([z.string(), z.boolean()]),
    capabilityDependencies: z.array(z.string()),
    taskDependencyRules: z.array(z.string()),
    fallbackPolicy: z.record(z.string(), z.unknown()).nullable(),
    validationPolicy: z.record(z.string(), z.unknown()),
    notes: z.string().nullable(),
  })
  .strict();

// Runtime fields that must never appear in a persisted declaration.
export const RuntimeFieldsRejectionSchema = z
  .object({
    observedValue: z.never().optional(),
    effectiveValue: z.never().optional(),
    exists: z.never().optional(),
    runtimeConsumed: z.never().optional(),
    evidence: z.never().optional(),
    conflictStatus: z.never().optional(),
    capabilityStatus: z.never().optional(),
    resolutionStatus: z.never().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// RegistrySpecification
// ---------------------------------------------------------------------------

export const RegistrySpecificationSchema = z
  .object({
    schema: SchemaVersionSchema,
    components: z.array(RegistryComponentDeclarationSchema).min(1),
    metadata: z
      .object({
        version: z.string().optional(),
        author: z.string().optional(),
        timestamp: z.string().datetime().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    // Validate supported schema version
    if (!isSupportedSchemaVersion(spec.schema.schemaId, spec.schema.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unsupported schema version: ${spec.schema.schemaId}@${spec.schema.version}`,
        path: ["schema", "version"],
      });
    }

    // Enforce unique component IDs
    const ids = new Set<string>();
    for (const comp of spec.components) {
      if (ids.has(comp.componentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate componentId: "${comp.componentId}". Component IDs must be unique within the registry.`,
          path: ["components"],
        });
      }
      ids.add(comp.componentId);
    }
  });

// ---------------------------------------------------------------------------
// RuntimeObservation
// ---------------------------------------------------------------------------

export const RuntimeObservationSchema = z
  .object({
    componentId: z.string().min(1),
    observedValue: z.string().nullable(),
    observationStatus: z.string().min(1),
    collectedAt: z.string().datetime(),
    evidence: z.array(EvidenceRecordSchema).min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// EffectiveValueObservation
// ---------------------------------------------------------------------------

export const EffectiveValueObservationSchema = z
  .object({
    componentId: z.string().min(1),
    effectiveValue: z.string().nullable(),
    authoritySource: z.string().nullable(),
    confidence: EvidenceConfidenceSchema,
    evidence: z.array(EvidenceRecordSchema).min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// ResolutionResult
// ---------------------------------------------------------------------------

export const ResolutionResultSchema = z
  .object({
    componentId: z.string().min(1),
    declaredValue: z.string().nullable(),
    observedValue: z.string().nullable(),
    effectiveValue: z.string().nullable(),
    resolutionStatus: ResolutionStatusSchema,
    conflictStatus: z.string().nullable(),
    evidenceSufficient: z.boolean(),
    notes: z.string().nullable().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// ConflictResult
// ---------------------------------------------------------------------------

export const ConflictResultSchema = z
  .object({
    componentId: z.string().min(1),
    conflictType: z.string().min(1),
    severity: ConflictSeveritySchema,
    authorityConflict: z.boolean(),
    startupImpact: z.boolean(),
    capabilityImpact: z.array(z.string()),
    taskImpact: z.array(z.string()),
    fallbackAvailable: z.boolean(),
    fallbackActive: z.boolean(),
    approvalRequired: z.boolean(),
    blocking: z.boolean(),
    evidence: z.array(EvidenceRecordSchema).min(1),
    notes: z.string().nullable().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// RequirementContext
// ---------------------------------------------------------------------------

export const RequirementContextSchema = z
  .object({
    componentId: z.string().min(1),
    startupRequired: z.boolean(),
    startupRequirementSource: z.string().min(1),
    capabilityRequired: z.boolean(),
    requiredCapabilities: z.array(z.string()),
    taskRequired: z.boolean(),
    requiredTasks: z.array(z.string()),
    activeRuntimeProfile: z.string().nullable(),
    fallbackAllowed: z.boolean(),
    fallbackApproved: z.boolean(),
    policyBlocked: z.boolean(),
    approvalBlocked: z.boolean(),
    evidence: z.array(EvidenceRecordSchema).min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// CapabilityStatusResult
// ---------------------------------------------------------------------------

export const CapabilityStatusResultSchema = z
  .object({
    componentId: z.string().min(1),
    status: CapabilityStatusSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// ComponentValidationResult
// ---------------------------------------------------------------------------

export const ComponentValidationResultSchema = z
  .object({
    componentId: z.string().min(1),
    declaration: RegistryComponentDeclarationSchema,
    observation: RuntimeObservationSchema.nullable(),
    effectiveValueObservation: EffectiveValueObservationSchema.nullable(),
    resolution: ResolutionResultSchema,
    conflict: ConflictResultSchema.nullable(),
    requirementEvaluation: RequirementContextSchema,
    capabilityStatus: CapabilityStatusResultSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// ValidationSnapshot
// ---------------------------------------------------------------------------

export const ValidationSnapshotSchema = z
  .object({
    schema: SchemaVersionSchema,
    specHash: z.string().min(1),
    executionId: z.string().uuid(),
    startTimestamp: z.string().datetime(),
    completionTimestamp: z.string().datetime(),
    validatorBuildId: z.string().nullable(),
    validationContext: z.record(z.string(), z.unknown()),
    components: z.array(ComponentValidationResultSchema),
    overallStatus: CapabilityStatusSchema,
    outputComplete: z.boolean(),
    diagnostics: z.array(z.record(z.string(), z.unknown())),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (!isSupportedSchemaVersion(snapshot.schema.schemaId, snapshot.schema.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unsupported schema version: ${snapshot.schema.schemaId}@${snapshot.schema.version}`,
        path: ["schema", "version"],
      });
    }
  });
// ---------------------------------------------------------------------------

export const ValidationReportSummarySchema = z
  .object({
    executedAt: z.string().datetime(),
    durationMs: z.number().nonnegative(),
    summaryTable: z.string(),
    detailsLink: z.string().nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Re-exports for type inference
// ---------------------------------------------------------------------------

export type PathClass = z.infer<typeof PathClassSchema>;
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;
export type EvidenceConfidence = z.infer<typeof EvidenceConfidenceSchema>;
export type ResolutionStatus = z.infer<typeof ResolutionStatusSchema>;
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;
export type ConflictSeverity = z.infer<typeof ConflictSeveritySchema>;
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
export type RegistryComponentDeclaration = z.infer<typeof RegistryComponentDeclarationSchema>;
export type RegistrySpecification = z.infer<typeof RegistrySpecificationSchema>;
export type RuntimeObservation = z.infer<typeof RuntimeObservationSchema>;
export type EffectiveValueObservation = z.infer<typeof EffectiveValueObservationSchema>;
export type ResolutionResult = z.infer<typeof ResolutionResultSchema>;
export type ConflictResult = z.infer<typeof ConflictResultSchema>;
export type RequirementContext = z.infer<typeof RequirementContextSchema>;
export type CapabilityStatusResult = z.infer<typeof CapabilityStatusResultSchema>;
export type ComponentValidationResult = z.infer<typeof ComponentValidationResultSchema>;
export type ValidationSnapshot = z.infer<typeof ValidationSnapshotSchema>;
export type ValidationReportSummary = z.infer<typeof ValidationReportSummarySchema>;
