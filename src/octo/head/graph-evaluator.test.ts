// Octopus Orchestrator -- GraphEvaluator tests (M3-10)
//
// Covers MVP graph shapes: linear chains, fan-out, fan-in, and
// failure handling with/without blocks_mission_on_failure.

import { describe, expect, it, vi } from "vitest";
import type { MissionGraphNode, MissionSpec } from "../wire/schema.ts";
import type { EventLogService } from "./event-log.ts";
import { GraphEvaluator } from "./graph-evaluator.ts";
import type { GripRecord, MissionRecord, RegistryService } from "./registry.ts";

// ──────────────────────────────────────────────────────────────────────────
// Factory helpers
// ──────────────────────────────────────────────────────────────────────────

function makeGrip(overrides: Partial<GripRecord> = {}): GripRecord {
  return {
    grip_id: "g1",
    mission_id: "m1",
    type: "code-edit",
    input_ref: null,
    priority: 1,
    assigned_arm_id: null,
    status: "queued",
    timeout_s: 300,
    side_effecting: false,
    idempotency_key: null,
    result_ref: null,
    spec: {
      spec_version: 1,
      mission_id: "m1",
      type: "code-edit",
      retry_policy: {
        max_attempts: 3,
        backoff: "exponential",
        initial_delay_s: 1,
        max_delay_s: 60,
        multiplier: 2,
        retry_on: ["transient"],
        abandon_on: ["unrecoverable"],
      },
      timeout_s: 300,
      side_effecting: false,
    },
    created_at: Date.now(),
    updated_at: Date.now(),
    version: 1,
    ...overrides,
  };
}

function makeMission(
  graph: MissionGraphNode[],
  overrides: Partial<MissionRecord> = {},
): MissionRecord {
  return {
    mission_id: "m1",
    title: "test",
    owner: "tester",
    status: "active",
    policy_profile_ref: null,
    spec: {
      spec_version: 1,
      title: "test",
      owner: "tester",
      graph,
    } as MissionSpec,
    metadata: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    version: 1,
    ...overrides,
  };
}

function node(gripId: string, depsOn: string[], blocks?: boolean): MissionGraphNode {
  const n: MissionGraphNode = { grip_id: gripId, depends_on: depsOn };
  if (blocks !== undefined) {
    n.blocks_mission_on_failure = blocks;
  }
  return n;
}

function createMocks(
  mission: MissionRecord,
  grips: GripRecord[],
): { registry: RegistryService; eventLog: EventLogService } {
  const registry = {
    getMission: vi.fn().mockReturnValue(mission),
    listGrips: vi.fn().mockReturnValue(grips),
    casUpdateMission: vi.fn().mockReturnValue(mission),
  } as unknown as RegistryService;

  const eventLog = {
    append: vi.fn().mockResolvedValue({
      event_id: "evt-1",
      schema_version: 1,
      entity_type: "mission",
      entity_id: mission.mission_id,
      event_type: "mission.aborted",
      ts: new Date().toISOString(),
      actor: "graph-evaluator",
      payload: {},
    }),
  } as unknown as EventLogService;

  return { registry, eventLog };
}

// ══════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════

