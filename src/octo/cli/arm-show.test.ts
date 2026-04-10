// Octopus Orchestrator — `openclaw octo arm show` tests (M1-19)
//
// Covers:
//   - gatherArmShow: returns null for unknown arm, returns arm + events for known arm
//   - formatArmShow: human-readable detail view, fields present
//   - formatArmShowJson: valid JSON round-trip
//   - runArmShow: exit 0 on found, exit 1 on unknown, json mode

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLogService } from "../head/event-log.ts";
import { type ArmInput, type MissionInput, RegistryService } from "../head/registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "../head/storage/migrate.ts";
import type { ArmSpec, MissionSpec } from "../wire/schema.ts";
import {
  type ArmShowResult,
  formatArmShow,
  formatArmShowJson,
  gatherArmShow,
  runArmShow,
} from "./arm-show.ts";

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp DB + event log harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;
let db: DatabaseSync;
let registry: RegistryService;
let eventLog: EventLogService;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-arm-show-test-"));
  const dbPath = path.join(tempDir, "registry.sqlite");
  db = openOctoRegistry({ path: dbPath });
  registry = new RegistryService(db);
  eventLog = new EventLogService({ path: path.join(tempDir, "events.jsonl") });
});

afterEach(() => {
  try {
    closeOctoRegistry(db);
  } catch {
    // already closed
  }
  rmSync(tempDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────
// Factory helpers
// ──────────────────────────────────────────────────────────────────────────

function makeMissionSpec(overrides: Partial<MissionSpec> = {}): MissionSpec {
  return {
    spec_version: 1,
    title: "test mission",
    owner: "tester",
    graph: [{ grip_id: "g1", depends_on: [] }],
    ...overrides,
  };
}

function makeMissionInput(overrides: Partial<MissionInput> = {}): MissionInput {
  return {
    mission_id: `mission-${Math.random().toString(36).slice(2, 10)}`,
    title: "test mission",
    owner: "tester",
    status: "active",
    policy_profile_ref: null,
    spec: makeMissionSpec(),
    metadata: null,
    ...overrides,
  };
}

function makeArmSpec(overrides: Partial<ArmSpec> = {}): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "mission-1",
    adapter_type: "cli_exec",
    runtime_name: "claude-cli",
    agent_id: "agent-1",
    cwd: "/tmp",
    idempotency_key: "idem-1",
    runtime_options: { command: "echo" },
    ...overrides,
  };
}

function makeArmInput(overrides: Partial<ArmInput> = {}): ArmInput {
  return {
    arm_id: `arm-${Math.random().toString(36).slice(2, 10)}`,
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
    spec: makeArmSpec(),
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════
// gatherArmShow
// ════════════════════════════════════════════════════════════════════════

describe("gatherArmShow", () => {
  it("returns null for unknown arm_id", async () => {
    const result = await gatherArmShow(registry, eventLog, "arm-nonexistent");
    expect(result).toBeNull();
  });

  it("returns arm record for known arm_id", async () => {
    registry.putMission(makeMissionInput({ mission_id: "mission-1" }));
    registry.putArm(makeArmInput({ arm_id: "arm-abc", state: "active" }));

    const result = await gatherArmShow(registry, eventLog, "arm-abc");
    expect(result).not.toBeNull();
    expect(result!.arm.arm_id).toBe("arm-abc");
    expect(result!.arm.state).toBe("active");
  });

  it("includes recent events filtered by entity_id", async () => {
    registry.putMission(makeMissionInput({ mission_id: "mission-1" }));
    registry.putArm(makeArmInput({ arm_id: "arm-abc" }));

    // Append events for this arm
    await eventLog.append({
      schema_version: 1,
      entity_type: "arm",
      entity_id: "arm-abc",
      event_type: "arm.created",
      actor: "test",
      payload: {},
    });
    await eventLog.append({
      schema_version: 1,
      entity_type: "arm",
      entity_id: "arm-abc",
      event_type: "arm.active",
      actor: "test",
      payload: {},
    });

    // Append event for a different arm (should be excluded)
    await eventLog.append({
      schema_version: 1,
      entity_type: "arm",
      entity_id: "arm-other",
      event_type: "arm.failed",
      actor: "test",
      payload: {},
    });

    const result = await gatherArmShow(registry, eventLog, "arm-abc");
    expect(result).not.toBeNull();
    expect(result!.recent_events).toHaveLength(2);
    expect(result!.recent_events[0].event_type).toBe("arm.created");
    expect(result!.recent_events[1].event_type).toBe("arm.active");
  });

  it("limits to last 20 events", async () => {
    registry.putMission(makeMissionInput({ mission_id: "mission-1" }));
    registry.putArm(makeArmInput({ arm_id: "arm-abc" }));

    // Append 25 events
    for (let i = 0; i < 25; i++) {
      await eventLog.append({
        schema_version: 1,
        entity_type: "arm",
        entity_id: "arm-abc",
        event_type: "arm.active",
        actor: "test",
        payload: { seq: i },
      });
    }

    const result = await gatherArmShow(registry, eventLog, "arm-abc");
    expect(result).not.toBeNull();
    expect(result!.recent_events).toHaveLength(20);
    // Should be the last 20 (seq 5..24)
    expect((result!.recent_events[0].payload as Record<string, unknown>).seq).toBe(5);
    expect((result!.recent_events[19].payload as Record<string, unknown>).seq).toBe(24);
  });
});

// ════════════════════════════════════════════════════════════════════════
// formatArmShow
// ════════════════════════════════════════════════════════════════════════

describe("formatArmShow", () => {
  it("produces human-readable output with arm fields", () => {
    const result: ArmShowResult = {
      arm: {
        arm_id: "arm-123",
        mission_id: "mission-1",
        node_id: "node-1",
        adapter_type: "cli_exec",
        runtime_name: "claude-cli",
        agent_id: "agent-1",
        task_ref: null,
        state: "active",
        current_grip_id: "grip-42",
        lease_owner: "node-1",
        lease_expiry_ts: 1700000000000,
        session_ref: null,
        checkpoint_ref: "chk-99",
        health_status: "healthy",
        restart_count: 2,
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
        created_at: 1699900000000,
        updated_at: 1699999000000,
        version: 5,
      },
      recent_events: [
        {
          event_id: "01H0000000TEST00000001",
          schema_version: 1,
          entity_type: "arm",
          entity_id: "arm-123",
          event_type: "arm.created",
          ts: "2024-01-01T00:00:00.000Z",
          actor: "operator",
          payload: {},
        },
      ],
    };

    const output = formatArmShow(result);

    expect(output).toContain("Arm: arm-123");
    expect(output).toContain("active");
    expect(output).toContain("mission-1");
    expect(output).toContain("node-1");
    expect(output).toContain("grip-42");
    expect(output).toContain("chk-99");
    expect(output).toContain("healthy");
    expect(output).toContain("Lease:");
    expect(output).toContain("node-1");
    expect(output).toContain("Timestamps:");
    expect(output).toContain("Recent Events (1):");
    expect(output).toContain("arm.created");
    expect(output).toContain("operator");
  });

  it("shows dash for null fields", () => {
    const result: ArmShowResult = {
      arm: {
        arm_id: "arm-456",
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
        created_at: 1699900000000,
        updated_at: 1699900000000,
        version: 1,
      },
      recent_events: [],
    };

    const output = formatArmShow(result);

    expect(output).toContain("Current grip:      -");
    expect(output).toContain("Checkpoint:        -");
    expect(output).toContain("Recent Events: none");
  });
});

// ════════════════════════════════════════════════════════════════════════
// formatArmShowJson
// ════════════════════════════════════════════════════════════════════════

describe("formatArmShowJson", () => {
  it("produces valid JSON that round-trips to the input", () => {
    const result: ArmShowResult = {
      arm: {
        arm_id: "arm-789",
        mission_id: "mission-1",
        node_id: "node-1",
        adapter_type: "cli_exec",
        runtime_name: "claude-cli",
        agent_id: "agent-1",
        task_ref: null,
        state: "blocked",
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
        created_at: 1699900000000,
        updated_at: 1699900000000,
        version: 1,
      },
      recent_events: [],
    };

    const json = formatArmShowJson(result);
    const parsed = JSON.parse(json) as ArmShowResult;

    expect(parsed).toEqual(result);
  });
});

// ════════════════════════════════════════════════════════════════════════
// runArmShow
// ════════════════════════════════════════════════════════════════════════

describe("runArmShow", () => {
  it("returns 1 for unknown arm_id", async () => {
    const out = { write: vi.fn() };
    const code = await runArmShow(registry, eventLog, "arm-nonexistent", {}, out);

    expect(code).toBe(1);
    const written = (out.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written).toContain("unknown arm_id");
    expect(written).toContain("arm-nonexistent");
  });

  it("returns 0 for known arm_id", async () => {
    registry.putMission(makeMissionInput({ mission_id: "mission-1" }));
    registry.putArm(makeArmInput({ arm_id: "arm-abc", state: "active" }));

    const out = { write: vi.fn() };
    const code = await runArmShow(registry, eventLog, "arm-abc", {}, out);

    expect(code).toBe(0);
    expect(out.write).toHaveBeenCalled();
    const written = (out.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written).toContain("arm-abc");
    expect(written).toContain("active");
  });

  it("with json: true produces JSON output", async () => {
    registry.putMission(makeMissionInput({ mission_id: "mission-1" }));
    registry.putArm(makeArmInput({ arm_id: "arm-json", state: "idle" }));

    const out = { write: vi.fn() };
    const code = await runArmShow(registry, eventLog, "arm-json", { json: true }, out);

    expect(code).toBe(0);
    const written = (out.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written.trimStart().startsWith("{")).toBe(true);

    const parsed = JSON.parse(written) as ArmShowResult;
    expect(parsed.arm.arm_id).toBe("arm-json");
    expect(parsed.arm.state).toBe("idle");
    expect(Array.isArray(parsed.recent_events)).toBe(true);
  });

  it("writes to the provided output stream", async () => {
    registry.putMission(makeMissionInput({ mission_id: "mission-1" }));
    registry.putArm(makeArmInput({ arm_id: "arm-out", state: "active" }));

    const out = { write: vi.fn() };
    await runArmShow(registry, eventLog, "arm-out", {}, out);

    expect(out.write).toHaveBeenCalledTimes(1);
    expect(typeof out.write.mock.calls[0][0]).toBe("string");
  });
});
