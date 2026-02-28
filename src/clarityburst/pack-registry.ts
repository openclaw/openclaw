/**
 * Pack Registry Module
 *
 * Loads, validates, and indexes ontology packs from JSON files at startup.
 * Provides lookup by stage_id.
 *
 * FAIL-CLOSED POLICY: All pack validation failures result in deterministic
 * PACK_POLICY_INCOMPLETE errors. No silent defaults are applied.
 *
 * PRODUCTION OBSERVABILITY:
 * This module emits structured logs at 4 key points:
 * 1. Registry initialization (file discovery, validation start/end)
 * 2. Per-file read/parse/validation (success/failure + details)
 * 3. Contract field validation (missing fields + contract index)
 * 4. Runtime validation in getPackForStage() (which fields failed)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClarityBurstStageId } from "./stages.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

// Initialize logger for pack registry operations
const packRegistryLog = createSubsystemLogger("clarityburst-pack-registry");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PackThresholds {
  min_confidence_T: number;
  dominance_margin_Delta: number;
}

export interface PackContract {
  contract_id: string;
  risk_class: string;
  required_fields: string[];
  limits: Record<string, unknown>;
  needs_confirmation: boolean;
  deny_by_default: boolean;
  capability_requirements: string[];
}

export interface OntologyPack {
  pack_id: string;
  pack_version: string;
  stage_id: string;
  description?: string;
  thresholds: PackThresholds;
  contracts: PackContract[];
  field_schema: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Error code for deterministic fail-closed policy violations.
 * This error is consumed at commit points to block unsafe operations.
 */
export const PACK_POLICY_INCOMPLETE = "PACK_POLICY_INCOMPLETE" as const;

/**
 * Represents a validation failure for an ontology pack.
 * Used during pack loading for structural validation errors.
 */
export class PackValidationError extends Error {
  public readonly code = PACK_POLICY_INCOMPLETE;

  constructor(
    public readonly filePath: string,
    public readonly details: string
  ) {
    super(`Pack validation failed for "${filePath}": ${details}`);
    this.name = "PackValidationError";
  }
}

/**
 * Represents a runtime policy violation when a pack fails validation.
 * This error is thrown by getPackForStage() when a pack is structurally
 * incomplete or malformed. Consumers should treat this as a fail-closed
 * signal - no silent defaults or fallbacks should be applied.
 *
 * @example
 * try {
 *   const pack = getPackForStage("MY_STAGE");
 * } catch (err) {
 *   if (err instanceof PackPolicyIncompleteError) {
 *     // Fail closed - block the operation
 *     return { blocked: true, reason: err.message };
 *   }
 * }
 */
export class PackPolicyIncompleteError extends Error {
  public readonly code = PACK_POLICY_INCOMPLETE;

