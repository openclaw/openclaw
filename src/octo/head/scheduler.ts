// Octopus Orchestrator -- SchedulerService (M3-03)
//
// MVP grip assignment scheduler. Selects the next eligible grip via
// weighted round-robin fairness across missions, scores candidate arms
// using configurable weights, and assigns the best match.
//
// Context docs:
//   - LLD.md section Scheduler Algorithm -- scoring function and hard filters
//   - LLD.md section Fairness across missions -- weighted round-robin
//   - CONFIG.md section octo.scheduler.weights -- operator-tunable weights
//   - DECISIONS.md OCTO-DEC-033 -- boundary discipline
//
// Boundary discipline (OCTO-DEC-033):
//   Only `node:*` builtins and relative imports inside `src/octo/` are
//   permitted. No external dependencies.

import type { OctoSchedulerConfig } from "../config/schema.ts";
import type { MissionGraphNode } from "../wire/schema.ts";
import type { EventLogService } from "./event-log.ts";
import { applyGripTransition } from "./grip-fsm.ts";
import type { ArmRecord, GripRecord, MissionRecord, RegistryService } from "./registry.ts";

// ──────────────────────────────────────────────────────────────────────────
// SchedulerContext -- ambient data the scoring function needs beyond the
// grip/arm pair. Callers of scoreArm assemble this from registry state.
// ──────────────────────────────────────────────────────────────────────────

export interface SchedulerContext {
  /** Was this arm the last one used by this mission? */
  lastArmForMission: boolean;
  /** Is this arm on the same node as the grip's preferred node? (MVP: always false) */
  sameNode: boolean;
  /** Fraction of capability overlap [0,1]. 1 = full match. */
  capabilityMatch: number;
  /** Current load fraction of this arm's node [0,1]. */
  armLoadFraction: number;
  /** Count of recent failures on this arm/node. */
  recentFailures: number;
  /** Is this arm bound to a different agent_id than the grip's mission? */
  crossAgentId: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// SchedulerService
// ──────────────────────────────────────────────────────────────────────────

export class SchedulerService {
  private readonly registry: RegistryService;
  private readonly eventLog: EventLogService;
  private readonly config: OctoSchedulerConfig;

  /** Per-node capability sets for capability-aware scheduling (M4-03). */
  private readonly nodeCapabilities: Map<string, string[]> = new Map();

  /** Per-mission virtual time for weighted round-robin fairness. */
  private readonly missionVirtualTime: Map<string, number> = new Map();

  constructor(registry: RegistryService, eventLog: EventLogService, config: OctoSchedulerConfig) {
    this.registry = registry;
    this.eventLog = eventLog;
    this.config = config;
  }

  /**
   * Register or update the capability set for a node (M4-03).
   * Called when a Node Agent announces its capabilities via
   * `octo.node.capabilities`.
   */
  setNodeCapabilities(nodeId: string, capabilities: string[]): void {
    this.nodeCapabilities.set(nodeId, capabilities);
  }

  /**
   * Get the capability set for a node, or an empty array if unknown.
   */
  getNodeCapabilities(nodeId: string): readonly string[] {
    return this.nodeCapabilities.get(nodeId) ?? [];
  }

  /**
   * Score a candidate arm for a grip. Exposed for testing.
   *
   * score = stickiness * (lastArmForMission ? 1 : 0)
   *       + locality * (sameNode ? 1 : 0)
   *       + preferredMatch * capabilityMatch
   *       + loadBalance * (1 - armLoadFraction)
   *       - recentFailurePenalty * recentFailures
   *       - crossAgentIdPenalty * (crossAgentId ? 1 : 0)
   */
  scoreArm(grip: GripRecord, arm: ArmRecord, context: SchedulerContext): number {
    const w = this.config.weights;
    return (
      w.stickiness * (context.lastArmForMission ? 1 : 0) +
      w.locality * (context.sameNode ? 1 : 0) +
      w.preferredMatch * context.capabilityMatch +
      w.loadBalance * (1 - context.armLoadFraction) -
      w.recentFailurePenalty * context.recentFailures -
      w.crossAgentIdPenalty * (context.crossAgentId ? 1 : 0)
    );
  }

