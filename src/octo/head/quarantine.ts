// Octopus Orchestrator -- QuarantineService (M5-04)
//
// Manages arm quarantine: threshold detection, quarantine transition,
// operator-initiated release. Arms exceeding the configured restart
// ceiling are pulled out of the scheduling pool until an operator
// explicitly releases them.
//
// Context docs:
//   - LLD SS State Machines (Arm state machine) -- quarantined state
//   - CONFIG.md SS Quarantine -- maxRestarts, nodeFailureWindow(S)
//   - DECISIONS.md OCTO-DEC-033 -- boundary discipline (only src/octo/ imports)

import type { OctoQuarantineConfig } from "../config/schema.ts";
import { applyArmTransition } from "./arm-fsm.ts";
import type { EventLogService } from "./event-log.ts";
import type { ArmRecord, RegistryService } from "./registry.ts";

// ──────────────────────────────────────────────────────────────────────────
// QuarantineService
// ──────────────────────────────────────────────────────────────────────────

export class QuarantineService {
  constructor(
    private readonly registry: RegistryService,
    private readonly eventLog: EventLogService,
    private readonly config: OctoQuarantineConfig,
  ) {}

  /**
   * Transition an arm to the `quarantined` state via the FSM, persist
   * via CAS update, and emit an `arm.quarantined` event.
   *
   * Throws `InvalidTransitionError` if the FSM rejects the transition
   * (e.g. arm is already quarantined or in a terminal state).
   */
  async quarantine(armId: string, reason: string): Promise<void> {
    const arm = this.registry.getArm(armId);
    if (!arm) {
      throw new Error(`quarantine: arm not found: ${armId}`);
    }

    const next = applyArmTransition(arm, "quarantined", { arm_id: armId });
    this.registry.casUpdateArm(armId, arm.version, {
      state: next.state,
      updated_at: next.updated_at,
    });

    await this.eventLog.append({
      schema_version: 1,
      entity_type: "arm",
      entity_id: armId,
      event_type: "arm.quarantined",
      actor: "system",
      payload: { reason },
    });
  }

  /**
   * Release a quarantined arm back to `starting` (operator-initiated).
   * Persists via CAS update and emits an `arm.recovered` event with
   * the operator as actor.
   *
   * Throws `InvalidTransitionError` if the arm is not in `quarantined`.
   */
  async release(armId: string, operatorId: string): Promise<void> {
    const arm = this.registry.getArm(armId);
    if (!arm) {
      throw new Error(`release: arm not found: ${armId}`);
    }

    const next = applyArmTransition(arm, "starting", { arm_id: armId });
    this.registry.casUpdateArm(armId, arm.version, {
      state: next.state,
      updated_at: next.updated_at,
    });

    await this.eventLog.append({
      schema_version: 1,
      entity_type: "arm",
      entity_id: armId,
      event_type: "arm.recovered",
      actor: operatorId,
      payload: { released_from: "quarantined" },
    });
  }

  /**
   * Pure predicate: should this arm be auto-quarantined based on its
   * restart_count versus the configured maxRestarts ceiling?
   */
  shouldAutoQuarantine(armRecord: ArmRecord): boolean {
    return armRecord.restart_count >= this.config.maxRestarts;
  }
}
