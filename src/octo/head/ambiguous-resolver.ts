// Octopus Orchestrator -- AmbiguousResolver (M3-12)
//
// Resolves ambiguous duplicate-execution scenarios where two arms have
// completed the same grip. Per LLD SS5 (Ambiguous duplicate execution):
//   - Read-only grips (side_effecting === false AND type hints read-only)
//     are auto-resolved by lowest arm_id lexicographic order.
//   - All other grips require operator intervention.
//
// Context docs:
//   - LLD SS Recovery Flows SS5 -- seed design
//   - DECISIONS.md OCTO-DEC-033 -- boundary discipline
//
// Boundary discipline (OCTO-DEC-033):
//   Only node:* builtins and relative imports inside src/octo/ are
//   permitted. No external dependencies.

import type { EventLogService } from "./event-log.ts";
import type { RegistryService } from "./registry.ts";

// ──────────────────────────────────────────────────────────────────────────
// Read-only type hint patterns
//
// Grip `type` strings matching these prefixes are considered read-only
// when combined with `side_effecting === false`. Per LLD SS5 seed design,
// these grips can be auto-resolved without operator intervention.
// ──────────────────────────────────────────────────────────────────────────

const READ_ONLY_TYPE_PREFIXES: readonly string[] = [
  "read",
  "query",
  "fetch",
  "inspect",
  "analysis",
  "analyze",
  "check",
  "lint",
  "validate",
  "review",
];

function isReadOnlyType(gripType: string): boolean {
  const lower = gripType.toLowerCase();
  return READ_ONLY_TYPE_PREFIXES.some(
    (prefix) =>
      lower === prefix || lower.startsWith(`${prefix}_`) || lower.startsWith(`${prefix}-`),
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Resolution result
// ──────────────────────────────────────────────────────────────────────────

export interface AmbiguousResolutionResult {
  resolution: "auto" | "operator_required";
  selectedArmId?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// AmbiguousResolver
// ──────────────────────────────────────────────────────────────────────────

export class AmbiguousResolver {
  constructor(
    private registry: RegistryService,
    private eventLog: EventLogService,
  ) {}

  /**
   * Two arms completed the same grip. Quarantine both, emit grip.ambiguous.
   *
   * For read-only grips (side_effecting === false AND type hints toward
   * read-only), auto-resolve by lowest arm_id lexicographic. For all
   * others, return operator_required.
   */
  async onGripAmbiguous(
    gripId: string,
    armIdA: string,
    armIdB: string,
    resultRefA: string,
    resultRefB: string,
  ): Promise<AmbiguousResolutionResult> {
    const grip = this.registry.getGrip(gripId);
    if (!grip) {
      throw new Error(`AmbiguousResolver: grip not found: ${gripId}`);
    }

    // Quarantine both arms.
    this.quarantineArm(armIdA);
    this.quarantineArm(armIdB);

    // Emit grip.ambiguous event.
    await this.eventLog.append({
      schema_version: 1,
      entity_type: "grip",
      entity_id: gripId,
      event_type: "grip.ambiguous",
      actor: "ambiguous-resolver",
      payload: {
        arm_id_a: armIdA,
        arm_id_b: armIdB,
        result_ref_a: resultRefA,
        result_ref_b: resultRefB,
      },
    });

    // Determine resolution policy.
    if (!grip.side_effecting && isReadOnlyType(grip.type)) {
      const selectedArmId = armIdA < armIdB ? armIdA : armIdB;
      const selectedRef = selectedArmId === armIdA ? resultRefA : resultRefB;

      // Auto-resolve: mark selected result as canonical.
      this.registry.casUpdateGrip(gripId, grip.version, {
        result_ref: selectedRef,
        status: "completed",
      });

      return { resolution: "auto", selectedArmId };
    }

    // Side-effecting or non-read-only: operator must decide.
    this.registry.casUpdateGrip(gripId, grip.version, {
      status: "blocked",
    });

    return { resolution: "operator_required" };
  }

  /**
   * Operator picks a winner. Mark the selected result as canonical,
   * discard the other, emit a resolution event.
   */
  async resolve(gripId: string, selectedArmId: string): Promise<void> {
    const grip = this.registry.getGrip(gripId);
    if (!grip) {
      throw new Error(`AmbiguousResolver: grip not found: ${gripId}`);
    }

    this.registry.casUpdateGrip(gripId, grip.version, {
      assigned_arm_id: selectedArmId,
      status: "completed",
    });

    await this.eventLog.append({
      schema_version: 1,
      entity_type: "grip",
      entity_id: gripId,
      event_type: "grip.completed",
      actor: "ambiguous-resolver",
      payload: {
        resolution: "operator",
        selected_arm_id: selectedArmId,
      },
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ────────────────────────────────────────────────────────────────────────

  private quarantineArm(armId: string): void {
    const arm = this.registry.getArm(armId);
    if (!arm) {
      throw new Error(`AmbiguousResolver: arm not found: ${armId}`);
    }
    this.registry.casUpdateArm(armId, arm.version, {
      state: "quarantined",
    });
  }
}