  /**
   * Pick the next eligible grip and assign it to the best arm.
   * Returns the assignment or null if nothing eligible.
   */
  assignNextGrip(): { gripId: string; armId: string } | null {
    // 1. Gather all queued grips.
    const queuedGrips = this.registry.listGrips({ status: "queued" });
    if (queuedGrips.length === 0) {
      return null;
    }

    // 2. Gather missions to resolve dependency graphs.
    const missionCache = new Map<string, MissionRecord>();
    for (const grip of queuedGrips) {
      if (!missionCache.has(grip.mission_id)) {
        const mission = this.registry.getMission(grip.mission_id);
        if (mission) {
          missionCache.set(grip.mission_id, mission);
        }
      }
    }

    // 3. Filter to eligible grips (all depends_on completed/archived).
    const eligibleGrips = queuedGrips.filter((grip) => this.isGripEligible(grip, missionCache));
    if (eligibleGrips.length === 0) {
      return null;
    }

    // 4. Select the grip from the mission with the lowest virtual time
    //    (weighted round-robin fairness).
    const selectedGrip = this.selectByFairness(eligibleGrips, missionCache);
    if (!selectedGrip) {
      return null;
    }

    // 5. Gather idle arms and score them.
    const idleArms = this.registry.listArms({ state: "idle" });
    if (idleArms.length === 0) {
      return null;
    }

    // 5a. Hard filter: capability match (M4-03, LLD §Scheduler Algorithm).
    //     Only consider arms whose node declares ALL of the grip's
    //     desired_capabilities. Grips with no desired_capabilities pass all arms.
    const desiredCaps = selectedGrip.spec.desired_capabilities ?? [];
    const capableArms =
      desiredCaps.length === 0
        ? idleArms
        : idleArms.filter((arm) => {
            const nodeCaps = this.nodeCapabilities.get(arm.node_id) ?? [];
            return desiredCaps.every((cap) => nodeCaps.includes(cap));
          });

    if (capableArms.length === 0) {
      return null;
    }

    // Build context and score each arm.
    let bestArm: ArmRecord | null = null;
    let bestScore = -Infinity;

    for (const arm of capableArms) {
      const context = this.buildContext(selectedGrip, arm, missionCache);
      const score = this.scoreArm(selectedGrip, arm, context);
      if (score > bestScore) {
        bestScore = score;
        bestArm = arm;
      }
    }

    if (!bestArm) {
      return null;
    }

    // 6. Transition grip queued -> assigned via FSM.
    const now = Date.now();
    const transitioned = applyGripTransition(
      { state: selectedGrip.status, updated_at: selectedGrip.updated_at },
      "assigned",
      { now, grip_id: selectedGrip.grip_id },
    );

    // 7. CAS-update the grip in the registry.
    this.registry.casUpdateGrip(selectedGrip.grip_id, selectedGrip.version, {
      status: transitioned.state,
      assigned_arm_id: bestArm.arm_id,
      updated_at: transitioned.updated_at,
    });

    // 8. Emit grip.assigned event.
    void this.eventLog.append({
      schema_version: 1,
      entity_type: "grip",
      entity_id: selectedGrip.grip_id,
      event_type: "grip.assigned",
      actor: "scheduler",
      payload: {
        arm_id: bestArm.arm_id,
        mission_id: selectedGrip.mission_id,
      },
    });

    // 9. Advance mission virtual time by 1 / priority.
    const _mission = missionCache.get(selectedGrip.mission_id);
    const priority = selectedGrip.priority > 0 ? selectedGrip.priority : 1;
    const currentVt = this.missionVirtualTime.get(selectedGrip.mission_id) ?? 0;
    this.missionVirtualTime.set(selectedGrip.mission_id, currentVt + 1 / priority);

    return { gripId: selectedGrip.grip_id, armId: bestArm.arm_id };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ────────────────────────────────────────────────────────────────────────

  /**
   * A grip is eligible when all of its depends_on grips are in
   * completed or archived status.
   */
  private isGripEligible(grip: GripRecord, missionCache: Map<string, MissionRecord>): boolean {
    const mission = missionCache.get(grip.mission_id);
    if (!mission) {
      return false;
    }

    // Find this grip's graph node to get depends_on.
    const graphNode = mission.spec.graph.find((n: MissionGraphNode) => n.grip_id === grip.grip_id);
    if (!graphNode) {
      // Grip not in the graph -- treat as eligible (no declared deps).
      return true;
    }
    if (graphNode.depends_on.length === 0) {
      return true;
    }

    // All dependencies must be completed or archived.
    for (const depGripId of graphNode.depends_on) {
      const depGrip = this.registry.getGrip(depGripId);
      if (!depGrip) {
        return false;
      }
      if (depGrip.status !== "completed" && depGrip.status !== "archived") {
        return false;
      }
    }
    return true;
  }

  /**
   * Weighted round-robin: select the eligible grip from the mission
   * with the lowest virtual time. Ties broken by grip creation order
   * (first created wins -- grips are returned ORDER BY created_at DESC,
   * so we reverse-iterate for oldest-first).
   */
  private selectByFairness(
    eligibleGrips: GripRecord[],
    _missionCache: Map<string, MissionRecord>,
  ): GripRecord | null {
    if (eligibleGrips.length === 0) {
      return null;
    }

    // Ensure all missions have a virtual time entry.
    for (const grip of eligibleGrips) {
      if (!this.missionVirtualTime.has(grip.mission_id)) {
        this.missionVirtualTime.set(grip.mission_id, 0);
      }
    }

    // Find the mission with the lowest virtual time among eligible grips.
    let lowestVt = Infinity;
    let selectedGrip: GripRecord | null = null;

    for (const grip of eligibleGrips) {
      const vt = this.missionVirtualTime.get(grip.mission_id) ?? 0;
      if (
        vt < lowestVt ||
        (vt === lowestVt && selectedGrip !== null && grip.created_at < selectedGrip.created_at)
      ) {
        lowestVt = vt;
        selectedGrip = grip;
      }
    }

    return selectedGrip;
  }

  /**
   * Build a SchedulerContext for a grip/arm pair from registry state.
   * MVP simplifications: locality is always false (single-node),
   * load fraction is 0.
   *
   * capabilityMatch (M4-03): fraction of desired_capabilities the node
   * satisfies. After the hard filter only fully-capable arms remain, so
   * this is 1.0 whenever desired_capabilities is non-empty. When no
   * capabilities are requested it defaults to 1.0 (neutral).
   */
  private buildContext(
    grip: GripRecord,
    arm: ArmRecord,
    _missionCache: Map<string, MissionRecord>,
  ): SchedulerContext {
    const desiredCaps = grip.spec.desired_capabilities ?? [];
    let capabilityMatch = 1.0;
    if (desiredCaps.length > 0) {
      const nodeCaps = this.nodeCapabilities.get(arm.node_id) ?? [];
      const matched = desiredCaps.filter((c) => nodeCaps.includes(c)).length;
      capabilityMatch = matched / desiredCaps.length;
    }

    return {
      lastArmForMission: arm.mission_id === grip.mission_id,
      sameNode: false,
      capabilityMatch,
      armLoadFraction: 0,
      recentFailures: 0,
      crossAgentId: arm.mission_id !== grip.mission_id,
    };
  }
}
