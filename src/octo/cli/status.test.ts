// Octopus Orchestrator — `openclaw octo status` tests (M1-17)
//
// Covers:
//   - gatherOctoStatus: zero counts on empty registry, correct counts after populating
//   - formatOctoStatus: human-readable output, empty state message
//   - formatOctoStatusJson: valid JSON round-trip
//   - runOctoStatus: exit code 0 (empty + populated), json mode, output stream mock

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ArmInput,
  type ClaimInput,
  type GripInput,
  type MissionInput,
  RegistryService,
} from "../head/registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "../head/storage/migrate.ts";
import type { ArmSpec, GripSpec, MissionSpec } from "../wire/schema.ts";
import {
  type OctoStatusResult,
  formatOctoStatus,
  formatOctoStatusJson,
  gatherOctoStatus,
  runOctoStatus,
} from "./status.ts";

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp DB harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;
let db: DatabaseSync;
let registry: RegistryService;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-status-test-"));
  const dbPath = path.join(tempDir, "registry.sqlite");
  db = openOctoRegistry({ path: dbPath });
  registry = new RegistryService(db);
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
// Factory helpers — minimal valid inputs
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

function makeGripInput(overrides: Partial<GripInput> = {}): GripInput {
  return {
    grip_id: `grip-${Math.random().toString(36).slice(2, 10)}`,
    mission_id: "mission-1",
    type: "code-edit",
    input_ref: null,
    priority: 0,
    assigned_arm_id: null,
    status: "queued",
    timeout_s: 300,
    side_effecting: false,
    idempotency_key: null,
    result_ref: null,
    spec: makeGripSpec(),
    ...overrides,
  };
}