describe("GraphEvaluator", () => {
  // ────────────────────────────────────────────────────────────────────────
  // Linear chain: A -> B -> C
  // ────────────────────────────────────────────────────────────────────────

  it("linear chain: completing A makes B eligible", () => {
    const graph = [node("A", []), node("B", ["A"]), node("C", ["B"])];
    const grips = [
      makeGrip({ grip_id: "A", status: "completed" }),
      makeGrip({ grip_id: "B", status: "queued" }),
      makeGrip({ grip_id: "C", status: "queued" }),
    ];
    const { registry, eventLog } = createMocks(makeMission(graph), grips);
    const evaluator = new GraphEvaluator(registry, eventLog);

    const result = evaluator.onGripCompleted("m1", "A");
    expect(result).toEqual(["B"]);
  });

  it("linear chain: completing B makes C eligible", () => {
    const graph = [node("A", []), node("B", ["A"]), node("C", ["B"])];
    const grips = [
      makeGrip({ grip_id: "A", status: "completed" }),
      makeGrip({ grip_id: "B", status: "completed" }),
      makeGrip({ grip_id: "C", status: "queued" }),
    ];
    const { registry, eventLog } = createMocks(makeMission(graph), grips);
    const evaluator = new GraphEvaluator(registry, eventLog);

    const result = evaluator.onGripCompleted("m1", "B");
    expect(result).toEqual(["C"]);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Fan-out: A -> [B, C]
  // ────────────────────────────────────────────────────────────────────────

  it("fan-out: completing A makes both B and C eligible", () => {
    const graph = [node("A", []), node("B", ["A"]), node("C", ["A"])];
    const grips = [
      makeGrip({ grip_id: "A", status: "completed" }),
      makeGrip({ grip_id: "B", status: "queued" }),
      makeGrip({ grip_id: "C", status: "queued" }),
    ];
    const { registry, eventLog } = createMocks(makeMission(graph), grips);
    const evaluator = new GraphEvaluator(registry, eventLog);

    const result = evaluator.onGripCompleted("m1", "A");
    expect(result).toEqual(["B", "C"]);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Fan-in: [A, B] -> C
  // ────────────────────────────────────────────────────────────────────────

  it("fan-in: completing A alone does NOT make C eligible", () => {
    const graph = [node("A", []), node("B", []), node("C", ["A", "B"])];
    const grips = [
      makeGrip({ grip_id: "A", status: "completed" }),
      makeGrip({ grip_id: "B", status: "queued" }),
      makeGrip({ grip_id: "C", status: "queued" }),
    ];
    const { registry, eventLog } = createMocks(makeMission(graph), grips);
    const evaluator = new GraphEvaluator(registry, eventLog);

    const result = evaluator.onGripCompleted("m1", "A");
    expect(result).toEqual([]);
  });

  it("fan-in: completing both A and B makes C eligible", () => {
    const graph = [node("A", []), node("B", []), node("C", ["A", "B"])];
    const grips = [
      makeGrip({ grip_id: "A", status: "completed" }),
      makeGrip({ grip_id: "B", status: "completed" }),
      makeGrip({ grip_id: "C", status: "queued" }),
    ];
    const { registry, eventLog } = createMocks(makeMission(graph), grips);
    const evaluator = new GraphEvaluator(registry, eventLog);

    const result = evaluator.onGripCompleted("m1", "B");
    expect(result).toEqual(["C"]);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Failure: blocks_mission_on_failure = true (default)
  // ────────────────────────────────────────────────────────────────────────

  it("fail with blocks_mission_on_failure (default) aborts mission", () => {
    const graph = [node("A", []), node("B", ["A"])];
    const mission = makeMission(graph);
    const grips = [
      makeGrip({ grip_id: "A", status: "failed" }),
      makeGrip({ grip_id: "B", status: "queued" }),
    ];
    const { registry, eventLog } = createMocks(mission, grips);
    const evaluator = new GraphEvaluator(registry, eventLog);

    const result = evaluator.onGripFailed("m1", "A");
    expect(result.missionAborted).toBe(true);
    expect(result.blockedGripIds).toEqual(["B"]);
    expect(registry.casUpdateMission).toHaveBeenCalledWith(
      "m1",
      1,
      expect.objectContaining({ status: "aborted" }),
    );
    expect(eventLog.append).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "mission.aborted" }),
    );
  });

  it("fail with blocks_mission_on_failure = true (explicit) aborts mission", () => {
    const graph = [node("A", [], true), node("B", ["A"])];
    const mission = makeMission(graph);
    const grips = [
      makeGrip({ grip_id: "A", status: "failed" }),
      makeGrip({ grip_id: "B", status: "queued" }),
    ];
    const { registry, eventLog } = createMocks(mission, grips);
    const evaluator = new GraphEvaluator(registry, eventLog);

    const result = evaluator.onGripFailed("m1", "A");
    expect(result.missionAborted).toBe(true);
    expect(result.blockedGripIds).toEqual(["B"]);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Failure: blocks_mission_on_failure = false
  // ────────────────────────────────────────────────────────────────────────

  it("fail with blocks_mission_on_failure = false does NOT abort mission", () => {
    const graph = [node("A", [], false), node("B", ["A"])];
    const mission = makeMission(graph);
    const grips = [
      makeGrip({ grip_id: "A", status: "failed" }),
      makeGrip({ grip_id: "B", status: "queued" }),
    ];
    const { registry, eventLog } = createMocks(mission, grips);
    const evaluator = new GraphEvaluator(registry, eventLog);

    const result = evaluator.onGripFailed("m1", "A");
    expect(result.missionAborted).toBe(false);
    expect(result.blockedGripIds).toEqual(["B"]);
    expect(registry.casUpdateMission).not.toHaveBeenCalled();
    expect(eventLog.append).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Edge: already-assigned grips are not returned as eligible
  // ────────────────────────────────────────────────────────────────────────

  it("does not return grips that are already assigned", () => {
    const graph = [node("A", []), node("B", ["A"])];
    const grips = [
      makeGrip({ grip_id: "A", status: "completed" }),
      makeGrip({ grip_id: "B", status: "assigned" }),
    ];
    const { registry, eventLog } = createMocks(makeMission(graph), grips);
    const evaluator = new GraphEvaluator(registry, eventLog);

    const result = evaluator.onGripCompleted("m1", "A");
    expect(result).toEqual([]);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Edge: mission not found throws
  // ────────────────────────────────────────────────────────────────────────

  it("throws when mission is not found", () => {
    const registry = {
      getMission: vi.fn().mockReturnValue(null),
    } as unknown as RegistryService;
    const eventLog = { append: vi.fn() } as unknown as EventLogService;
    const evaluator = new GraphEvaluator(registry, eventLog);

    expect(() => evaluator.onGripCompleted("m-unknown", "A")).toThrow("mission not found");
  });

  // ────────────────────────────────────────────────────────────────────────
  // Edge: root grips (no deps) are never returned by onGripCompleted
  // ────────────────────────────────────────────────────────────────────────

  it("root grips with no depends_on are not returned", () => {
    const graph = [node("A", []), node("B", [])];
    const grips = [
      makeGrip({ grip_id: "A", status: "completed" }),
      makeGrip({ grip_id: "B", status: "queued" }),
    ];
    const { registry, eventLog } = createMocks(makeMission(graph), grips);
    const evaluator = new GraphEvaluator(registry, eventLog);

    const result = evaluator.onGripCompleted("m1", "A");
    expect(result).toEqual([]);
  });
});
