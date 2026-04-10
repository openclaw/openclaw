// Octopus Orchestrator -- PolicyService (M5-01)
//
// Resolves policy profiles by adapter/agent/node and answers
// allow/deny/escalate decisions. When enforcementActive is false,
// check() always returns allow but logs the decision it would have made.
//
// Boundary discipline (OCTO-DEC-033):
//   imports limited to sibling modules and node:* builtins; no imports
//   from src/infra/** or other OpenClaw internals.
//
// Cross-references:
//   - LLD.md SS PolicyService, SS Policy Enforcement Timeline
//   - CONFIG.md SS octo.policy
//   - schema.ts OctoPolicyConfigSchema

import type { OctoPolicyConfig } from "../config/schema.ts";
import type { OctoLogger } from "./logging.ts";

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface PolicyProfile {
  name: string;
  allowedTools: string[];
  deniedTools: string[];
  maxCostUsd?: number;
  sandboxLevel?: string;
}

export type PolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string; ruleId: string }
  | { decision: "escalate"; reason: string };

// ---------------------------------------------------------------------------
// PolicyService
// ---------------------------------------------------------------------------

export class PolicyService {
  private readonly config: OctoPolicyConfig;
  private readonly profiles: Map<string, PolicyProfile>;
  private readonly logger: OctoLogger;

  constructor(config: OctoPolicyConfig, profiles: Map<string, PolicyProfile>, logger: OctoLogger) {
    this.config = config;
    this.profiles = profiles;
    this.logger = logger;
  }

  /**
   * Resolve the effective PolicyProfile for a given adapter/agent/node
   * combination. Falls back to the config's defaultProfileRef, then to
   * the first profile in the map, then to a permissive built-in default.
   */
  resolve(_adapterType: string, _agentId: string, _nodeId: string): PolicyProfile {
    // Future: look up overrides by adapter/agent/node. For M5-01 the
    // resolution chain is: defaultProfileRef -> first profile -> fallback.
    const ref = this.config.defaultProfileRef;
    if (ref !== null) {
      const profile = this.profiles.get(ref);
      if (profile !== undefined) {
        return profile;
      }
      this.logger.warn("defaultProfileRef not found in profiles map", {
        ref,
      });
    }

    // Return first profile if available.
    const first = this.profiles.values().next();
    if (!first.done) {
      return first.value;
    }

    // Permissive built-in fallback.
    return {
      name: "__default__",
      allowedTools: [],
      deniedTools: [],
    };
  }

  /**
   * Evaluate whether `action` is permitted under the given profile.
   *
   * When `config.enforcementActive` is false the method always returns
   * `{ decision: "allow" }` but logs the decision that would have been
   * made so operators can audit before flipping enforcement on.
   */
  check(action: string, profile: PolicyProfile, context?: Record<string, unknown>): PolicyDecision {
    const computed = this.evaluate(action, profile, context);

    if (!this.config.enforcementActive) {
      if (computed.decision !== "allow") {
        this.logger.info("policy decision suppressed (enforcement off)", {
          action,
          profile: profile.name,
          wouldHave: computed,
        });
      }
      return { decision: "allow" };
    }

    if (computed.decision !== "allow") {
      this.logger.warn("policy decision enforced", {
        action,
        profile: profile.name,
        decision: computed,
      });
    }

    return computed;
  }

  // -----------------------------------------------------------------------
  // Internal evaluation (pure logic, no enforcement gate)
  // -----------------------------------------------------------------------

  private evaluate(
    action: string,
    profile: PolicyProfile,
    context?: Record<string, unknown>,
  ): PolicyDecision {
    // 1. Explicit deny list takes priority.
    if (profile.deniedTools.includes(action)) {
      return {
        decision: "deny",
        reason: `action "${action}" is on the denied list for profile "${profile.name}"`,
        ruleId: "denied-tool",
      };
    }

    // 2. If an allow-list is non-empty, the action must appear in it.
    if (profile.allowedTools.length > 0 && !profile.allowedTools.includes(action)) {
      return {
        decision: "deny",
        reason: `action "${action}" is not on the allowed list for profile "${profile.name}"`,
        ruleId: "not-allowed-tool",
      };
    }

    // 3. Cost ceiling check.
    if (profile.maxCostUsd !== undefined && context !== undefined) {
      const cost = context["costUsd"];
      if (typeof cost === "number" && cost > profile.maxCostUsd) {
        return {
          decision: "escalate",
          reason: `cost $${String(cost)} exceeds ceiling $${String(profile.maxCostUsd)} for profile "${profile.name}"`,
        };
      }
    }

    return { decision: "allow" };
  }
}
