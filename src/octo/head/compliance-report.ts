// Octopus Orchestrator — ComplianceReporter (M5-05)
//
// Replays the event log to collect all `arm.created` events, runs a
// caller-supplied policyCheck against each arm's spec payload, and
// produces a ComplianceReport summarising compliant vs violating arms.
//
// Context docs:
//   - LLD §Policy Enforcement Timeline — historical replay for compliance
//   - DECISIONS.md OCTO-DEC-033 — boundary discipline
//
// Boundary discipline (OCTO-DEC-033):
//   Only `node:*` builtins, `@sinclair/typebox`, and relative imports
//   inside `src/octo/` are permitted.

import type { EventEnvelope } from "../wire/events.ts";
import type { EventLogService } from "./event-log.ts";

export interface ComplianceViolation {
  arm_id: string;
  event_type: string;
  reason: string;
  ts: string;
}

export interface ComplianceReport {
  total_arms: number;
  compliant: number;
  violations: ComplianceViolation[];
  generated_at: number;
}

export type PolicyCheckFn = (armSpec: Record<string, unknown>) => {
  allowed: boolean;
  reason?: string;
};

export class ComplianceReporter {
  constructor(private eventLog: EventLogService) {}

  async generate(policyCheck: PolicyCheckFn): Promise<ComplianceReport> {
    const violations: ComplianceViolation[] = [];
    let totalArms = 0;

    await this.eventLog.replay(
      (envelope: EventEnvelope) => {
        totalArms++;
        const result = policyCheck(envelope.payload);
        if (!result.allowed) {
          violations.push({
            arm_id: envelope.entity_id,
            event_type: envelope.event_type,
            reason: result.reason ?? "policy violation",
            ts: envelope.ts,
          });
        }
      },
      { filter: { event_type: "arm.created" } },
    );

    return {
      total_arms: totalArms,
      compliant: totalArms - violations.length,
      violations,
      generated_at: Date.now(),
    };
  }
}
