/**
 * Pack Load Helper Module
 *
 * Provides a helper function that wraps getPackForStage() with deterministic
 * error conversion for PackPolicyIncompleteError → ClarityBurstAbstainError.
 *
 * This module provides a single point for pack loading with consistent error
 * handling across all gating wrappers.
 *
 * ARCHITECTURAL NOTE: This module is part of the foundational clarityburst layer.
 * It MUST NOT import from agents/ to maintain dependency-downward architecture.
 */

import { ClarityBurstAbstainError } from "./errors";
import {
  getPackForStage,
  PackPolicyIncompleteError,
  type OntologyPack,
} from "./pack-registry";
import type { ClarityBurstStageId } from "./stages";

/**
 * Loads an ontology pack for the given stage, converting PackPolicyIncompleteError
 * to ClarityBurstAbstainError with deterministic fields.
 *
 * INVARIANT: PackPolicyIncompleteError is always converted to ClarityBurstAbstainError
 * with { outcome:"ABSTAIN_CLARIFY", reason:"PACK_POLICY_INCOMPLETE", contractId:null }.
 * This ensures a malformed pack causes a blocked nonRetryable response (not an
 * unhandled exception).
 *
 * NO SIDE EFFECTS: This function only performs pack loading and validation.
 * It does not modify any state or call external services.
 *
 * @param stageId - The stage identifier to load the pack for
 * @returns The validated OntologyPack for the requested stage
 * @throws ClarityBurstAbstainError if the pack fails validation (PACK_POLICY_INCOMPLETE)
 * @throws Error if the stage_id is unknown (re-thrown from getPackForStage)
 *
 * @example
 * // In a gating wrapper:
 * const pack = loadPackOrAbstain("NETWORK_IO");
 * // If pack is malformed, ClarityBurstAbstainError is thrown automatically
 * // with deterministic { outcome, reason, contractId, instructions }
 */
export function loadPackOrAbstain(stageId: ClarityBurstStageId): OntologyPack {
  let pack: OntologyPack;

  try {
    pack = getPackForStage(stageId);
  } catch (err) {
    if (err instanceof PackPolicyIncompleteError) {
      throw new ClarityBurstAbstainError({
        stageId,
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
        instructions:
          `Pack validation failed for stage "${stageId}": ${err.message}. ` +
          `Missing or invalid fields: [${err.missingFields.join(", ")}]. ` +
          `The operation cannot proceed until the pack is corrected.`,
      });
    }
    // Re-throw unexpected errors (e.g., unknown stage_id)
    throw err;
  }

  // CROSS-FILE INTEGRITY INVARIANT:
  // A pack loaded for stage X must actually declare itself as stage X.
  // This prevents registry/filename mismatch attacks where a pack file is
  // stored under one stage_id but internally declares a different one.
  if (pack.stage_id !== stageId) {
    throw new ClarityBurstAbstainError({
      stageId,
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions:
        `Pack stage_id mismatch: requested "${stageId}" but pack declares "${pack.stage_id}". ` +
        `The pack file may be misconfigured or stored under the wrong stage_id. ` +
        `The operation cannot proceed until the pack is corrected.`,
    });
  }

  return pack;
}
