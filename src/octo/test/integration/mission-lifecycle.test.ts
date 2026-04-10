// Octopus Orchestrator -- Integration test: full mission lifecycle (M3-17)
//
// End-to-end test of mission creation with a linear 3-grip dependency
// chain (A -> B -> C), scheduler assignment, grip completion through FSM
// transitions, and mission completion. Validates the full lifecycle path
// through RegistryService, SchedulerService, grip-fsm, and mission-fsm.
//
// Workaround: graph-evaluator.ts does not exist yet (M3-10 in parallel).
// Dependency eligibility is checked manually in these tests by querying
// each grip's depends_on from the mission spec and verifying all upstream
// grips are in "completed" status. The scheduler's internal isGripEligible
// performs the same check, so this workaround is semantically equivalent.
//
// Boundary discipline (OCTO-DEC-033): only `node:*` builtins,
// `@sinclair/typebox`, and relative imports inside `src/octo/`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OctoSchedulerConfig } from "../../config/schema.ts";
import { EventLogService } from "../../head/event-log.ts";
import { applyGripTransition } from "../../head/grip-fsm.ts";
import { applyMissionTransition } from "../../head/mission-fsm.ts";
import type { ArmInput, MissionRecord } from "../../head/registry.ts";
import { RegistryService } from "../../head/registry.ts";
import { SchedulerService } from "../../head/scheduler.ts";
import { closeOctoRegistry, openOctoRegistry } from "../../head/storage/migrate.ts";
import type { MissionGraphNode, MissionSpec } from "../../wire/schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// Scheduler config with uniform weights for deterministic tests
// ──────────────────────────────────────────────────────────────────────────

