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
  /** Whether this error is non-retryable (defaults to false for backwards compatibility) */
  readonly nonRetryable: boolean;

  constructor(opts: {
    stageId?: ClarityBurstStageId;
    outcome: "ABSTAIN_CONFIRM" | "ABSTAIN_CLARIFY";
    reason: AbstainReason;
    contractId: string | null;
    instructions: string;
    nonRetryable?: boolean;
  }) {
    const stageId = opts.stageId ?? "SHELL_EXEC";
    // Map every known stage to a human-readable label so that errors from
    // MEMORY_MODIFY, SUBAGENT_SPAWN, etc. are not misreported as "shell execution".
    // Previously only FILE_SYSTEM_OPS and NETWORK_IO were mapped; everything else
    // fell through to "shell execution", making it impossible to identify which
    // gate was actually firing from the error message alone.
    const stageLabel =
      stageId === "FILE_SYSTEM_OPS"
        ? "file system operation"
        : stageId === "NETWORK_IO"
          ? "network operation"
          : stageId === "MEMORY_MODIFY"
            ? "memory modification"
            : stageId === "SUBAGENT_SPAWN"
              ? "subagent spawn"
              : stageId === "CRON_SCHEDULE"
                ? "cron schedule"
                : stageId === "NODE_INVOKE"
                  ? "node invocation"
                  : stageId === "BROWSER_AUTOMATE"
                    ? "browser automation"
                    : stageId === "MESSAGE_EMIT"
                      ? "message emit"
                      : stageId === "MEDIA_GENERATE"
                        ? "media generation"
                        : stageId === "CANVAS_UI"
                          ? "canvas UI"
                          : stageId === "TOOL_DISPATCH_GATE"
                            ? "tool dispatch"
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
    this.nonRetryable = opts.nonRetryable ?? false;
    // Ensure prototype chain is correct for instanceof checks
    Object.setPrototypeOf(this, ClarityBurstAbstainError.prototype);
  }
}
