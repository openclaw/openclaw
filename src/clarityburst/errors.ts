/**
 * ClarityBurst Error Types
 *
 * This module defines error types for the ClarityBurst gating system.
 * These errors are used to signal when gated operations require confirmation
 * or clarification before proceeding.
 *
 * ARCHITECTURAL NOTE: This module is part of the foundational clarityburst layer.
 * It MUST NOT import from agents/ to maintain dependency-downward architecture.
 */

import type { ClarityBurstStageId } from "./stages";
import type { AbstainReason } from "./decision-override";

// Re-export for convenience
export type { AbstainReason } from "./decision-override";

/**
 * Error thrown when ClarityBurst gating requires confirmation or clarification
 * before a gated operation can proceed.
 *
 * This error is thrown by gating wrappers when:
 * - A contract requires user confirmation (ABSTAIN_CONFIRM)
 * - Router uncertainty is too high (ABSTAIN_CLARIFY)
 * - Pack policy is incomplete (ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE)
 *
 * Callers should catch this error and:
 * 1. Present the instructions to the user
 * 2. Obtain the required confirmation/clarification
 * 3. Retry the operation with the confirmation token
 */
export class ClarityBurstAbstainError extends Error {
  readonly stageId: ClarityBurstStageId;
  readonly outcome: "ABSTAIN_CONFIRM" | "ABSTAIN_CLARIFY";
  /** Reason for the abstain - uses centralized type from decision-override.ts */
  readonly reason: AbstainReason;
  readonly contractId: string | null;
  readonly instructions: string;

  constructor(opts: {
    stageId?: ClarityBurstStageId;
    outcome: "ABSTAIN_CONFIRM" | "ABSTAIN_CLARIFY";
    reason: AbstainReason;
    contractId: string | null;
    instructions: string;
  }) {
    const stageId = opts.stageId ?? "SHELL_EXEC";
    const stageLabel =
      stageId === "FILE_SYSTEM_OPS"
        ? "file system operation"
        : stageId === "NETWORK_IO"
          ? "network operation"
          : "shell execution";
    const message =
      opts.outcome === "ABSTAIN_CONFIRM"
        ? `ClarityBurst: confirmation required before ${stageLabel}`
        : `ClarityBurst: clarification required before ${stageLabel}`;
    super(message);
    this.name = "ClarityBurstAbstainError";
    this.stageId = stageId;
    this.outcome = opts.outcome;
    this.reason = opts.reason;
    this.contractId = opts.contractId;
    this.instructions = opts.instructions;
    // Ensure prototype chain is correct for instanceof checks
    Object.setPrototypeOf(this, ClarityBurstAbstainError.prototype);
  }
}
