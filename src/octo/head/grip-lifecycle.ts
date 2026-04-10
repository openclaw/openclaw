// Octopus Orchestrator — GripLifecycleService (M3-04)
//
// Manages grip lifecycle transitions: startGrip (queued->assigned->running),
// completeGrip (running->completed + result_ref), failGrip (running->failed
// + blocks_mission_on_failure check). After completion or failure, returns
// a { wakeGripIds } list of dependent grips eligible for graph re-evaluation.
//
// Context docs:
//   - LLD SS Graph rules -- grip.completed / grip.failed triggers re-evaluation
//   - LLD SS MissionGraphNode -- depends_on, blocks_mission_on_failure
//   - DECISIONS.md OCTO-DEC-033 -- boundary discipline (only src/octo/ imports)
//
// Boundary discipline (OCTO-DEC-033):
//   Only node:* builtins, @sinclair/typebox, and relative imports inside
//   src/octo/ are permitted.

import type { MissionGraphNode } from "../wire/schema.ts";
import type { EventLogService } from "./event-log.ts";
import { applyGripTransition, type GripState } from "./grip-fsm.ts";
import type { GripRecord, RegistryService } from "./registry.ts";

// ──────────────────────────────────────────────────────────────────────────
// Result types
// ──────────────────────────────────────────────────────────────────────────

export interface GripLifecycleResult {
  grip: GripRecord;
  wakeGripIds: readonly string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────

export class GripNotFoundError extends Error {
  constructor(public readonly grip_id: string) {
    super(`grip not found: ${grip_id}`);
    this.name = "GripNotFoundError";
  }
}

export class MissionNotFoundError extends Error {
  constructor(public readonly mission_id: string) {
    super(`mission not found: ${mission_id}`);
    this.name = "MissionNotFoundError";
  }
}

// ──────────────────────────────────────────────────────────────────────────
// GripLifecycleService
// ──────────────────────────────────────────────────────────────────────────

export class GripLifecycleService {
  constructor(
    private readonly registry: RegistryService,
    private readonly eventLog: EventLogService,
  ) {}

  /**
   * Transition a grip from queued -> assigned -> running in a single call.
   * The two-step transition mirrors the LLD state machine: assignment is
   * distinct from execution start, but in the MVP they happen atomically.
   */
  async startGrip(
    gripId: string,
    armId: string,
    opts?: { now?: number },
  ): Promise<GripLifecycleResult> {
    const now = opts?.now ?? Date.now();
    const grip = this.requireGrip(gripId);

    // queued -> assigned
    const afterAssigned = applyGripTransition(
      { state: grip.status, updated_at: grip.updated_at },
      "assigned" as GripState,
      { now, grip_id: gripId },
    );

    const assignedGrip = this.registry.casUpdateGrip(gripId, grip.version, {
      status: afterAssigned.state,
      assigned_arm_id: armId,
      updated_at: afterAssigned.updated_at,
    });

    await this.eventLog.append({
      schema_version: 1,
      entity_type: "grip",
      entity_id: gripId,
      event_type: "grip.assigned",
      ts: new Date(now).toISOString(),
      actor: "head",
      payload: { arm_id: armId },
    });

    // assigned -> running
    const afterRunning = applyGripTransition(
      { state: assignedGrip.status, updated_at: assignedGrip.updated_at },
      "running" as GripState,
      { now, grip_id: gripId },
    );

    const runningGrip = this.registry.casUpdateGrip(gripId, assignedGrip.version, {
      status: afterRunning.state,
      updated_at: afterRunning.updated_at,
    });

    await this.eventLog.append({
      schema_version: 1,
      entity_type: "grip",
      entity_id: gripId,
      event_type: "grip.running",
      ts: new Date(now).toISOString(),
      actor: "head",
      payload: { arm_id: armId },
    });

    return { grip: runningGrip, wakeGripIds: [] };
  }

  /**
   * Transition a grip from running -> completed. Stores the result artifact
   * ref. Returns the dependent grip IDs that should be re-evaluated.
   */
  async completeGrip(
    gripId: string,
    resultRef: string,
    opts?: { now?: number },
  ): Promise<GripLifecycleResult> {
    const now = opts?.now ?? Date.now();
    const grip = this.requireGrip(gripId);

    const after = applyGripTransition(
      { state: grip.status, updated_at: grip.updated_at },
      "completed" as GripState,
      { now, grip_id: gripId },
    );

    const updated = this.registry.casUpdateGrip(gripId, grip.version, {
      status: after.state,
      result_ref: resultRef,
      updated_at: after.updated_at,
    });

    await this.eventLog.append({
      schema_version: 1,
      entity_type: "grip",
      entity_id: gripId,
      event_type: "grip.completed",
      ts: new Date(now).toISOString(),
      actor: "head",
      payload: { result_ref: resultRef },
    });

    const wakeGripIds = this.computeWakeGripIds(grip.mission_id, gripId);
    return { grip: updated, wakeGripIds };
  }

  /**
   * Transition a grip from running -> failed. Checks blocks_mission_on_failure
   * from the mission graph and includes it in the result payload. Returns
   * dependent grip IDs for re-evaluation regardless of blocking status --
   * the caller decides how to handle mission-blocking failures.
   */
  async failGrip(
    gripId: string,
    reason: string,
    opts?: { now?: number },
  ): Promise<GripLifecycleResult & { blocksMission: boolean }> {
    const now = opts?.now ?? Date.now();
    const grip = this.requireGrip(gripId);

    const after = applyGripTransition(
      { state: grip.status, updated_at: grip.updated_at },
      "failed" as GripState,
      { now, grip_id: gripId },
    );

    const updated = this.registry.casUpdateGrip(gripId, grip.version, {
      status: after.state,
      updated_at: after.updated_at,
    });

    await this.eventLog.append({
      schema_version: 1,
      entity_type: "grip",
      entity_id: gripId,
      event_type: "grip.failed",
      ts: new Date(now).toISOString(),
      actor: "head",
      payload: { reason },
    });

    const blocksMission = this.checkBlocksMission(grip.mission_id, gripId);
    const wakeGripIds = this.computeWakeGripIds(grip.mission_id, gripId);
    return { grip: updated, wakeGripIds, blocksMission };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ────────────────────────────────────────────────────────────────────────

  private requireGrip(gripId: string): GripRecord {
    const grip = this.registry.getGrip(gripId);
    if (!grip) {
      throw new GripNotFoundError(gripId);
    }
    return grip;
  }

  /**
   * Find grip IDs in the mission graph that depend on the given grip.
   * These are candidates for re-evaluation after the grip completes or fails.
   */
  private computeWakeGripIds(missionId: string, gripId: string): string[] {
    const mission = this.registry.getMission(missionId);
    if (!mission) {
      return [];
    }
    const graph: readonly MissionGraphNode[] = mission.spec.graph;
    const dependents: string[] = [];
    for (const node of graph) {
      if (node.depends_on.includes(gripId)) {
        dependents.push(node.grip_id);
      }
    }
    return dependents;
  }

  /**
   * Check if the grip's graph node has blocks_mission_on_failure set.
   * Defaults to true per LLD when not explicitly set.
   */
  private checkBlocksMission(missionId: string, gripId: string): boolean {
    const mission = this.registry.getMission(missionId);
    if (!mission) {
      return true; // defensive default
    }
    const graph: readonly MissionGraphNode[] = mission.spec.graph;
    const node = graph.find((n) => n.grip_id === gripId);
    if (!node) {
      return true; // defensive default
    }
    return node.blocks_mission_on_failure !== false;
  }
}
