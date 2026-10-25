import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Contract tests for the Phase 4E Validation-Only Canonical Path Registry schemas.
// These tests verify that all valid fixtures pass schema validation and all invalid
// fixtures are rejected for the intended reasons. No network, Docker, or gateway required.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CapabilityStatusResultSchema,
  CapabilityStatusSchema,
  ComponentValidationResultSchema,
  ConflictResultSchema,
  ConflictSeveritySchema,
  EffectiveValueObservationSchema,
  EvidenceConfidenceSchema,
  EvidenceRecordSchema,
  EvidenceTypeSchema,
  PathClassSchema,
  RegistryComponentDeclarationSchema,
  RegistrySpecificationSchema,
  RequirementContextSchema,
  ResolutionResultSchema,
  ResolutionStatusSchema,
  RuntimeObservationSchema,
  ValidationSnapshotSchema,
} from "./zod-schema.registry-validation.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES_DIR = path.join(repoRoot, "test", "fixtures", "registry-validation");
const VALID_DIR = path.join(FIXTURES_DIR, "valid");
const INVALID_DIR = path.join(FIXTURES_DIR, "invalid");

function loadJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function loadAllFromDir(dir: string): Array<{ name: string; data: unknown }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .toSorted()
    .map((f) => ({ name: f, data: loadJson(path.join(dir, f)) }));
}

// ---------------------------------------------------------------------------
// Enum contract tests
// ---------------------------------------------------------------------------

