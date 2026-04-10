// Octopus Orchestrator -- SchedulerService tests (M3-03)
//
// Covers:
//   - Fairness: 2 missions with different priorities over 10 rounds
//   - Dependency gating: grip with unsatisfied dep stays queued
//   - Highest-scoring arm is selected
//   - Scoring weights from config are applied
//   - Empty registry returns null
//   - Eligible grip assigned + event emitted
//   - All deps completed makes grip eligible
//   - Cross-agent penalty reduces score

import { describe, expect, it, vi } from "vitest";
import type { OctoSchedulerConfig } from "../config/schema.ts";
import type { GripSpec } from "../wire/schema.ts";
import type { EventLogService } from "./event-log.ts";
import type { ArmRecord, GripRecord, MissionRecord, RegistryService } from "./registry.ts";
import { SchedulerService, type SchedulerContext } from "./scheduler.ts";

// ──────────────────────────────────────────────────────────────────────────
// Default scheduler config
// ──────────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<OctoSchedulerConfig> = {}): OctoSchedulerConfig {
  return {
    weights: {
      stickiness: 3.0,
      locality: 2.0,
      preferredMatch: 1.5,
      loadBalance: 1.0,
      recentFailurePenalty: 2.0,
      crossAgentIdPenalty: 1.0,
    },
    defaultSpread: false,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Factory helpers
// ──────────────────────────────────────────────────────────────────────────

function makeGripSpec(overrides: Partial<GripSpec> = {}): GripSpec {
  return {
    spec_version: 1,
    mission_id: "mission-1",
    type: "code-edit",
    retry_policy: {
      max_attempts: 3,
      backoff: "exponential",
      initial_delay_s: 1,
      max_delay_s: 60,
      multiplier: 2,
      retry_on: ["transient", "timeout"],
      abandon_on: ["unrecoverable"],
    },
    timeout_s: 300,
    side_effecting: false,
    ...overrides,
  };
}

function makeGrip(overrides: Partial<GripRecord> = {}): GripRecord {
  return {
    grip_id: `grip-${Math.random().toString(36).slice(2, 10)}`,
    mission_id: "mission-1",
    type: "code-edit",
    input_ref: null,
    priority: 1,
    assigned_arm_id: null,
    status: "queued",
    timeout_s: 300,
    side_effecting: false,
    idempotency_key: null,
    result_ref: null,
    spec: makeGripSpec(),
    created_at: Date.now(),
    updated_at: Date.now(),
    version: 1,
    ...overrides,
  };
}

function makeArm(overrides: Partial<ArmRecord> = {}): ArmRecord {
  return {
    arm_id: `arm-${Math.random().toString(36).slice(2, 10)}`,
    mission_id: "mission-1",
    node_id: "node-1",
    adapter_type: "cli_exec",
    runtime_name: "claude-cli",
    agent_id: "agent-1",
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
      mission_id: "mission-1",
      adapter_type: "cli_exec",
      runtime_name: "claude-cli",
      agent_id: "agent-1",
      cwd: "/tmp",
      idempotency_key: "idem-1",
      runtime_options: { command: "echo" },
    },
    created_at: Date.now(),
    updated_at: Date.now(),
    version: 1,
    ...overrides,
  };
}