  constructor(
    public readonly stageId: string,
    public readonly missingFields: string[],
    public readonly packId?: string
  ) {
    const fieldsStr = missingFields.join(", ");
    const packInfo = packId ? ` (pack: ${packId})` : "";
    super(
      `PACK_POLICY_INCOMPLETE: Stage "${stageId}"${packInfo} failed validation. ` +
        `Missing or invalid fields: [${fieldsStr}]. ` +
        `No silent defaults applied - operation blocked.`
    );
    this.name = "PackPolicyIncompleteError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation Schema (Stage-Agnostic)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Required top-level fields for all ontology packs.
 * These are stage-agnostic - every pack must have them.
 */
const REQUIRED_PACK_FIELDS: (keyof OntologyPack)[] = [
  "pack_id",
  "pack_version",
  "stage_id",
  "contracts",
];

/**
 * Optional top-level fields that are stage-dependent.
 * Validation will check their structure if present.
 */
const OPTIONAL_PACK_FIELDS: (keyof OntologyPack)[] = [
  "thresholds",
  "field_schema",
  "description",
];

/**
 * Required fields for each contract entry.
 * FAIL-CLOSED: No silent defaults - all fields must be explicitly provided.
 */
const REQUIRED_CONTRACT_FIELDS: (keyof PackContract)[] = [
  "contract_id",
  "risk_class",
  "required_fields",
  "limits",
  "needs_confirmation",
  "deny_by_default",
  "capability_requirements", // No longer optional - must be explicit
];

/**
 * Validates a pack object against the minimal schema.
 * FAIL-CLOSED: Any missing required field throws a deterministic error.
 * No silent defaults are applied.
 *
 * @param pack - The parsed pack object to validate
 * @param filePath - Path to the pack file (for error messages)
 * @returns The validated OntologyPack
 * @throws PackValidationError if validation fails
 */
function validatePack(pack: unknown, filePath: string): OntologyPack {
  const missingFields: string[] = [];

  if (typeof pack !== "object" || pack === null) {
    throw new PackValidationError(filePath, "Pack must be a non-null object");
  }

  const packObj = pack as Record<string, unknown>;

  // Validate required top-level fields
  for (const field of REQUIRED_PACK_FIELDS) {
    if (!(field in packObj)) {
      missingFields.push(field);
    }
  }

  // Validate field types for present required fields
  if ("pack_id" in packObj && typeof packObj.pack_id !== "string") {
    missingFields.push("pack_id (must be string)");
  }
  if ("pack_version" in packObj && typeof packObj.pack_version !== "string") {
    missingFields.push("pack_version (must be string)");
  }
  if ("stage_id" in packObj && typeof packObj.stage_id !== "string") {
    missingFields.push("stage_id (must be string)");
  }

  // Validate contracts array exists and is an array
  if ("contracts" in packObj) {
    if (!Array.isArray(packObj.contracts)) {
      missingFields.push("contracts (must be array)");
    }
  }

  // Fail fast if top-level fields are missing
  if (missingFields.length > 0) {
    throw new PackValidationError(
      filePath,
      `Missing or invalid required fields: [${missingFields.join(", ")}]`
    );
  }

  // Validate thresholds structure if present
  if ("thresholds" in packObj && packObj.thresholds !== undefined) {
    if (typeof packObj.thresholds !== "object" || packObj.thresholds === null) {
      throw new PackValidationError(
        filePath,
        '"thresholds" must be an object if provided'
      );
    }
    const thresholds = packObj.thresholds as Record<string, unknown>;
    if (
      "min_confidence_T" in thresholds &&
      typeof thresholds.min_confidence_T !== "number"
    ) {
      throw new PackValidationError(
        filePath,
        '"thresholds.min_confidence_T" must be a number if provided'
      );
    }
    if (
      "dominance_margin_Delta" in thresholds &&
      typeof thresholds.dominance_margin_Delta !== "number"
    ) {
      throw new PackValidationError(
        filePath,
        '"thresholds.dominance_margin_Delta" must be a number if provided'
      );
    }
  }

  // Validate field_schema structure if present
  if ("field_schema" in packObj && packObj.field_schema !== undefined) {
    if (
      typeof packObj.field_schema !== "object" ||
      packObj.field_schema === null
    ) {
      throw new PackValidationError(
        filePath,
        '"field_schema" must be an object if provided'
      );
    }
  }

  // Validate each contract entry - NO SILENT DEFAULTS
  const contracts = packObj.contracts as unknown[];
  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i];
    const contractMissing: string[] = [];

    if (typeof contract !== "object" || contract === null) {
      throw new PackValidationError(
        filePath,
        `contracts[${i}] must be a non-null object`
      );
    }

    const contractObj = contract as Record<string, unknown>;

    // Check all required contract fields
    for (const field of REQUIRED_CONTRACT_FIELDS) {
      if (!(field in contractObj)) {
        contractMissing.push(field);
      }
    }

    if (contractMissing.length > 0) {
      packRegistryLog.error(
        "pack registry: contract validation failed",
        {
          file_path: filePath,
          contract_index: i,
          missing_fields: contractMissing,
          missing_field_count: contractMissing.length,
        }
      );
      throw new PackValidationError(
        filePath,
        `contracts[${i}] missing required fields: [${contractMissing.join(", ")}]. ` +
          `FAIL-CLOSED: No silent defaults applied.`
      );
    }

    // Validate contract field types
    if (typeof contractObj.contract_id !== "string") {
      throw new PackValidationError(
        filePath,
        `contracts[${i}].contract_id must be a string`
      );
    }
    if (typeof contractObj.risk_class !== "string") {
      throw new PackValidationError(
        filePath,
        `contracts[${i}].risk_class must be a string`
      );
    }
    if (!Array.isArray(contractObj.required_fields)) {
      throw new PackValidationError(
        filePath,
        `contracts[${i}].required_fields must be an array`
      );
    }
    if (
      typeof contractObj.limits !== "object" ||
      contractObj.limits === null
    ) {
      throw new PackValidationError(
        filePath,
        `contracts[${i}].limits must be an object`
      );
    }
    if (typeof contractObj.needs_confirmation !== "boolean") {
      throw new PackValidationError(
        filePath,
        `contracts[${i}].needs_confirmation must be a boolean`
      );
    }
    if (typeof contractObj.deny_by_default !== "boolean") {
      throw new PackValidationError(
        filePath,
        `contracts[${i}].deny_by_default must be a boolean`
      );
    }
    if (!Array.isArray(contractObj.capability_requirements)) {
      throw new PackValidationError(
        filePath,
        `contracts[${i}].capability_requirements must be an array`
      );
    }
  }

