/**
 * Mullusi Φ Governance Gate for Inbound Messages
 *
 * Evaluates every inbound message through the Φ governance filter before
 * it reaches the agent dispatch pipeline.
 *
 * Design:
 *   - Fail-closed: if evaluation errors, the message is rejected.
 *   - Deterministic: no LLM in the governance loop.
 *   - Auditable: every decision is hash-chain logged.
 *   - Singleton ledger per process (shared across all sessions).
 */

import {
  createGovernanceGate,
  allowedToolsConstraint,
  type GovernanceGate,
  type GovernanceDecision,
} from "../kernel/governance.js";
import { createHashChainLedger, type HashChainLedger } from "../kernel/hash-chain.js";
import type { FinalizedMsgContext } from "./templating.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GovernanceFilterResult {
  verdict: "allow" | "deny";
  reason: string;
  /** Hash of the governance decision entry. */
  hash: string;
}

// ---------------------------------------------------------------------------
// Singleton instances (per process)
// ---------------------------------------------------------------------------

let _ledger: HashChainLedger | undefined;
let _gate: GovernanceGate | undefined;

export function getGovernanceLedger(): HashChainLedger {
  if (!_ledger) {
    _ledger = createHashChainLedger();
  }
  return _ledger;
}

export function getGovernanceGate(): GovernanceGate {
  if (!_gate) {
    _gate = createGovernanceGate(getGovernanceLedger());
    // Register built-in constraints
    _gate.addConstraint(allowedToolsConstraint());
  }
  return _gate;
}

/**
 * Reset singletons (for testing only).
 */
export function resetGovernanceSingletons(): void {
  _ledger = undefined;
  _gate = undefined;
}

// ---------------------------------------------------------------------------
// Inbound message evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate an inbound message through the Φ governance filter.
 *
 * Currently allows all well-formed messages (the constraint set will grow
 * as Phase 6+ adds SCCE, DMRS, and deeper symbolic constraints).
 *
 * The key guarantee: every inbound message is hash-chain logged regardless
 * of whether it is allowed or denied.
 */
export function evaluateInboundGovernance(ctx: FinalizedMsgContext): GovernanceFilterResult {
  const gate = getGovernanceGate();
  const ledger = getGovernanceLedger();

  const decision: GovernanceDecision = gate.evaluate({
    domain: "message",
    action: "inbound",
    actor: ctx.SenderId ?? ctx.From ?? "unknown",
    meta: {
      from: ctx.From,
      sessionKey: ctx.SessionKey,
      hasMedia: Boolean(ctx.MediaPaths?.length),
      bodyLength: ctx.Body?.length ?? 0,
    },
  });

  return {
    verdict: decision.verdict,
    reason: decision.reason,
    hash: ledger.head()?.hash ?? "",
  };
}
