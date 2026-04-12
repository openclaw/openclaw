// RI-014 — Skill analytics emitter
//
// Async, fire-and-forget POST to the Quinn-Co marketplace analytics
// endpoint. Records one skill invocation with variant + experiment
// attribution so the A/B framework (experiment-service.ts in Quinn-Co)
// has real data to aggregate.
//
// Design goals:
//   - NEVER block or throw in the caller's hot path. All failures are
//     swallowed with a single debug log per failure type.
//   - Take a plain fetch function as a dep so the whole thing is
//     unit-testable without spinning up a server.
//   - Accept an optional ExperimentAssigner so the runtime can look up
//     the current variant from the marketplace service without wiring
//     any HTTP dep at this level.
//
// Wired from user-invocable skill command dispatch (the chokepoint where
// we actually know a specific skill ran). Extending to other skill-use
// signals is a follow-up; the emitter API is stable.

import { createSubsystemLogger } from "../../logging/subsystem.js";

const logger = createSubsystemLogger("agents/skill-analytics");

export interface SkillInvocationEvent {
  skillId: string;
  orgId: string;
  agentId: string;
  department: string;
  tokensConsumed: number;
  responseMs: number;
  error: boolean;
  variantId?: string;
  experimentId?: string | null;
  skillVersion?: string;
  approved?: boolean | null;
  tokenCostUsd?: number;
}

export interface SkillAnalyticsEmitterConfig {
  /** Full URL to POST to. Typically `${marketplaceBaseUrl}/analytics/record`. */
  endpoint: string;
  /** Bearer token — service key or admin key. */
  authToken: string;
  /** Defaults to globalThis.fetch. Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Timeout in ms. Defaults to 2000. Emitter never blocks longer than this. */
  timeoutMs?: number;
}

export interface ExperimentAssigner {
  /**
   * Resolve the variant assignment for a given (org, skill). Used by the
   * emitter to tag telemetry before posting. Returning null means "no
   * experiment / control" — the emitter will still send an event but
   * without variant attribution.
   */
  assign(input: {
    orgId: string;
    skillId: string;
    pinnedVariant?: string | null;
  }): Promise<{
    variant_id: string;
    skill_version: string;
    experiment_id: string | null;
    is_control: boolean;
  } | null>;
}

export class SkillAnalyticsEmitter {
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  /** Track emit failures so we don't flood logs. */
  private failureCounts: Map<string, number> = new Map();

  constructor(
    private config: SkillAnalyticsEmitterConfig,
    private assigner?: ExperimentAssigner,
  ) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = config.timeoutMs ?? 2000;
  }

  /**
   * Emit one invocation. Never throws. Returns a promise that resolves
   * once the POST completes or the timeout fires — callers may await it
   * in tests, but in production should kick it off without awaiting.
   */
  async emit(event: SkillInvocationEvent): Promise<void> {
    try {
      // Resolve variant if an assigner is provided AND the caller didn't
      // already set a variant. This lets user code short-circuit when it
      // already knows the variant (e.g. pinned installs).
      let variantId = event.variantId;
      let experimentId = event.experimentId ?? null;
      let skillVersion = event.skillVersion;

      if (!variantId && this.assigner) {
        try {
          const assigned = await this.assigner.assign({
            orgId: event.orgId,
            skillId: event.skillId,
          });
          if (assigned && !assigned.is_control) {
            variantId = assigned.variant_id;
            experimentId = assigned.experiment_id;
            skillVersion = skillVersion ?? assigned.skill_version;
          } else {
            variantId = "control";
          }
        } catch (err) {
          this.recordFailure("assign", err);
          variantId = "control";
        }
      }

      const body = {
        skill_id: event.skillId,
        org_id: event.orgId,
        agent_id: event.agentId,
        department: event.department,
        tokens_consumed: event.tokensConsumed,
        response_ms: event.responseMs,
        error: event.error,
        variant_id: variantId ?? "control",
        experiment_id: experimentId,
        skill_version: skillVersion,
        approved: event.approved ?? null,
        token_cost_usd: event.tokenCostUsd ?? 0,
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(this.config.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.authToken}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          this.recordFailure(`http-${response.status}`, null);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.recordFailure("fetch", err);
    }
  }

  /** Snapshot of failure counts, exposed for diagnostics. */
  failureSnapshot(): Record<string, number> {
    return Object.fromEntries(this.failureCounts.entries());
  }

  private recordFailure(kind: string, err: unknown): void {
    const count = (this.failureCounts.get(kind) ?? 0) + 1;
    this.failureCounts.set(kind, count);
    // Only log the first few per kind to avoid flooding.
    if (count <= 3) {
      logger.debug("skill analytics emit failed", {
        kind,
        count,
        error: err instanceof Error ? err.message : String(err ?? ""),
      });
    }
  }
}