  return packObj as unknown as OntologyPack;
}

/**
 * Validates a pack object at runtime and returns validation errors.
 * Used by getPackForStage() for runtime validation.
 *
 * @param pack - The pack object to validate
 * @returns Array of missing/invalid field names, empty if valid
 */
function validatePackRuntime(pack: OntologyPack): string[] {
  const issues: string[] = [];

  // Validate required top-level fields
  if (!pack.pack_id || typeof pack.pack_id !== "string") {
    issues.push("pack_id");
  }
  if (!pack.pack_version || typeof pack.pack_version !== "string") {
    issues.push("pack_version");
  }
  if (!pack.stage_id || typeof pack.stage_id !== "string") {
    issues.push("stage_id");
  }
  if (!Array.isArray(pack.contracts)) {
    issues.push("contracts");
  }

  // Validate contracts
  if (Array.isArray(pack.contracts)) {
    for (let i = 0; i < pack.contracts.length; i++) {
      const contract = pack.contracts[i];
      if (!contract || typeof contract !== "object") {
        issues.push(`contracts[${i}]`);
        continue;
      }
      if (!contract.contract_id || typeof contract.contract_id !== "string") {
        issues.push(`contracts[${i}].contract_id`);
      }
      if (!contract.risk_class || typeof contract.risk_class !== "string") {
        issues.push(`contracts[${i}].risk_class`);
      }
      if (!Array.isArray(contract.required_fields)) {
        issues.push(`contracts[${i}].required_fields`);
      }
      if (!contract.limits || typeof contract.limits !== "object") {
        issues.push(`contracts[${i}].limits`);
      }
      if (typeof contract.needs_confirmation !== "boolean") {
        issues.push(`contracts[${i}].needs_confirmation`);
      }
      if (typeof contract.deny_by_default !== "boolean") {
        issues.push(`contracts[${i}].deny_by_default`);
      }
      if (!Array.isArray(contract.capability_requirements)) {
        issues.push(`contracts[${i}].capability_requirements`);
      }
    }
  }

  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

const packsByStageId: Map<string, OntologyPack> = new Map();
let registryInitialized = false;

function getPacksDirectory(): string {
  // ESM-compatible way to get __dirname
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, "../ontology-packs");
}