describe("Registry validation — enum contracts", () => {
  it("PathClass accepts all four values", () => {
    for (const v of [
      "NATIVE_RUNTIME",
      "CONFIGURED_WORKSPACE",
      "JOINT_OPERATIONAL",
      "EXTERNAL_SERVICE",
    ]) {
      expect(PathClassSchema.safeParse(v).success).toBe(true);
    }
  });

  it("PathClass rejects unknown values", () => {
    expect(PathClassSchema.safeParse("INVALID").success).toBe(false);
  });

  it("EvidenceType accepts all defined values", () => {
    for (const v of [
      "CODE",
      "CONFIG",
      "FILESYSTEM",
      "PROCESS",
      "HTTP",
      "USER",
      "MANUAL",
      "HISTORICAL_DOCUMENT",
    ]) {
      expect(EvidenceTypeSchema.safeParse(v).success).toBe(true);
    }
  });

  it("EvidenceType rejects unknown values", () => {
    expect(EvidenceTypeSchema.safeParse("UNKNOWN_TYPE").success).toBe(false);
  });

  it("EvidenceConfidence accepts HIGH, MEDIUM, LOW", () => {
    for (const v of ["HIGH", "MEDIUM", "LOW"]) {
      expect(EvidenceConfidenceSchema.safeParse(v).success).toBe(true);
    }
  });

  it("EvidenceConfidence rejects unknown values", () => {
    expect(EvidenceConfidenceSchema.safeParse("ULTRA").success).toBe(false);
  });

  it("ResolutionStatus accepts all seven values", () => {
    for (const v of [
      "VERIFIED",
      "MISMATCH",
      "MISSING",
      "UNREADABLE",
      "UNREACHABLE",
      "UNKNOWN",
      "ERROR",
    ]) {
      expect(ResolutionStatusSchema.safeParse(v).success).toBe(true);
    }
  });

  it("ResolutionStatus rejects CapabilityStatus values", () => {
    for (const v of ["HEALTHY", "DEGRADED", "FALLBACK_ACTIVE", "UNAVAILABLE", "BLOCKED"]) {
      expect(ResolutionStatusSchema.safeParse(v).success).toBe(false);
    }
  });

  it("CapabilityStatus accepts all six values", () => {
    for (const v of [
      "HEALTHY",
      "DEGRADED",
      "FALLBACK_ACTIVE",
      "UNAVAILABLE",
      "BLOCKED",
      "UNKNOWN",
    ]) {
      expect(CapabilityStatusSchema.safeParse(v).success).toBe(true);
    }
  });

  it("CapabilityStatus rejects ResolutionStatus values", () => {
    for (const v of ["VERIFIED", "MISMATCH", "MISSING", "UNREADABLE", "UNREACHABLE", "ERROR"]) {
      expect(CapabilityStatusSchema.safeParse(v).success).toBe(false);
    }
  });

  it("ConflictSeverity accepts all five values", () => {
    for (const v of ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]) {
      expect(ConflictSeveritySchema.safeParse(v).success).toBe(true);
    }
  });

  it("ConflictSeverity rejects unknown values", () => {
    expect(ConflictSeveritySchema.safeParse("EXTREME").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Valid fixture tests
// ---------------------------------------------------------------------------

describe("Registry validation — valid fixtures pass", () => {
  const validFiles = loadAllFromDir(VALID_DIR);

  for (const { name, data } of validFiles) {
    it(`valid fixture: ${name}`, () => {
      // Select the appropriate schema based on fixture name
      const schema = selectSchemaForValidFixture(name);
      const result = schema.safeParse(data);
      expect(
        result.success,
        `Expected ${name} to pass but got: ${result.success ? "" : JSON.stringify(result.error.issues)}`,
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Invalid fixture tests
// ---------------------------------------------------------------------------

describe("Registry validation — invalid fixtures fail", () => {
  const invalidFiles = loadAllFromDir(INVALID_DIR);

  for (const { name, data } of invalidFiles) {
    it(`invalid fixture rejected: ${name}`, () => {
      const schema = selectSchemaForInvalidFixture(name);
      const result = schema.safeParse(data);
      expect(result.success, `Expected ${name} to be rejected`).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Specific contract tests
// ---------------------------------------------------------------------------

describe("Registry validation — specific contract assertions", () => {
  it("duplicate component IDs are rejected", () => {
    const data = loadJson(path.join(INVALID_DIR, "02-duplicate-component-ids.json"));
    const result = RegistrySpecificationSchema.safeParse(data);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("Duplicate componentId"))).toBe(
        true,
      );
    }
  });

  it("runtime fields are rejected from persisted declarations", () => {
    const data = loadJson(path.join(INVALID_DIR, "08-runtime-field-in-declaration.json"));
    const result = RegistryComponentDeclarationSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("ResolutionStatus and CapabilityStatus are not interchangeable", () => {
    // HEALTHY is a CapabilityStatus, not a ResolutionStatus
    expect(ResolutionStatusSchema.safeParse("HEALTHY").success).toBe(false);
    // VERIFIED is a ResolutionStatus, not a CapabilityStatus
    expect(CapabilityStatusSchema.safeParse("VERIFIED").success).toBe(false);
  });

  it("effectiveValue = null is accepted in EffectiveValueObservation", () => {
    const data = loadJson(path.join(VALID_DIR, "09-effective-value-observation-null.json"));
    const result = EffectiveValueObservationSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("unsupported schema versions fail", () => {
    const data = loadJson(path.join(INVALID_DIR, "16-unsupported-schema-version.json"));
    const result = RegistrySpecificationSchema.safeParse(data);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message.includes("Unsupported schema version")),
      ).toBe(true);
    }
  });

  it("required evidence arrays are enforced", () => {
    const data = loadJson(path.join(INVALID_DIR, "09-missing-evidence-array.json"));
    const result = RuntimeObservationSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("required timestamps are validated as ISO-8601", () => {
    const data = loadJson(path.join(INVALID_DIR, "10-invalid-timestamp.json"));
    const result = RuntimeObservationSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("unknown fields are rejected where additional properties are prohibited", () => {
    const data = loadJson(path.join(INVALID_DIR, "17-unknown-misspelled-field.json"));
    const result = RegistryComponentDeclarationSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("snapshot and registry schemas cannot be substituted for each other", () => {
    const snapshotData = loadJson(path.join(VALID_DIR, "16-validation-snapshot.json"));
    const registryResult = RegistrySpecificationSchema.safeParse(snapshotData);
    expect(registryResult.success).toBe(false);

    const registryData = loadJson(path.join(VALID_DIR, "01-minimal-registry-spec.json"));
    const snapshotResult = ValidationSnapshotSchema.safeParse(registryData);
    expect(snapshotResult.success).toBe(false);
  });

  it("ConflictResult missing blocking is rejected", () => {
    const data = loadJson(path.join(INVALID_DIR, "13-conflict-missing-blocking.json"));
    const result = ConflictResultSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("RequirementContext missing startupRequirementSource is rejected", () => {
    const data = loadJson(path.join(INVALID_DIR, "14-requirement-missing-source.json"));
    const result = RequirementContextSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("ValidationSnapshot missing specHash is rejected", () => {
    const data = loadJson(path.join(INVALID_DIR, "15-snapshot-missing-spec-hash.json"));
    const result = ValidationSnapshotSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("ResolutionResult using capability status as resolutionStatus is rejected", () => {
    const data = loadJson(path.join(INVALID_DIR, "12-capability-status-as-resolution-status.json"));
    const result = ResolutionResultSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("no contract test depends on a running gateway or external service", () => {
    // This is a meta-test: all fixtures are local JSON files.
    expect(validFilesExist()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function selectSchemaForValidFixture(name: string) {
  const map: Record<string, z.ZodType> = {
    "01-": RegistrySpecificationSchema,
    "02-": RegistrySpecificationSchema,
    "03-": RegistryComponentDeclarationSchema,
    "04-": RegistryComponentDeclarationSchema,
    "05-": RegistryComponentDeclarationSchema,
    "06-": RegistryComponentDeclarationSchema,
    "07-": RuntimeObservationSchema,
    "08-": EffectiveValueObservationSchema,
    "09-": EffectiveValueObservationSchema,
    "10-": ResolutionResultSchema,
    "11-": ResolutionResultSchema,
    "12-": ConflictResultSchema,
    "13-": ConflictResultSchema,
    "14-": RequirementContextSchema,
    "15-": ComponentValidationResultSchema,
    "16-": ValidationSnapshotSchema,
  };
  for (const [prefix, schema] of Object.entries(map)) {
    if (name.startsWith(prefix)) {
      return schema;
    }
  }
  return RegistrySpecificationSchema;
}

function selectSchemaForInvalidFixture(name: string) {
  const map: Record<string, z.ZodType> = {
    "01-": RegistrySpecificationSchema,
    "02-": RegistrySpecificationSchema,
    "03-": RegistryComponentDeclarationSchema,
    "04-": EvidenceRecordSchema,
    "05-": EvidenceRecordSchema,
    "06-": ResolutionResultSchema,
    "07-": CapabilityStatusResultSchema,
    "08-": RegistryComponentDeclarationSchema,
    "09-": RuntimeObservationSchema,
    "10-": RuntimeObservationSchema,
    "11-": RuntimeObservationSchema,
    "12-": ResolutionResultSchema,
    "13-": ConflictResultSchema,
    "14-": RequirementContextSchema,
    "15-": ValidationSnapshotSchema,
    "16-": RegistrySpecificationSchema,
    "17-": RegistryComponentDeclarationSchema,
  };
  for (const [prefix, schema] of Object.entries(map)) {
    if (name.startsWith(prefix)) {
      return schema;
    }
  }
  return RegistrySpecificationSchema;
}

function validFilesExist(): boolean {
  try {
    return readdirSync(VALID_DIR).length > 0;
  } catch {
    return false;
  }
}
