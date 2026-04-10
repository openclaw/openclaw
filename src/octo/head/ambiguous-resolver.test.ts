// Octopus Orchestrator -- AmbiguousResolver tests (M3-12)

import { describe, expect, it, vi } from "vitest";
import type { GripSpec } from "../wire/schema.ts";
import { AmbiguousResolver } from "./ambiguous-resolver.ts";
import type { AppendInput, EventLogService } from "./event-log.ts";
import type { ArmRecord, GripRecord, RegistryService } from "./registry.ts";

// ──────────────────────────────────────────────────────────────────────────
// Factory helpers
// ──────────────────────────────────────────────────────────────────────────

function makeGripSpec(overrides: Partial<GripSpec> = {}): GripSpec {
  return {
    spec_version: 1,
    mission_id: "mission-1",
    type: "read-files",
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
    grip_id: "grip-1",
    mission_id: "mission-1",
    type: "read-files",
    input_ref: null,
    priority: 1,
    assigned_arm_id: null,
    status: "completed",
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
    arm_id: "arm-a",
    mission_id: "mission-1",
    node_id: "node-1",
    adapter_type: "cli_exec",
    runtime_name: "claude-cli",
    agent_id: "agent-1",
    task_ref: null,
    state: "active",
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

// ──────────────────────────────────────────────────────────────────────────
// Mock registry + event log
// ──────────────────────────────────────────────────────────────────────────

interface MockRegistryState {
  grips: Map<string, GripRecord>;
  arms: Map<string, ArmRecord>;
}

function createMockRegistry(state: MockRegistryState): RegistryService {
  return {
    getGrip: vi.fn((id: string) => state.grips.get(id) ?? null),
    getArm: vi.fn((id: string) => state.arms.get(id) ?? null),
    casUpdateGrip: vi.fn((id: string, _ver: number, patch: Record<string, unknown>) => {
      const grip = state.grips.get(id);
      if (!grip) {
        throw new Error(`grip not found: ${id}`);
      }
      const updated = { ...grip, ...patch, version: grip.version + 1 };
      state.grips.set(id, updated);
      return updated;
    }),
    casUpdateArm: vi.fn((id: string, _ver: number, patch: Record<string, unknown>) => {
      const arm = state.arms.get(id);
      if (!arm) {
        throw new Error(`arm not found: ${id}`);
      }
      const updated = { ...arm, ...patch, version: arm.version + 1 };
      state.arms.set(id, updated);
      return updated;
    }),
  } as unknown as RegistryService;
}

function createMockEventLog(): EventLogService & { appended: AppendInput[] } {
  const appended: AppendInput[] = [];
  return {
    appended,
    append: vi.fn(async (input: AppendInput) => {
      appended.push(input);
      return {
        event_id: "evt-1",
        ...input,
        ts: input.ts ?? new Date().toISOString(),
      };
    }),
  } as unknown as EventLogService & { appended: AppendInput[] };
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("AmbiguousResolver", () => {
  // 1. Read-only grip auto-resolves by lowest arm_id
  it("auto-resolves read-only grips by lowest arm_id lexicographic", async () => {
    const grip = makeGrip({ grip_id: "g1", type: "read-files", side_effecting: false });
    const armA = makeArm({ arm_id: "arm-a" });
    const armB = makeArm({ arm_id: "arm-b" });
    const state: MockRegistryState = {
      grips: new Map([["g1", grip]]),
      arms: new Map([
        ["arm-a", armA],
        ["arm-b", armB],
      ]),
    };
    const registry = createMockRegistry(state);
    const eventLog = createMockEventLog();
    const resolver = new AmbiguousResolver(registry, eventLog);

    const result = await resolver.onGripAmbiguous("g1", "arm-a", "arm-b", "ref-a", "ref-b");

    expect(result.resolution).toBe("auto");
    expect(result.selectedArmId).toBe("arm-a");
  });

  // 2. Side-effecting grip requires operator
  it("returns operator_required for side-effecting grips", async () => {
    const grip = makeGrip({
      grip_id: "g2",
      type: "deploy",
      side_effecting: true,
      idempotency_key: "idem-1",
      spec: makeGripSpec({ type: "deploy", side_effecting: true, idempotency_key: "idem-1" }),
    });
    const armA = makeArm({ arm_id: "arm-x" });
    const armB = makeArm({ arm_id: "arm-y" });
    const state: MockRegistryState = {
      grips: new Map([["g2", grip]]),
      arms: new Map([
        ["arm-x", armA],
        ["arm-y", armB],
      ]),
    };
    const registry = createMockRegistry(state);
    const eventLog = createMockEventLog();
    const resolver = new AmbiguousResolver(registry, eventLog);

    const result = await resolver.onGripAmbiguous("g2", "arm-x", "arm-y", "ref-x", "ref-y");

    expect(result.resolution).toBe("operator_required");
    expect(result.selectedArmId).toBeUndefined();
  });

  // 3. Non-read-only type with side_effecting=false requires operator
  it("returns operator_required for non-read-only type even when not side-effecting", async () => {
    const grip = makeGrip({ grip_id: "g3", type: "code-edit", side_effecting: false });
    const armA = makeArm({ arm_id: "arm-a" });
    const armB = makeArm({ arm_id: "arm-b" });
    const state: MockRegistryState = {
      grips: new Map([["g3", grip]]),
      arms: new Map([
        ["arm-a", armA],
        ["arm-b", armB],
      ]),
    };
    const registry = createMockRegistry(state);
    const eventLog = createMockEventLog();
    const resolver = new AmbiguousResolver(registry, eventLog);

    const result = await resolver.onGripAmbiguous("g3", "arm-a", "arm-b", "ref-a", "ref-b");

    expect(result.resolution).toBe("operator_required");
  });

  // 4. grip.ambiguous event is emitted with both arm_ids and result_refs
  it("emits grip.ambiguous event with both arm_ids and result_refs", async () => {
    const grip = makeGrip({ grip_id: "g4", type: "query-db", side_effecting: false });
    const armA = makeArm({ arm_id: "arm-1" });
    const armB = makeArm({ arm_id: "arm-2" });
    const state: MockRegistryState = {
      grips: new Map([["g4", grip]]),
      arms: new Map([
        ["arm-1", armA],
        ["arm-2", armB],
      ]),
    };
    const registry = createMockRegistry(state);
    const eventLog = createMockEventLog();
    const resolver = new AmbiguousResolver(registry, eventLog);

    await resolver.onGripAmbiguous("g4", "arm-1", "arm-2", "ref-1", "ref-2");

    expect(eventLog.appended).toHaveLength(1);
    const evt = eventLog.appended[0];
    expect(evt.entity_type).toBe("grip");
    expect(evt.entity_id).toBe("g4");
    expect(evt.event_type).toBe("grip.ambiguous");
    expect(evt.payload).toEqual({
      arm_id_a: "arm-1",
      arm_id_b: "arm-2",
      result_ref_a: "ref-1",
      result_ref_b: "ref-2",
    });
  });

  // 5. resolve() selects winner and emits resolution event
  it("resolve selects winner arm and emits grip.completed event", async () => {
    const grip = makeGrip({ grip_id: "g5", status: "blocked" });
    const state: MockRegistryState = {
      grips: new Map([["g5", grip]]),
      arms: new Map(),
    };
    const registry = createMockRegistry(state);
    const eventLog = createMockEventLog();
    const resolver = new AmbiguousResolver(registry, eventLog);

    await resolver.resolve("g5", "arm-winner");

    expect(registry.casUpdateGrip).toHaveBeenCalledWith("g5", grip.version, {
      assigned_arm_id: "arm-winner",
      status: "completed",
    });
    expect(eventLog.appended).toHaveLength(1);
    const evt = eventLog.appended[0];
    expect(evt.event_type).toBe("grip.completed");
    expect(evt.payload).toEqual({
      resolution: "operator",
      selected_arm_id: "arm-winner",
    });
  });

  // 6. Both arms are quarantined on ambiguous detection
  it("quarantines both arms when ambiguity is detected", async () => {
    const grip = makeGrip({ grip_id: "g6", type: "fetch-data", side_effecting: false });
    const armA = makeArm({ arm_id: "arm-p", state: "active" });
    const armB = makeArm({ arm_id: "arm-q", state: "active" });
    const state: MockRegistryState = {
      grips: new Map([["g6", grip]]),
      arms: new Map([
        ["arm-p", armA],
        ["arm-q", armB],
      ]),
    };
    const registry = createMockRegistry(state);
    const eventLog = createMockEventLog();
    const resolver = new AmbiguousResolver(registry, eventLog);

    await resolver.onGripAmbiguous("g6", "arm-p", "arm-q", "ref-p", "ref-q");

    // Both arms should be quarantined.
    const updatedP = state.arms.get("arm-p")!;
    const updatedQ = state.arms.get("arm-q")!;
    expect(updatedP.state).toBe("quarantined");
    expect(updatedQ.state).toBe("quarantined");
  });

  // 7. Auto-resolve picks armB when armB < armA lexicographically
  it("auto-resolve picks second arm when it sorts lower", async () => {
    const grip = makeGrip({ grip_id: "g7", type: "read-config", side_effecting: false });
    const armA = makeArm({ arm_id: "arm-z" });
    const armB = makeArm({ arm_id: "arm-a" });
    const state: MockRegistryState = {
      grips: new Map([["g7", grip]]),
      arms: new Map([
        ["arm-z", armA],
        ["arm-a", armB],
      ]),
    };
    const registry = createMockRegistry(state);
    const eventLog = createMockEventLog();
    const resolver = new AmbiguousResolver(registry, eventLog);

    const result = await resolver.onGripAmbiguous("g7", "arm-z", "arm-a", "ref-z", "ref-a");

    expect(result.resolution).toBe("auto");
    expect(result.selectedArmId).toBe("arm-a");
  });

  // 8. Throws when grip not found
  it("throws when grip does not exist", async () => {
    const state: MockRegistryState = {
      grips: new Map(),
      arms: new Map(),
    };
    const registry = createMockRegistry(state);
    const eventLog = createMockEventLog();
    const resolver = new AmbiguousResolver(registry, eventLog);

    await expect(
      resolver.onGripAmbiguous("missing", "arm-a", "arm-b", "ref-a", "ref-b"),
    ).rejects.toThrow("grip not found");
  });
});
