/**
 * Escalation control: prevent dangerous chains of tool calls.
 */

import type { EscalationControlResult } from "./index.js";

/**
 * Track tool call chain and enforce limits.
 */
export class EscalationTracker {
  private chainDepth: number = 0;
  private cumulativeRisk: number = 0;
  private uncertainty: number = 0;
  private maxDepth: number;
  private maxRisk: number;
  private maxUncertainty: number;

  constructor(options: {
    maxChainDepth: number;
    maxCumulativeRisk: number;
    maxUncertainty: number;
  }) {
    this.maxDepth = options.maxChainDepth;
    this.maxRisk = options.maxCumulativeRisk;
    this.maxUncertainty = options.maxUncertainty;
  }

  /**
   * Check if a tool call is allowed given current escalation state.
   */
  checkEscalation(
    depth: number,
    risk: number,
    uncertainty: number,
  ): EscalationControlResult {
    this.chainDepth = depth;
    this.cumulativeRisk += risk;
    this.uncertainty = Math.max(this.uncertainty, uncertainty);

    const allowed =
      depth <= this.maxDepth &&
      this.cumulativeRisk <= this.maxRisk &&
      this.uncertainty <= this.maxUncertainty;

    let reason: string | undefined;
    if (!allowed) {
      if (depth > this.maxDepth) {
        reason = `Chain depth ${depth} exceeds maximum ${this.maxDepth}`;
      } else if (this.cumulativeRisk > this.maxRisk) {
        reason = `Cumulative risk ${this.cumulativeRisk.toFixed(2)} exceeds maximum ${this.maxRisk}`;
      } else if (this.uncertainty > this.maxUncertainty) {
        reason = `Uncertainty ${this.uncertainty.toFixed(2)} exceeds maximum ${this.maxUncertainty}`;
      }
    }

    return {
      allowed,
      reason,
      chainDepth: depth,
      cumulativeRisk: this.cumulativeRisk,
      uncertainty: this.uncertainty,
    };
  }

  /**
   * Reset escalation state (for new session or after timeout).
   */
  reset(): void {
    this.chainDepth = 0;
    this.cumulativeRisk = 0;
    this.uncertainty = 0;
  }

  /**
   * Get current state.
   */
  getState(): {
    chainDepth: number;
    cumulativeRisk: number;
    uncertainty: number;
  } {
    return {
      chainDepth: this.chainDepth,
      cumulativeRisk: this.cumulativeRisk,
      uncertainty: this.uncertainty,
    };
  }
}
