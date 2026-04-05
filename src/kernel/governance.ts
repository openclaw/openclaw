/**
 * Mullusi Φ Governance Filter
 *
 * Fail-closed governance gate.  Every action — skill execution, tool
 * invocation, memory write, outbound message — must pass through Φ before
 * proceeding.  If any constraint is violated the action is REJECTED and
 * the rejection is hash-chain logged.
 *
 * Design principles:
 *   1. Fail-closed: if validation cannot determine safety, reject.
 *   2. Deterministic: same input → same verdict (no LLM in the loop).
 *   3. Auditable: every decision is hash-chain logged.
 *   4. Mfidel-atomic: no fidel decomposition in any symbolic operation.
 */

import type { HashChainLedger } from "./hash-chain.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GovernanceVerdict = "allow" | "deny";

export interface GovernanceDecision {
  verdict: GovernanceVerdict;
  /** Human-readable reason when denied. */
  reason: string;
  /** Constraint IDs that were evaluated. */
  constraints: string[];
  /** Timestamp of the decision. */
  ts: string;
}

export interface GovernanceConstraint {
  /** Unique constraint identifier (e.g. "skill:allowed-tools"). */
  id: string;
  /** Evaluate the constraint.  Return null to abstain, or a reason string to deny. */
  evaluate(ctx: GovernanceContext): string | null;
}

export interface GovernanceContext {
  /** The domain being governed. */
  domain: "skill" | "tool" | "memory" | "message" | "config";
  /** Action being attempted. */
  action: string;
  /** Actor identifier (session, agent, user). */
  actor: string;
  /** Arbitrary metadata for constraint evaluation. */
  meta: Record<string, unknown>;
}

export interface GovernanceGate {
  /** Register a constraint. */
  addConstraint(constraint: GovernanceConstraint): void;
  /** Remove a constraint by ID. */
  removeConstraint(id: string): void;
  /** Evaluate all constraints against a context.  Fail-closed. */
  evaluate(ctx: GovernanceContext): GovernanceDecision;
  /** Return all registered constraint IDs. */
  constraints(): string[];
}

// ---------------------------------------------------------------------------
// Built-in constraints
// ---------------------------------------------------------------------------

/**
 * Rejects any skill execution that uses tools not in the skill's allowed-tools list.
 */
export function allowedToolsConstraint(): GovernanceConstraint {
  return {
    id: "skill:allowed-tools",
    evaluate(ctx) {
      if (ctx.domain !== "skill") return null;
      const allowedTools = ctx.meta["allowedTools"] as string[] | undefined;
      const requestedTool = ctx.meta["tool"] as string | undefined;
      if (!allowedTools || !requestedTool) return null;
      if (!allowedTools.includes(requestedTool)) {
        return `Tool "${requestedTool}" not in allowed-tools [${allowedTools.join(", ")}]`;
      }
      return null;
    },
  };
}

/**
 * Rejects actions from actors without sufficient authority level.
 */
export function authorityLevelConstraint(minLevel: number): GovernanceConstraint {
  return {
    id: "actor:authority-level",
    evaluate(ctx) {
      const level = (ctx.meta["authorityLevel"] as number) ?? 0;
      if (level < minLevel) {
        return `Authority level ${level} below minimum ${minLevel}`;
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Gate implementation
// ---------------------------------------------------------------------------

export function createGovernanceGate(ledger: HashChainLedger): GovernanceGate {
  const registry = new Map<string, GovernanceConstraint>();

  return {
    addConstraint(constraint) {
      registry.set(constraint.id, constraint);
      ledger.append("governance", "constraint:register", { id: constraint.id });
    },

    removeConstraint(id) {
      registry.delete(id);
      ledger.append("governance", "constraint:remove", { id });
    },

    evaluate(ctx) {
      const ts = new Date().toISOString();
      const evaluatedIds: string[] = [];

      // Fail-closed: wrap entire evaluation in try/catch
      try {
        for (const [id, constraint] of registry) {
          evaluatedIds.push(id);
          const denial = constraint.evaluate(ctx);
          if (denial !== null) {
            const decision: GovernanceDecision = {
              verdict: "deny",
              reason: denial,
              constraints: evaluatedIds,
              ts,
            };
            ledger.append("governance", "decision:deny", {
              ctx: { domain: ctx.domain, action: ctx.action, actor: ctx.actor },
              decision,
            });
            return decision;
          }
        }

        const decision: GovernanceDecision = {
          verdict: "allow",
          reason: "",
          constraints: evaluatedIds,
          ts,
        };
        ledger.append("governance", "decision:allow", {
          ctx: { domain: ctx.domain, action: ctx.action, actor: ctx.actor },
          constraintCount: evaluatedIds.length,
        });
        return decision;
      } catch (err) {
        // Fail-closed: any error → deny
        const decision: GovernanceDecision = {
          verdict: "deny",
          reason: `Governance evaluation error: ${err instanceof Error ? err.message : String(err)}`,
          constraints: evaluatedIds,
          ts,
        };
        ledger.append("governance", "decision:error-deny", {
          ctx: { domain: ctx.domain, action: ctx.action, actor: ctx.actor },
          error: String(err),
        });
        return decision;
      }
    },

    constraints() {
      return [...registry.keys()];
    },
  };
}