function loadAllPacks(): void {
  const packsDir = getPacksDirectory();

  if (!fs.existsSync(packsDir)) {
    throw new Error(
      `Ontology packs directory not found: "${packsDir}". ` +
        `Ensure the directory exists and contains valid JSON pack files.`
    );
  }

  const files = fs
    .readdirSync(packsDir)
    .filter((f: string) => f.endsWith(".json"));

  if (files.length === 0) {
    throw new Error(
      `No JSON pack files found in "${packsDir}". ` +
        `Add at least one valid ontology pack file.`
    );
  }

  packRegistryLog.info("pack registry: initializing", { file_count: files.length, packs_dir: packsDir });

  for (const file of files) {
    const filePath = path.join(packsDir, file);
    let rawContent: string;

    try {
      rawContent = fs.readFileSync(filePath, "utf-8");
      packRegistryLog.debug("pack registry: file read success", { file });
    } catch (err) {
      packRegistryLog.error(
        "pack registry: file read failed",
        {
          file,
          filePath,
          error: err instanceof Error ? err.message : String(err),
        }
      );
      throw new Error(
        `Failed to read pack file "${filePath}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
      packRegistryLog.debug("pack registry: JSON parse success", { file });
    } catch (err) {
      packRegistryLog.error(
        "pack registry: JSON parse failed",
        {
          file,
          filePath,
          error: err instanceof Error ? err.message : String(err),
        }
      );
      throw new Error(
        `Failed to parse JSON in pack file "${filePath}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    const validatedPack = validatePack(parsed, filePath);
    packRegistryLog.debug(
      "pack registry: validation success",
      {
        file,
        pack_id: validatedPack.pack_id,
        stage_id: validatedPack.stage_id,
        contract_count: validatedPack.contracts.length,
      }
    );

    if (packsByStageId.has(validatedPack.stage_id)) {
      const existing = packsByStageId.get(validatedPack.stage_id)!;
      packRegistryLog.error(
        "pack registry: duplicate stage_id",
        {
          stage_id: validatedPack.stage_id,
          new_pack_id: validatedPack.pack_id,
          existing_pack_id: existing.pack_id,
        }
      );
      throw new Error(
        `Duplicate stage_id "${validatedPack.stage_id}" found. ` +
          `Pack "${validatedPack.pack_id}" conflicts with "${existing.pack_id}".`
      );
    }

    packsByStageId.set(validatedPack.stage_id, validatedPack);
  }

  packRegistryLog.info(
    "pack registry: initialization complete",
    {
      total_files: files.length,
      loaded_packs: packsByStageId.size,
    }
  );
  registryInitialized = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialization (runs at module load)
// ─────────────────────────────────────────────────────────────────────────────

loadAllPacks();

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the ontology pack for the given stage_id.
 *
 * FAIL-CLOSED BEHAVIOR: This function performs runtime validation on the
 * retrieved pack. If the pack fails validation (missing required fields,
 * invalid types, etc.), a PackPolicyIncompleteError is thrown with
 * deterministic error details. No silent defaults are applied.
 *
 * @param stage_id - The stage identifier to look up
 * @returns The OntologyPack object for the requested stage
 * @throws Error if the stage_id is not found
 * @throws PackPolicyIncompleteError if the pack fails runtime validation
 *
 * @example
 * try {
 *   const pack = getPackForStage("TOOL_DISPATCH_GATE");
 * } catch (err) {
 *   if (err instanceof PackPolicyIncompleteError) {
 *     // FAIL-CLOSED: Block operation, return deterministic error
 *     console.error(`Blocked: ${err.code} - ${err.missingFields}`);
 *   }
 * }
 */
export function getPackForStage(stage_id: string): OntologyPack {
  if (!registryInitialized) {
    throw new Error(
      "Pack registry not initialized. This should not happen - packs load at module import."
    );
  }

  const pack = packsByStageId.get(stage_id);

  if (!pack) {
    const availableStages = Array.from(packsByStageId.keys()).sort();
    packRegistryLog.error(
      "pack registry: stage_id not found",
      {
        requested_stage_id: stage_id,
        available_stages: availableStages,
      }
    );
    throw new Error(
      `Unknown stage_id "${stage_id}". ` +
        `Available stage_ids are: [${availableStages.join(", ")}]`
    );
  }

  // Runtime validation - FAIL-CLOSED
  const validationIssues = validatePackRuntime(pack);
  if (validationIssues.length > 0) {
    packRegistryLog.error(
      "pack registry: runtime validation failed",
      {
        stage_id,
        pack_id: pack.pack_id,
        failed_fields: validationIssues,
        field_count: validationIssues.length,
      }
    );
    throw new PackPolicyIncompleteError(
      stage_id,
      validationIssues,
      pack.pack_id
    );
  }

  packRegistryLog.debug(
    "pack registry: pack loaded successfully",
    {
      stage_id,
      pack_id: pack.pack_id,
      contract_count: pack.contracts.length,
    }
  );
  return pack;
}

/**
 * Validates a raw pack object (for testing or dynamic pack loading).
 *
 * FAIL-CLOSED BEHAVIOR: Returns a validated OntologyPack or throws
 * PackPolicyIncompleteError with deterministic error details.
 *
 * @param rawPack - The raw pack object to validate
 * @param sourcePath - Optional source path for error messages
 * @returns The validated OntologyPack
 * @throws PackPolicyIncompleteError if validation fails
 */
export function validatePackObject(
  rawPack: unknown,
  sourcePath: string = "<dynamic>"
): OntologyPack {
  try {
    return validatePack(rawPack, sourcePath);
  } catch (err) {
    if (err instanceof PackValidationError) {
      // Extract the stage_id if present for better error messages
      const packObj = rawPack as Record<string, unknown> | null;
      const stageId =
        packObj && typeof packObj === "object" && "stage_id" in packObj
          ? String(packObj.stage_id)
          : "<unknown>";
      const packId =
        packObj && typeof packObj === "object" && "pack_id" in packObj
          ? String(packObj.pack_id)
          : undefined;

      throw new PackPolicyIncompleteError(stageId, [err.details], packId);
    }
    throw err;
  }
}

/**
 * Returns all available stage_ids in the registry.
 *
 * @returns Array of stage_id strings
 */
export function getAvailableStageIds(): string[] {
  return Array.from(packsByStageId.keys()).sort();
}

/**
 * Returns the total number of loaded packs.
 *
 * @returns Number of packs in the registry
 */
export function getPackCount(): number {
  return packsByStageId.size;
}