function makeMission(overrides: Partial<MissionRecord> = {}): MissionRecord {
  return {
    mission_id: "mission-1",
    title: "test mission",
    owner: "tester",
    status: "active",
    policy_profile_ref: null,
    spec: {
      spec_version: 1,
      title: "test mission",
      owner: "tester",
      graph: [{ grip_id: "g1", depends_on: [] }],
    },
    metadata: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    version: 1,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Mock registry and event log
// ──────────────────────────────────────────────────────────────────────────

interface MockRegistryState {
  grips: GripRecord[];
  arms: ArmRecord[];
  missions: MissionRecord[];
}

function createMockRegistry(state: MockRegistryState): RegistryService {
  return {
    listGrips: vi.fn((filter: { status?: string } = {}) => {
      if (filter.status) {
        return state.grips.filter((g) => g.status === filter.status);
      }
      return state.grips;
    }),
    listArms: vi.fn((filter: { state?: string } = {}) => {
      if (filter.state) {
        return state.arms.filter((a) => a.state === filter.state);
      }
      return state.arms;
    }),
    getMission: vi.fn((id: string) => {
      return state.missions.find((m) => m.mission_id === id) ?? null;
    }),
    getGrip: vi.fn((id: string) => {
      return state.grips.find((g) => g.grip_id === id) ?? null;
    }),
    casUpdateGrip: vi.fn(
      (gripId: string, _expectedVersion: number, patch: Record<string, unknown>) => {
        const grip = state.grips.find((g) => g.grip_id === gripId);
        if (grip) {
          Object.assign(grip, patch, { version: grip.version + 1 });
        }
        return grip;
      },
    ),
  } as unknown as RegistryService;
}

function createMockEventLog(): EventLogService {
  return {
    append: vi.fn().mockResolvedValue({
      event_id: "test-event-id",
      schema_version: 1,
      entity_type: "grip",
      entity_id: "test",
      event_type: "grip.assigned",
      ts: new Date().toISOString(),
      actor: "scheduler",
      payload: {},
    }),
  } as unknown as EventLogService;
}

// ══════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════

describe("SchedulerService", () => {
  describe("scoreArm", () => {
    it("applies scoring weights from config", () => {
      const config = makeConfig();
      const registry = createMockRegistry({ grips: [], arms: [], missions: [] });
      const eventLog = createMockEventLog();
      const scheduler = new SchedulerService(registry, eventLog, config);

      const grip = makeGrip();
      const arm = makeArm();
      const context: SchedulerContext = {
        lastArmForMission: true,
        sameNode: true,
        capabilityMatch: 1.0,
        armLoadFraction: 0,
        recentFailures: 0,
        crossAgentId: false,
      };

      const score = scheduler.scoreArm(grip, arm, context);
      // 3.0*1 + 2.0*1 + 1.5*1.0 + 1.0*(1-0) - 2.0*0 - 1.0*0 = 7.5
      expect(score).toBe(7.5);
    });

    it("penalizes cross-agent-id and recent failures", () => {
      const config = makeConfig();
      const registry = createMockRegistry({ grips: [], arms: [], missions: [] });
      const eventLog = createMockEventLog();
      const scheduler = new SchedulerService(registry, eventLog, config);

      const grip = makeGrip();
      const arm = makeArm();
      const context: SchedulerContext = {
        lastArmForMission: false,
        sameNode: false,
        capabilityMatch: 0.5,
        armLoadFraction: 0.5,
        recentFailures: 2,
        crossAgentId: true,
      };

      const score = scheduler.scoreArm(grip, arm, context);
      // 3.0*0 + 2.0*0 + 1.5*0.5 + 1.0*(1-0.5) - 2.0*2 - 1.0*1
      // = 0 + 0 + 0.75 + 0.5 - 4.0 - 1.0 = -3.75
      expect(score).toBe(-3.75);
    });

    it("uses custom weights when config overrides defaults", () => {
      const config = makeConfig({
        weights: {
          stickiness: 10.0,
          locality: 0,
          preferredMatch: 0,
          loadBalance: 0,
          recentFailurePenalty: 0,
          crossAgentIdPenalty: 0,
        },
      });
      const registry = createMockRegistry({ grips: [], arms: [], missions: [] });
      const eventLog = createMockEventLog();
      const scheduler = new SchedulerService(registry, eventLog, config);

      const grip = makeGrip();
      const arm = makeArm();
      const contextSticky: SchedulerContext = {
        lastArmForMission: true,
        sameNode: false,
        capabilityMatch: 0,
        armLoadFraction: 1.0,
        recentFailures: 5,
        crossAgentId: true,
      };

      // Only stickiness matters: 10.0 * 1 = 10.0
      expect(scheduler.scoreArm(grip, arm, contextSticky)).toBe(10.0);
    });
  });

  describe("assignNextGrip", () => {
    it("returns null when no queued grips exist", () => {
      const state: MockRegistryState = { grips: [], arms: [], missions: [] };
      const registry = createMockRegistry(state);
      const eventLog = createMockEventLog();
      const scheduler = new SchedulerService(registry, eventLog, makeConfig());

      expect(scheduler.assignNextGrip()).toBeNull();
    });

    it("returns null when no idle arms available", () => {
      const grip = makeGrip({ grip_id: "g1", status: "queued" });
      const mission = makeMission({
        mission_id: "mission-1",
        spec: {
          spec_version: 1,
          title: "m",
          owner: "o",
          graph: [{ grip_id: "g1", depends_on: [] }],
        },
      });
      const state: MockRegistryState = {
        grips: [grip],
        arms: [],
        missions: [mission],
      };
      const registry = createMockRegistry(state);
      const eventLog = createMockEventLog();
      const scheduler = new SchedulerService(registry, eventLog, makeConfig());

      expect(scheduler.assignNextGrip()).toBeNull();
    });

    it("assigns eligible grip to highest-scoring arm", () => {
      const grip = makeGrip({
        grip_id: "g1",
        mission_id: "m1",
        status: "queued",
      });
      const armGood = makeArm({
        arm_id: "arm-good",
        mission_id: "m1",
        state: "idle",
      });
      const armBad = makeArm({
        arm_id: "arm-bad",
        mission_id: "m-other",
        state: "idle",
      });
      const mission = makeMission({
        mission_id: "m1",
        spec: {
          spec_version: 1,
          title: "m",
          owner: "o",
          graph: [{ grip_id: "g1", depends_on: [] }],
        },
      });
      const state: MockRegistryState = {
        grips: [grip],
        arms: [armBad, armGood],
        missions: [mission],
      };
      const registry = createMockRegistry(state);
      const eventLog = createMockEventLog();
      const scheduler = new SchedulerService(registry, eventLog, makeConfig());

      const result = scheduler.assignNextGrip();
      expect(result).not.toBeNull();
      expect(result!.gripId).toBe("g1");
      // arm-good shares mission_id with grip -> higher stickiness
      expect(result!.armId).toBe("arm-good");
    });

    it("emits grip.assigned event on assignment", () => {
      const grip = makeGrip({
        grip_id: "g1",
        mission_id: "m1",
        status: "queued",
      });
      const arm = makeArm({
        arm_id: "arm-1",
        mission_id: "m1",
        state: "idle",
      });
      const mission = makeMission({
        mission_id: "m1",
        spec: {
          spec_version: 1,
          title: "m",
          owner: "o",
          graph: [{ grip_id: "g1", depends_on: [] }],
        },
      });
      const state: MockRegistryState = {
        grips: [grip],
        arms: [arm],
        missions: [mission],
      };
      const registry = createMockRegistry(state);
      const eventLog = createMockEventLog();
      const scheduler = new SchedulerService(registry, eventLog, makeConfig());

      scheduler.assignNextGrip();

      expect(eventLog.append).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_type: "grip",
          entity_id: "g1",
          event_type: "grip.assigned",
          payload: expect.objectContaining({
            arm_id: "arm-1",
            mission_id: "m1",
          }),
        }),
      );
    });

    it("skips grip with unsatisfied dependency", () => {
      const depGrip = makeGrip({
        grip_id: "dep-1",
        mission_id: "m1",
        status: "running",
      });
      const blockedGrip = makeGrip({
        grip_id: "g1",
        mission_id: "m1",
        status: "queued",
      });
      const arm = makeArm({
        arm_id: "arm-1",
        mission_id: "m1",
        state: "idle",
      });
      const mission = makeMission({
        mission_id: "m1",
        spec: {
          spec_version: 1,
          title: "m",
          owner: "o",
          graph: [
            { grip_id: "dep-1", depends_on: [] },
            { grip_id: "g1", depends_on: ["dep-1"] },
          ],
        },
      });
      const state: MockRegistryState = {
        grips: [depGrip, blockedGrip],
        arms: [arm],
        missions: [mission],
      };
      const registry = createMockRegistry(state);
      const eventLog = createMockEventLog();
      const scheduler = new SchedulerService(registry, eventLog, makeConfig());

      // g1 depends on dep-1 which is still running -> not eligible
      expect(scheduler.assignNextGrip()).toBeNull();
    });

    it("makes grip eligible when all deps are completed", () => {
      const depGrip = makeGrip({
        grip_id: "dep-1",
        mission_id: "m1",
        status: "completed",
      });
      const readyGrip = makeGrip({
        grip_id: "g1",
        mission_id: "m1",
        status: "queued",
      });
      const arm = makeArm({
        arm_id: "arm-1",
        mission_id: "m1",
        state: "idle",
      });
      const mission = makeMission({
        mission_id: "m1",
        spec: {
          spec_version: 1,
          title: "m",
          owner: "o",
          graph: [
            { grip_id: "dep-1", depends_on: [] },
            { grip_id: "g1", depends_on: ["dep-1"] },
          ],
        },
      });
      const state: MockRegistryState = {
        grips: [depGrip, readyGrip],
        arms: [arm],
        missions: [mission],
      };
      const registry = createMockRegistry(state);
      const eventLog = createMockEventLog();
      const scheduler = new SchedulerService(registry, eventLog, makeConfig());

      const result = scheduler.assignNextGrip();
      expect(result).not.toBeNull();
      expect(result!.gripId).toBe("g1");
    });

    it("makes grip eligible when dep is archived", () => {
      const depGrip = makeGrip({
        grip_id: "dep-1",
        mission_id: "m1",
        status: "archived",
      });
      const readyGrip = makeGrip({
        grip_id: "g1",
        mission_id: "m1",
        status: "queued",
      });
      const arm = makeArm({
        arm_id: "arm-1",
        mission_id: "m1",
        state: "idle",
      });
      const mission = makeMission({
        mission_id: "m1",
        spec: {
          spec_version: 1,
          title: "m",
          owner: "o",
          graph: [
            { grip_id: "dep-1", depends_on: [] },
            { grip_id: "g1", depends_on: ["dep-1"] },
          ],
        },
      });
      const state: MockRegistryState = {
        grips: [depGrip, readyGrip],
        arms: [arm],
        missions: [mission],
      };
      const registry = createMockRegistry(state);
      const eventLog = createMockEventLog();
      const scheduler = new SchedulerService(registry, eventLog, makeConfig());

      const result = scheduler.assignNextGrip();
      expect(result).not.toBeNull();
      expect(result!.gripId).toBe("g1");
    });

    it("enforces fairness: 2 missions with different priorities over 10 rounds", () => {
      // Mission A: priority 2 (advances by 1/2 per assignment -> gets more)
      // Mission B: priority 1 (advances by 1/1 per assignment -> gets fewer)
      const missionA = makeMission({
        mission_id: "mA",
        spec: {
          spec_version: 1,
          title: "A",
          owner: "o",
          graph: Array.from({ length: 10 }, (_, i) => ({
            grip_id: `gA-${i}`,
            depends_on: [] as string[],
          })),
        },
      });
      const missionB = makeMission({
        mission_id: "mB",
        spec: {
          spec_version: 1,
          title: "B",
          owner: "o",
          graph: Array.from({ length: 10 }, (_, i) => ({
            grip_id: `gB-${i}`,
            depends_on: [] as string[],
          })),
        },
      });

      const gripsA = Array.from({ length: 10 }, (_, i) =>
        makeGrip({
          grip_id: `gA-${i}`,
          mission_id: "mA",
          priority: 2,
          status: "queued",
          created_at: 1000 + i,
        }),
      );
      const gripsB = Array.from({ length: 10 }, (_, i) =>
        makeGrip({
          grip_id: `gB-${i}`,
          mission_id: "mB",
          priority: 1,
          status: "queued",
          created_at: 1000 + i,
        }),
      );

      const arms = Array.from({ length: 10 }, (_, i) =>
        makeArm({
          arm_id: `arm-${i}`,
          mission_id: i < 5 ? "mA" : "mB",
          state: "idle",
        }),
      );

      const state: MockRegistryState = {
        grips: [...gripsA, ...gripsB],
        arms,
        missions: [missionA, missionB],
      };
      const registry = createMockRegistry(state);
      const eventLog = createMockEventLog();
      const scheduler = new SchedulerService(registry, eventLog, makeConfig());

      let countA = 0;
      let countB = 0;

      for (let round = 0; round < 10; round++) {
        const result = scheduler.assignNextGrip();
        if (!result) {
          break;
        }

        // Remove assigned grip from queued pool
        const idx = state.grips.findIndex((g) => g.grip_id === result.gripId);
        if (idx >= 0) {
          const grip = state.grips[idx];
          if (grip) {
            grip.status = "assigned";
          }
        }

        if (result.gripId.startsWith("gA-")) {
          countA++;
        } else {
          countB++;
        }
      }

      // Higher priority mission (A, priority=2) should get more assignments
      // because its virtual time advances by 1/2 per assignment vs 1/1 for B.
      // Over 10 rounds, roughly A gets ~6-7 and B gets ~3-4.
      expect(countA).toBeGreaterThan(countB);
      expect(countA + countB).toBe(10);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // M4-03: Capability-aware scheduling
  // ────────────────────────────────────────────────────────────────────────

  describe("capability-aware scheduling (M4-03)", () => {
    it("assigns grip requiring tool.git only to the node that has it", () => {
      const grip = makeGrip({
        grip_id: "g1",
        mission_id: "m1",
        status: "queued",
        spec: makeGripSpec({
          mission_id: "m1",
          desired_capabilities: ["tool.git"],
        }),
      });
      const armWithGit = makeArm({
        arm_id: "arm-git",
        node_id: "node-git",
        mission_id: "m1",
        state: "idle",
      });
      const armWithoutGit = makeArm({
        arm_id: "arm-nogit",
        node_id: "node-nogit",
        mission_id: "m1",
        state: "idle",
      });
      const mission = makeMission({
        mission_id: "m1",
        spec: {
          spec_version: 1,
          title: "m",
          owner: "o",
          graph: [{ grip_id: "g1", depends_on: [] }],
        },
      });
      const state: MockRegistryState = {
        grips: [grip],
        arms: [armWithoutGit, armWithGit],
        missions: [mission],
      };
      const registry = createMockRegistry(state);
      const eventLog = createMockEventLog();
      const scheduler = new SchedulerService(registry, eventLog, makeConfig());

      // Only node-git has the capability
      scheduler.setNodeCapabilities("node-git", ["tool.git", "tool.node"]);
      scheduler.setNodeCapabilities("node-nogit", ["tool.node"]);

      const result = scheduler.assignNextGrip();
      expect(result).not.toBeNull();
      expect(result!.armId).toBe("arm-git");
    });

    it("allows any arm when grip has no desired_capabilities", () => {
      const grip = makeGrip({
        grip_id: "g1",
        mission_id: "m1",
        status: "queued",
        spec: makeGripSpec({ mission_id: "m1" }),
        // no desired_capabilities on spec
      });
      const arm = makeArm({
        arm_id: "arm-1",
        node_id: "node-1",
        mission_id: "m1",
        state: "idle",
      });
      const mission = makeMission({
        mission_id: "m1",
        spec: {
          spec_version: 1,
          title: "m",
          owner: "o",
          graph: [{ grip_id: "g1", depends_on: [] }],
        },
      });
      const state: MockRegistryState = {
        grips: [grip],
        arms: [arm],
        missions: [mission],
      };
      const registry = createMockRegistry(state);
      const eventLog = createMockEventLog();
      const scheduler = new SchedulerService(registry, eventLog, makeConfig());

      // Node has no capabilities registered — should still be eligible
      const result = scheduler.assignNextGrip();
      expect(result).not.toBeNull();
      expect(result!.armId).toBe("arm-1");
    });

    it("returns null when no arm's node has required capabilities", () => {
      const grip = makeGrip({
        grip_id: "g1",
        mission_id: "m1",
        status: "queued",
        spec: makeGripSpec({
          mission_id: "m1",
          desired_capabilities: ["runtime.acp.codex"],
        }),
      });
      const arm = makeArm({
        arm_id: "arm-1",
        node_id: "node-1",
        mission_id: "m1",
        state: "idle",
      });
      const mission = makeMission({
        mission_id: "m1",
        spec: {
          spec_version: 1,
          title: "m",
          owner: "o",
          graph: [{ grip_id: "g1", depends_on: [] }],
        },
      });
      const state: MockRegistryState = {
        grips: [grip],
        arms: [arm],
        missions: [mission],
      };
      const registry = createMockRegistry(state);
      const eventLog = createMockEventLog();
      const scheduler = new SchedulerService(registry, eventLog, makeConfig());

      // node-1 has no capabilities at all
      scheduler.setNodeCapabilities("node-1", ["tool.git"]);

      const result = scheduler.assignNextGrip();
      expect(result).toBeNull();
    });

    it("requires ALL desired capabilities, not just some", () => {
      const grip = makeGrip({
        grip_id: "g1",
        mission_id: "m1",
        status: "queued",
        spec: makeGripSpec({
          mission_id: "m1",
          desired_capabilities: ["tool.git", "tool.docker"],
        }),
      });
      const armPartial = makeArm({
        arm_id: "arm-partial",
        node_id: "node-partial",
        mission_id: "m1",
        state: "idle",
      });
      const armFull = makeArm({
        arm_id: "arm-full",
        node_id: "node-full",
        mission_id: "m1",
        state: "idle",
      });
      const mission = makeMission({
        mission_id: "m1",
        spec: {
          spec_version: 1,
          title: "m",
          owner: "o",
          graph: [{ grip_id: "g1", depends_on: [] }],
        },
      });
      const state: MockRegistryState = {
        grips: [grip],
        arms: [armPartial, armFull],
        missions: [mission],
      };
      const registry = createMockRegistry(state);
      const eventLog = createMockEventLog();
      const scheduler = new SchedulerService(registry, eventLog, makeConfig());

      // node-partial has git but not docker
      scheduler.setNodeCapabilities("node-partial", ["tool.git"]);
      // node-full has both
      scheduler.setNodeCapabilities("node-full", ["tool.git", "tool.docker", "tool.node"]);

      const result = scheduler.assignNextGrip();
      expect(result).not.toBeNull();
      expect(result!.armId).toBe("arm-full");
    });
  });
});
