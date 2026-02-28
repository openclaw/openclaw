/**
 * Allowed Contracts Derivation Module
 *
 * Derives the set of allowed contract IDs based on runtime capabilities
 * and stage-specific filtering rules.
 */

import type { OntologyPack, PackContract } from "./pack-registry";
import type { ClarityBurstStageId } from "./stages";
import { ClarityBurstAbstainError } from "./errors";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runtime capabilities that control which contracts are allowed.
 */
export interface RuntimeCapabilities {
  /** Whether browser automation tools are enabled */
  browserEnabled: boolean;
  /** Whether shell/process execution is enabled */
  shellEnabled: boolean;
  /** Whether filesystem write/delete operations are enabled */
  fsWriteEnabled: boolean;
  /** Whether network I/O operations are enabled */
  networkEnabled: boolean;
  /** Whether to explicitly allow CRITICAL deny_by_default contracts */
  explicitlyAllowCritical: boolean;
  /** Whether sensitive data access is enabled */
  sensitiveAccessEnabled: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability Requirement Mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps capability requirement strings to RuntimeCapabilities property names.
 */
const CAPABILITY_REQUIREMENT_MAP: Record<string, keyof RuntimeCapabilities> = {
  browser: "browserEnabled",
  shell: "shellEnabled",
  network: "networkEnabled",
  fs_write: "fsWriteEnabled",
  critical_opt_in: "explicitlyAllowCritical",
  sensitive_access: "sensitiveAccessEnabled",
};

/**
 * Checks if all capability requirements of a contract are satisfied by the runtime capabilities.
 *
 * @param contract - The contract to check
 * @param caps - The runtime capabilities
 * @returns true if all requirements are satisfied, false otherwise
 */
function areCapabilityRequirementsSatisfied(
  contract: PackContract,
  caps: RuntimeCapabilities
): boolean {
  for (const requirement of contract.capability_requirements) {
    const capKey = CAPABILITY_REQUIREMENT_MAP[requirement];
    if (capKey === undefined) {
      // Unknown requirement - treat as unsatisfied for safety
      return false;
    }
    if (!caps[capKey]) {
      return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL_DISPATCH_GATE Specific Logic
// ─────────────────────────────────────────────────────────────────────────────

function deriveAllowedForToolDispatchGate(
  pack: OntologyPack,
  caps: RuntimeCapabilities
): string[] {
  const allowed: string[] = [];

  for (const contract of pack.contracts) {
    const { contract_id, risk_class, deny_by_default } = contract;

    // Always exclude deny_by_default CRITICAL contracts unless critical_opt_in is satisfied
    if (
      risk_class === "CRITICAL" &&
      deny_by_default &&
      !caps.explicitlyAllowCritical
    ) {
      continue;
    }

    // Filter by capability_requirements: all requirements must be satisfied
    if (!areCapabilityRequirementsSatisfied(contract, caps)) {
      continue;
    }

    allowed.push(contract_id);
  }

  return allowed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Logic (for all other stages)
// ─────────────────────────────────────────────────────────────────────────────

function deriveAllowedForDefaultStage(
  pack: OntologyPack,
  caps: RuntimeCapabilities
): string[] {
  const allowed: string[] = [];

  for (const contract of pack.contracts) {
    const { contract_id, risk_class, deny_by_default } = contract;

    // Exclude deny_by_default CRITICAL contracts unless explicitly allowed
    if (
      risk_class === "CRITICAL" &&
      deny_by_default &&
      !caps.explicitlyAllowCritical
    ) {
      continue;
    }

    allowed.push(contract_id);
  }

  return allowed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derives the list of allowed contract IDs for a given stage based on
 * the pack definition and runtime capabilities.
 *
 * @param stageId - The stage identifier
 * @param pack - The ontology pack for the stage
 * @param caps - Runtime capabilities that control filtering
 * @returns Array of allowed contract_id strings
 *
 * @example
 * ```ts
 * const pack = getPackForStage("TOOL_DISPATCH_GATE");
 * const caps: RuntimeCapabilities = {
 *   browserEnabled: false,
 *   shellEnabled: true,
 *   fsWriteEnabled: true,
 *   networkEnabled: true,
 *   explicitlyAllowCritical: false,
 * };
 * const allowed = deriveAllowedContracts("TOOL_DISPATCH_GATE", pack, caps);
 * ```
 */
export function deriveAllowedContracts(
  stageId: string,
  pack: OntologyPack,
  caps: RuntimeCapabilities
): string[] {
  if (stageId === "TOOL_DISPATCH_GATE") {
    return deriveAllowedForToolDispatchGate(pack, caps);
  }

  // For all other stages, use default logic
  return deriveAllowedForDefaultStage(pack, caps);
}

/**
 * Creates a RuntimeCapabilities object with all capabilities enabled.
 * Useful as a baseline for tests or unrestricted environments.
 */
export function createFullCapabilities(): RuntimeCapabilities {
  return {
    browserEnabled: true,
    shellEnabled: true,
    fsWriteEnabled: true,
    networkEnabled: true,
    explicitlyAllowCritical: false,
    sensitiveAccessEnabled: true,
  };
}

/**
 * Creates a RuntimeCapabilities object with all capabilities disabled.
 * Useful for highly restricted sandboxed environments.
 */
export function createRestrictedCapabilities(): RuntimeCapabilities {
  return {
    browserEnabled: false,
    shellEnabled: false,
    fsWriteEnabled: false,
    networkEnabled: false,
    explicitlyAllowCritical: false,
    sensitiveAccessEnabled: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime Invariant: Non-Empty Allowed Contracts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Asserts that the allowed contract IDs array is non-empty.
 *
 * INVARIANT: Empty allowedContractIds means capabilities deny everything (or the
 * pack/cap mapping is broken). In that state:
 * - Routing results are meaningless (router can't pick a permitted contract)
 * - "fail-open only on mismatch" must not accidentally trigger
 * - The correct response is deterministic: clarify/block, not attempt
 *
 * @param stageId - The stage identifier for error context
 * @param allowedContractIds - The array of allowed contract IDs to validate
 * @throws ClarityBurstAbstainError with ABSTAIN_CLARIFY/PACK_POLICY_INCOMPLETE if empty
 *
 * @example
 * ```ts
 * const allowedContractIds = deriveAllowedContracts(stageId, pack, caps);
 * assertNonEmptyAllowedContracts(stageId, allowedContractIds);
 * // Safe to proceed with routing
 * ```
 */
export function assertNonEmptyAllowedContracts(
  stageId: ClarityBurstStageId,
  allowedContractIds: string[]
): void {
  if (allowedContractIds.length === 0) {
    throw new ClarityBurstAbstainError({
      stageId,
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: "No contracts permitted by current capability set; cannot proceed.",
    });
  }
}
