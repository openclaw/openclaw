// Octopus Orchestrator -- GraphEvaluator (M3-10)
//
// Re-evaluates the mission DAG when a grip completes or fails.
// Returns newly eligible grip_ids (all depends_on satisfied) or
// aborts the mission when a blocking grip fails.
//
// MVP graph shapes: linear chains, simple fan-out, simple fan-in.
// No diamonds, no conditionals.
//
// Context docs:
//   - LLD.md section Mission Graph Schema -- graph rules 1-3
//   - LLD.md section Minimal MVP graph -- supported shapes
//   - DECISIONS.md OCTO-DEC-033 -- boundary discipline
//
// Boundary discipline (OCTO-DEC-033):
//   Only `node:*` builtins and relative imports inside `src/octo/`.

import type { MissionGraphNode } from "../wire/schema.ts";
import type { EventLogService } from "./event-log.ts";
import { applyMissionTransition } from "./mission-fsm.ts";
import type { GripRecord, MissionRecord, RegistryService } from "./registry.ts";

// ──────────────────────────────────────────────────────────────────────────
// Result types
// ──────────────────────────────────────────────────────────────────────────

export interface GripFailedResult {
  missionAborted: boolean;
  blockedGripIds: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// GraphEvaluator
// ──────────────────────────────────────────────────────────────────────────

export class GraphEvaluator {
  private readonly registry: RegistryService;
  private readonly eventLog: EventLogService;

  constructor(registry: RegistryService, eventLog: EventLogService) {
    this.registry = registry;
    this.eventLog = eventLog;
  }

  /**
   * Called when a grip completes. Returns grip_ids whose ALL
   * depends_on are now completed or archived (eligible for
   * scheduling).
   */
  onGripCompleted(missionId: string, completedGripId: string): string[] {
    const mission = this.requireMission(missionId);
    const graph = mission.spec.graph;
    const grips = this.registry.listGrips({ mission_id: missionId });

    const completedSet = this.buildCompletedSet(grips, completedGripId);
    return this.findNewlyEligible(graph, grips, completedSet);
  }

  /**
   * Called when a grip fails. If blocks_mission_on_failure (default
   * true per LLD), aborts the mission via FSM and emits
   * mission.aborted. Returns dependent grip_ids that are now blocked.
   */
  onGripFailed(missionId: string, failedGripId: string): GripFailedResult {
    const mission = this.requireMission(missionId);
    const graph = mission.spec.graph;

    const node = graph.find((n) => n.grip_id === failedGripId);
    // blocks_mission_on_failure defaults to true per LLD
    const blocks = node?.blocks_mission_on_failure !== false;

    const blockedGripIds = this.findDependents(graph, failedGripId);

    if (blocks) {
      const updated = applyMissionTransition(
        { state: mission.status, updated_at: mission.updated_at },
        "aborted",
        { mission_id: missionId },
      );
      this.registry.casUpdateMission(missionId, mission.version, {
        status: updated.state,
        updated_at: updated.updated_at,
      });
      void this.eventLog.append({
        schema_version: 1,
        entity_type: "mission",
        entity_id: missionId,
        event_type: "mission.aborted",
        actor: "graph-evaluator",
        payload: { reason: "blocking_grip_failed", failed_grip_id: failedGripId },
      });
    }

    return { missionAborted: blocks, blockedGripIds };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────

  private requireMission(missionId: string): MissionRecord {
    const mission = this.registry.getMission(missionId);
    if (!mission) {
      throw new Error(`GraphEvaluator: mission not found: ${missionId}`);
    }
    return mission;
  }

  /** Build the set of grip_ids that are completed or archived. */
  private buildCompletedSet(grips: GripRecord[], justCompleted: string): Set<string> {
    const set = new Set<string>();
    for (const g of grips) {
      if (g.status === "completed" || g.status === "archived") {
        set.add(g.grip_id);
      }
    }
    // Ensure the just-completed grip is included even if the registry
    // read raced slightly.
    set.add(justCompleted);
    return set;
  }

  /**
   * Find grips whose ALL depends_on are in the completed set AND that
   * are still queued (not already assigned/running/completed).
   */
  private findNewlyEligible(
    graph: readonly MissionGraphNode[],
    grips: GripRecord[],
    completedSet: Set<string>,
  ): string[] {
    const gripStatusMap = new Map<string, string>();
    for (const g of grips) {
      gripStatusMap.set(g.grip_id, g.status);
    }

    const eligible: string[] = [];
    for (const node of graph) {
      if (node.depends_on.length === 0) {
        continue;
      }
      const status = gripStatusMap.get(node.grip_id);
      if (status !== "queued") {
        continue;
      }
      const allMet = node.depends_on.every((dep) => completedSet.has(dep));
      if (allMet) {
        eligible.push(node.grip_id);
      }
    }
    return eligible;
  }

  /** Find grip_ids that directly depend on the given grip. */
  private findDependents(graph: readonly MissionGraphNode[], gripId: string): string[] {
    const dependents: string[] = [];
    for (const node of graph) {
      if (node.depends_on.includes(gripId)) {
        dependents.push(node.grip_id);
      }
    }
    return dependents;
  }
}