function makeSchedulerConfig(): OctoSchedulerConfig {
  return {
    weights: {
      stickiness: 0,
      locality: 0,
      preferredMatch: 1.0,
      loadBalance: 0,
      recentFailurePenalty: 0,
      crossAgentIdPenalty: 0,
    },
    defaultSpread: false,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Helper: build a 3-grip linear chain A -> B -> C
// ──────────────────────────────────────────────────────────────────────────

function makeLinearMissionSpec(): MissionSpec {
  return {
    spec_version: 1,
    title: "lifecycle-test-mission",
    owner: "integration-test",
    graph: [
      { grip_id: "grip-A", depends_on: [] },
      { grip_id: "grip-B", depends_on: ["grip-A"] },
      { grip_id: "grip-C", depends_on: ["grip-B"] },
    ],
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Helper: transition a grip through assigned -> running -> completed
// ──────────────────────────────────────────────────────────────────────────

async function completeGrip(
  registry: RegistryService,
  eventLog: EventLogService,
  gripId: string,
  armId: string,
): Promise<void> {
  const grip = registry.getGrip(gripId);
  if (!grip) {
    throw new Error(`grip ${gripId} not found`);
  }

  // assigned -> running
  const running = applyGripTransition(
    { state: grip.status, updated_at: grip.updated_at },
    "running",
    { grip_id: gripId },
  );
  const afterRunning = registry.casUpdateGrip(gripId, grip.version, {
    status: running.state,
    updated_at: running.updated_at,
  });
  await eventLog.append({
    schema_version: 1,
    entity_type: "grip",
    entity_id: gripId,
    event_type: "grip.running",
    actor: "test",
    payload: { arm_id: armId },
  });

  // running -> completed
  const completed = applyGripTransition(
    { state: afterRunning.status, updated_at: afterRunning.updated_at },
    "completed",
    { grip_id: gripId },
  );
  registry.casUpdateGrip(gripId, afterRunning.version, {
    status: completed.state,
    updated_at: completed.updated_at,
  });
  await eventLog.append({
    schema_version: 1,
    entity_type: "grip",
    entity_id: gripId,
    event_type: "grip.completed",
    actor: "test",
    payload: { arm_id: armId },
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Helper: check if a grip's dependencies are all completed (manual
// graph-evaluator workaround -- see module header)
// ──────────────────────────────────────────────────────────────────────────

function areDependenciesSatisfied(
  registry: RegistryService,
  mission: MissionRecord,
  gripId: string,
): boolean {
  const graphNode = mission.spec.graph.find((n: MissionGraphNode) => n.grip_id === gripId);
  if (!graphNode || graphNode.depends_on.length === 0) {
    return true;
  }
  for (const depId of graphNode.depends_on) {
    const dep = registry.getGrip(depId);
    if (!dep || (dep.status !== "completed" && dep.status !== "archived")) {
      return false;
    }
  }
  return true;
}

// ──────────────────────────────────────────────────────────────────────────
// Helper: insert an idle arm into the registry
// ──────────────────────────────────────────────────────────────────────────

function insertIdleArm(registry: RegistryService, missionId: string, armId: string): void {
  const armInput: ArmInput = {
    arm_id: armId,
    mission_id: missionId,
    node_id: "node-test",
    adapter_type: "cli_exec",
    runtime_name: "test-runner",
    agent_id: "agent-test",
    task_ref: null,
    state: "idle",
    current_grip_id: null,
    lease_owner: null,
    lease_expiry_ts: null,
    session_ref: null,
    checkpoint_ref: null,
    health_status: null,
    restart_count: 0,
    policy_profile: null,
    spec: {
      spec_version: 1,
      mission_id: missionId,
      adapter_type: "cli_exec",
      runtime_name: "test-runner",
      agent_id: "agent-test",
      cwd: "/tmp",
      idempotency_key: `idem-${armId}`,
      runtime_options: { command: "echo" },
    },
  };
  registry.putArm(armInput);
}

// ══════════════════════════════════════════════════════════════════════════
// Test suite
// ══════════════════════════════════════════════════════════════════════════

describe("mission-lifecycle integration", () => {
  let tmpDir: string;
  let db: ReturnType<typeof openOctoRegistry>;
  let registry: RegistryService;
  let eventLog: EventLogService;
  let scheduler: SchedulerService;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "m3-17-"));
    const dbPath = path.join(tmpDir, "registry.db");
    db = openOctoRegistry({ path: dbPath });
    registry = new RegistryService(db);
    eventLog = new EventLogService({ path: path.join(tmpDir, "events.jsonl") });
    scheduler = new SchedulerService(registry, eventLog, makeSchedulerConfig());
  });

  afterEach(() => {
    closeOctoRegistry(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test 1: full lifecycle A -> B -> C, mission completes
  // ──────────────────────────────────────────────────────────────────────

  it("full linear chain A->B->C completes mission", async () => {
    const spec = makeLinearMissionSpec();
    const missionId = "mis-lifecycle-001";
    const now = Date.now();

    // -- Step 1: create mission and grips --
    registry.putMission({
      mission_id: missionId,
      title: spec.title,
      owner: spec.owner,
      status: "active",
      policy_profile_ref: null,
      spec,
      metadata: null,
      created_at: now,
    });

    for (const node of spec.graph) {
      registry.putGrip({
        grip_id: node.grip_id,
        mission_id: missionId,
        type: "mission_grip",
        input_ref: null,
        priority: 1,
        assigned_arm_id: null,
        status: "queued",
        timeout_s: null,
        side_effecting: false,
        idempotency_key: null,
        result_ref: null,
        spec: {
          spec_version: 1,
          mission_id: missionId,
          type: "mission_grip",
          retry_policy: {
            max_attempts: 1,
            backoff: "fixed",
            initial_delay_s: 0,
            max_delay_s: 0,
            multiplier: 1,
            retry_on: [],
            abandon_on: ["unrecoverable"],
          },
          timeout_s: 0,
          side_effecting: false,
        },
        created_at: now,
      });
    }

    // Insert an idle arm for the scheduler to assign grips to.
    const armId = "arm-lifecycle-001";
    insertIdleArm(registry, missionId, armId);

    // Microtask yield to let fire-and-forget event appends settle.
    const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

    // -- Step 2: assign A (no deps, should be eligible) --
    const mission = registry.getMission(missionId);
    expect(mission).not.toBeNull();
    expect(areDependenciesSatisfied(registry, mission!, "grip-A")).toBe(true);
    expect(areDependenciesSatisfied(registry, mission!, "grip-B")).toBe(false);
    expect(areDependenciesSatisfied(registry, mission!, "grip-C")).toBe(false);

    const assignA = scheduler.assignNextGrip();
    expect(assignA).not.toBeNull();
    expect(assignA!.gripId).toBe("grip-A");
    expect(assignA!.armId).toBe(armId);
    await flush();

    // Verify A is now assigned.
    const gripAAfterAssign = registry.getGrip("grip-A");
    expect(gripAAfterAssign!.status).toBe("assigned");

    // -- Step 3: complete A, check B eligible --
    await completeGrip(registry, eventLog, "grip-A", armId);
    const armAfterA = registry.getArm(armId);
    expect(areDependenciesSatisfied(registry, mission!, "grip-B")).toBe(true);
    expect(areDependenciesSatisfied(registry, mission!, "grip-C")).toBe(false);

    // -- Step 4: assign B, complete B, check C eligible --
    // Arm must return to idle for scheduler to pick it up.
    registry.casUpdateArm(armId, armAfterA!.version, { state: "idle" });

    const assignB = scheduler.assignNextGrip();
    expect(assignB).not.toBeNull();
    expect(assignB!.gripId).toBe("grip-B");
    await flush();

    await completeGrip(registry, eventLog, "grip-B", armId);
    expect(areDependenciesSatisfied(registry, mission!, "grip-C")).toBe(true);

    // -- Step 5: assign C, complete C --
    const armAfterB = registry.getArm(armId);
    registry.casUpdateArm(armId, armAfterB!.version, { state: "idle" });

    const assignC = scheduler.assignNextGrip();
    expect(assignC).not.toBeNull();
    expect(assignC!.gripId).toBe("grip-C");
    await flush();

    await completeGrip(registry, eventLog, "grip-C", armId);

    // -- Step 6: verify all grips completed --
    const allGrips = registry.listGrips({ mission_id: missionId });
    for (const grip of allGrips) {
      expect(grip.status).toBe("completed");
    }
    expect(allGrips.length).toBe(3);

    // -- Step 7: transition mission to completed --
    const missionNow = registry.getMission(missionId);
    const missionCompleted = applyMissionTransition(
      { state: missionNow!.status, updated_at: missionNow!.updated_at },
      "completed",
      { mission_id: missionId },
    );
    registry.casUpdateMission(missionId, missionNow!.version, {
      status: missionCompleted.state,
      updated_at: missionCompleted.updated_at,
    });

    const finalMission = registry.getMission(missionId);
    expect(finalMission!.status).toBe("completed");

    // -- Step 8: verify events emitted in order --
    const events: Array<{ event_type: string; entity_id: string }> = [];
    await eventLog.replay((envelope) => {
      events.push({
        event_type: envelope.event_type,
        entity_id: envelope.entity_id,
      });
    });

    // Expect: grip.assigned(A), grip.running(A), grip.completed(A),
    //         grip.assigned(B), grip.running(B), grip.completed(B),
    //         grip.assigned(C), grip.running(C), grip.completed(C)
    const gripEventTypes = events.map((e) => `${e.event_type}:${e.entity_id}`);
    expect(gripEventTypes).toEqual([
      "grip.assigned:grip-A",
      "grip.running:grip-A",
      "grip.completed:grip-A",
      "grip.assigned:grip-B",
      "grip.running:grip-B",
      "grip.completed:grip-B",
      "grip.assigned:grip-C",
      "grip.running:grip-C",
      "grip.completed:grip-C",
    ]);

    // No more grips to assign.
    const noMore = scheduler.assignNextGrip();
    expect(noMore).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test 2: B fails with blocks_mission_on_failure -> mission aborts
  // ──────────────────────────────────────────────────────────────────────

  it("grip failure with blocks_mission_on_failure aborts mission", async () => {
    const spec: MissionSpec = {
      spec_version: 1,
      title: "failure-abort-test",
      owner: "integration-test",
      graph: [
        { grip_id: "grip-A", depends_on: [] },
        { grip_id: "grip-B", depends_on: ["grip-A"], blocks_mission_on_failure: true },
        { grip_id: "grip-C", depends_on: ["grip-B"] },
      ],
    };
    const missionId = "mis-failure-001";
    const now = Date.now();

    // Create mission and grips.
    registry.putMission({
      mission_id: missionId,
      title: spec.title,
      owner: spec.owner,
      status: "active",
      policy_profile_ref: null,
      spec,
      metadata: null,
      created_at: now,
    });

    for (const node of spec.graph) {
      registry.putGrip({
        grip_id: node.grip_id,
        mission_id: missionId,
        type: "mission_grip",
        input_ref: null,
        priority: 1,
        assigned_arm_id: null,
        status: "queued",
        timeout_s: null,
        side_effecting: false,
        idempotency_key: null,
        result_ref: null,
        spec: {
          spec_version: 1,
          mission_id: missionId,
          type: "mission_grip",
          retry_policy: {
            max_attempts: 1,
            backoff: "fixed",
            initial_delay_s: 0,
            max_delay_s: 0,
            multiplier: 1,
            retry_on: [],
            abandon_on: ["unrecoverable"],
          },
          timeout_s: 0,
          side_effecting: false,
        },
        created_at: now,
      });
    }

    const armId = "arm-failure-001";
    insertIdleArm(registry, missionId, armId);

    const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

    // Assign and complete A.
    const assignA = scheduler.assignNextGrip();
    expect(assignA).not.toBeNull();
    expect(assignA!.gripId).toBe("grip-A");
    await flush();
    await completeGrip(registry, eventLog, "grip-A", armId);

    // Reset arm to idle, assign B.
    const armAfterA = registry.getArm(armId);
    registry.casUpdateArm(armId, armAfterA!.version, { state: "idle" });

    const assignB = scheduler.assignNextGrip();
    expect(assignB).not.toBeNull();
    expect(assignB!.gripId).toBe("grip-B");
    await flush();

    // Transition B: assigned -> running -> failed.
    const gripB = registry.getGrip("grip-B")!;
    const bRunning = applyGripTransition(
      { state: gripB.status, updated_at: gripB.updated_at },
      "running",
      { grip_id: "grip-B" },
    );
    const bAfterRunning = registry.casUpdateGrip("grip-B", gripB.version, {
      status: bRunning.state,
      updated_at: bRunning.updated_at,
    });

    const bFailed = applyGripTransition(
      { state: bAfterRunning.status, updated_at: bAfterRunning.updated_at },
      "failed",
      { grip_id: "grip-B" },
    );
    registry.casUpdateGrip("grip-B", bAfterRunning.version, {
      status: bFailed.state,
      updated_at: bFailed.updated_at,
    });

    void eventLog.append({
      schema_version: 1,
      entity_type: "grip",
      entity_id: "grip-B",
      event_type: "grip.failed",
      actor: "test",
      payload: { arm_id: armId, reason: "simulated failure" },
    });

    // Check blocks_mission_on_failure flag on B's graph node.
    const mission = registry.getMission(missionId)!;
    const bNode = mission.spec.graph.find((n: MissionGraphNode) => n.grip_id === "grip-B");
    expect(bNode).toBeDefined();
    expect(bNode!.blocks_mission_on_failure).toBe(true);

    // B failed and blocks_mission_on_failure is true -> abort mission.
    const missionTransitioned = applyMissionTransition(
      { state: mission.status, updated_at: mission.updated_at },
      "aborted",
      { mission_id: missionId },
    );
    registry.casUpdateMission(missionId, mission.version, {
      status: missionTransitioned.state,
      updated_at: missionTransitioned.updated_at,
    });

    void eventLog.append({
      schema_version: 1,
      entity_type: "mission",
      entity_id: missionId,
      event_type: "mission.aborted",
      actor: "test",
      payload: { reason: "grip-B failed with blocks_mission_on_failure" },
    });

    // Verify mission is aborted.
    const finalMission = registry.getMission(missionId);
    expect(finalMission!.status).toBe("aborted");

    // Verify B is in failed state.
    const finalB = registry.getGrip("grip-B");
    expect(finalB!.status).toBe("failed");

    // Verify C was never assigned (still queued).
    const finalC = registry.getGrip("grip-C");
    expect(finalC!.status).toBe("queued");

    // C's deps are NOT satisfied (B is failed, not completed).
    expect(areDependenciesSatisfied(registry, mission, "grip-C")).toBe(false);

    // Scheduler should return null (no eligible grips -- B failed,
    // C blocked, mission aborted).
    const armAfterB = registry.getArm(armId);
    registry.casUpdateArm(armId, armAfterB!.version, { state: "idle" });
    const noMore = scheduler.assignNextGrip();
    expect(noMore).toBeNull();

    // Verify event ordering.
    const events: Array<{ event_type: string; entity_id: string }> = [];
    await eventLog.replay((envelope) => {
      events.push({
        event_type: envelope.event_type,
        entity_id: envelope.entity_id,
      });
    });

    const eventSummary = events.map((e) => `${e.event_type}:${e.entity_id}`);
    expect(eventSummary).toContain("grip.assigned:grip-A");
    expect(eventSummary).toContain("grip.completed:grip-A");
    expect(eventSummary).toContain("grip.assigned:grip-B");
    expect(eventSummary).toContain("grip.failed:grip-B");
    expect(eventSummary).toContain("mission.aborted:mis-failure-001");

    // C events should NOT appear.
    const cEvents = eventSummary.filter((e) => e.includes("grip-C"));
    expect(cEvents).toHaveLength(0);
  });
});