function makeClaimInput(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    claim_id: `claim-${Math.random().toString(36).slice(2, 10)}`,
    mission_id: "mission-1",
    grip_id: "grip-1",
    resource_type: "file",
    resource_key: "/tmp/x",
    owner_arm_id: "arm-1",
    mode: "exclusive",
    lease_expiry_ts: Date.now() + 60_000,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════
// gatherOctoStatus
// ════════════════════════════════════════════════════════════════════════

describe("gatherOctoStatus", () => {
  it("returns zero counts on empty registry", () => {
    const result = gatherOctoStatus(registry);

    expect(result.missions.total).toBe(0);
    expect(result.missions.active).toBe(0);
    expect(result.missions.paused).toBe(0);
    expect(result.missions.completed).toBe(0);
    expect(result.missions.aborted).toBe(0);

    expect(result.arms.total).toBe(0);
    expect(result.arms.active).toBe(0);
    expect(result.arms.idle).toBe(0);
    expect(result.arms.blocked).toBe(0);
    expect(result.arms.failed).toBe(0);
    expect(result.arms.starting).toBe(0);

    expect(result.grips.total).toBe(0);
    expect(result.grips.queued).toBe(0);
    expect(result.grips.running).toBe(0);
    expect(result.grips.completed).toBe(0);
    expect(result.grips.failed).toBe(0);

    expect(result.claims.total).toBe(0);
  });

  it("returns correct counts after populating", () => {
    // 2 missions: 1 active, 1 paused
    registry.putMission(makeMissionInput({ status: "active" }));
    registry.putMission(makeMissionInput({ status: "paused" }));

    // 3 arms: 2 active, 1 idle
    registry.putArm(makeArmInput({ state: "active" }));
    registry.putArm(makeArmInput({ state: "active" }));
    registry.putArm(makeArmInput({ state: "idle" }));

    // 4 grips: 2 queued, 1 running, 1 completed
    registry.putGrip(makeGripInput({ status: "queued" }));
    registry.putGrip(makeGripInput({ status: "queued" }));
    registry.putGrip(makeGripInput({ status: "running" }));
    registry.putGrip(makeGripInput({ status: "completed" }));

    // 1 claim
    registry.putClaim(makeClaimInput());

    const result = gatherOctoStatus(registry);

    expect(result.missions.total).toBe(2);
    expect(result.missions.active).toBe(1);
    expect(result.missions.paused).toBe(1);
    expect(result.missions.completed).toBe(0);
    expect(result.missions.aborted).toBe(0);

    expect(result.arms.total).toBe(3);
    expect(result.arms.active).toBe(2);
    expect(result.arms.idle).toBe(1);
    expect(result.arms.blocked).toBe(0);
    expect(result.arms.failed).toBe(0);
    expect(result.arms.starting).toBe(0);

    expect(result.grips.total).toBe(4);
    expect(result.grips.queued).toBe(2);
    expect(result.grips.running).toBe(1);
    expect(result.grips.completed).toBe(1);
    expect(result.grips.failed).toBe(0);

    expect(result.claims.total).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// formatOctoStatus
// ════════════════════════════════════════════════════════════════════════

describe("formatOctoStatus", () => {
  it("produces human-readable output with correct counts", () => {
    const result: OctoStatusResult = {
      missions: { total: 3, active: 2, paused: 1, completed: 0, aborted: 0 },
      arms: { total: 5, active: 3, idle: 1, blocked: 0, failed: 0, starting: 1 },
      grips: { total: 8, queued: 2, running: 3, completed: 2, failed: 1 },
      claims: { total: 2 },
    };

    const output = formatOctoStatus(result);

    expect(output).toContain("Octopus Orchestrator Status");
    expect(output).toContain("3 total");
    expect(output).toContain("2 active");
    expect(output).toContain("1 paused");
    expect(output).toContain("Arms:");
    expect(output).toContain("3 active");
    expect(output).toContain("1 starting");
    expect(output).toContain("Grips:");
    expect(output).toContain("2 queued");
    expect(output).toContain("3 running");
    expect(output).toContain("1 failed");
    expect(output).toContain("Claims:");
  });

  it("handles empty state", () => {
    const result: OctoStatusResult = {
      missions: { total: 0, active: 0, paused: 0, completed: 0, aborted: 0 },
      arms: { total: 0, active: 0, idle: 0, blocked: 0, failed: 0, starting: 0 },
      grips: { total: 0, queued: 0, running: 0, completed: 0, failed: 0 },
      claims: { total: 0 },
    };

    const output = formatOctoStatus(result);

    expect(output).toContain("No missions");
  });
});

// ════════════════════════════════════════════════════════════════════════
// formatOctoStatusJson
// ════════════════════════════════════════════════════════════════════════

describe("formatOctoStatusJson", () => {
  it("produces valid JSON that round-trips to the input", () => {
    const result: OctoStatusResult = {
      missions: { total: 1, active: 1, paused: 0, completed: 0, aborted: 0 },
      arms: { total: 2, active: 1, idle: 1, blocked: 0, failed: 0, starting: 0 },
      grips: { total: 3, queued: 1, running: 1, completed: 1, failed: 0 },
      claims: { total: 0 },
    };

    const json = formatOctoStatusJson(result);
    const parsed = JSON.parse(json) as OctoStatusResult;

    expect(parsed).toEqual(result);
  });
});

// ════════════════════════════════════════════════════════════════════════
// runOctoStatus
// ════════════════════════════════════════════════════════════════════════

describe("runOctoStatus", () => {
  it("returns 0 on empty state", () => {
    const out = { write: vi.fn() };
    const code = runOctoStatus(registry, {}, out);

    expect(code).toBe(0);
    expect(out.write).toHaveBeenCalled();
  });

  it("returns 0 on populated state", () => {
    registry.putMission(makeMissionInput({ status: "active" }));
    registry.putArm(makeArmInput({ state: "active" }));

    const out = { write: vi.fn() };
    const code = runOctoStatus(registry, {}, out);

    expect(code).toBe(0);
  });

  it("with json: true produces JSON output", () => {
    registry.putMission(makeMissionInput({ status: "active" }));
    registry.putArm(makeArmInput({ state: "idle" }));

    const out = { write: vi.fn() };
    const code = runOctoStatus(registry, { json: true }, out);

    expect(code).toBe(0);
    const written = (out.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written.trimStart().startsWith("{")).toBe(true);

    const parsed = JSON.parse(written) as OctoStatusResult;
    expect(parsed.missions.total).toBe(1);
    expect(parsed.missions.active).toBe(1);
    expect(parsed.arms.total).toBe(1);
    expect(parsed.arms.idle).toBe(1);
  });

  it("writes to the provided output stream", () => {
    const out = { write: vi.fn() };
    runOctoStatus(registry, {}, out);

    expect(out.write).toHaveBeenCalledTimes(1);
    expect(typeof out.write.mock.calls[0][0]).toBe("string");
  });
});
