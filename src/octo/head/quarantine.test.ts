// Octopus Orchestrator -- QuarantineService tests (M5-04)
//
// Covers: quarantine transitions arm, release transitions back,
// shouldAutoQuarantine threshold, below threshold returns false,
// events emitted on quarantine and release, release records operator.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OctoQuarantineConfig } from "../config/schema.ts";
import type { ArmSpec } from "../wire/schema.ts";
import { EventLogService } from "./event-log.ts";
import { QuarantineService } from "./quarantine.ts";
import { RegistryService, type ArmInput } from "./registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "./storage/migrate.ts";

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp DB + event log harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;
let db: DatabaseSync;
let registry: RegistryService;
let eventLog: EventLogService;
let service: QuarantineService;
let eventsPath: string;

const DEFAULT_QUARANTINE_CONFIG: OctoQuarantineConfig = {
  maxRestarts: 3,
  nodeFailureWindow: 10,
  nodeFailureWindowS: 600,
};

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-quarantine-test-"));
  const dbPath = path.join(tempDir, "registry.sqlite");
  db = openOctoRegistry({ path: dbPath });
  registry = new RegistryService(db);
  eventsPath = path.join(tempDir, "events.jsonl");
  eventLog = new EventLogService({ path: eventsPath });
  service = new QuarantineService(registry, eventLog, DEFAULT_QUARANTINE_CONFIG);
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
// Helpers
// ──────────────────────────────────────────────────────────────────────────

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
    state: "pending",
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

/** Put an arm into the given state by walking it through the FSM. */
function seedArm(armId: string, targetState: string, restartCount = 0): void {
  const input = makeArmInput({ arm_id: armId, restart_count: restartCount });
  registry.putArm(input);

  // Walk through valid transitions to reach the target state.
  const paths: Record<string, string[]> = {
    pending: [],
    starting: ["starting"],
    active: ["starting", "active"],
    quarantined: ["starting", "active", "quarantined"],
    failed: ["starting", "failed"],
  };

  const steps = paths[targetState];
  if (!steps) {
    throw new Error(`seedArm: unsupported target state: ${targetState}`);
  }

  let version = 0;
  for (const step of steps) {
    registry.casUpdateArm(armId, version, { state: step, updated_at: Date.now() });
    version++;
  }
}

function readEvents(): Array<Record<string, unknown>> {
  try {
    const content = readFileSync(eventsPath, "utf8").trim();
    if (!content) {
      return [];
    }
    return content.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("QuarantineService", () => {
  // 1. quarantine transitions arm to quarantined
  it("quarantine transitions arm state to quarantined", async () => {
    seedArm("arm-q1", "active");
    await service.quarantine("arm-q1", "too many restarts");

    const arm = registry.getArm("arm-q1");
    expect(arm).not.toBeNull();
    expect(arm!.state).toBe("quarantined");
  });

  // 2. release transitions quarantined arm back to starting
  it("release transitions quarantined arm to starting", async () => {
    seedArm("arm-r1", "quarantined");
    await service.release("arm-r1", "operator-alice");

    const arm = registry.getArm("arm-r1");
    expect(arm).not.toBeNull();
    expect(arm!.state).toBe("starting");
  });

  // 3. shouldAutoQuarantine returns true at threshold
  it("shouldAutoQuarantine returns true when restart_count >= maxRestarts", () => {
    seedArm("arm-at", "active", 3);
    const arm = registry.getArm("arm-at")!;
    expect(service.shouldAutoQuarantine(arm)).toBe(true);
  });

  // 4. shouldAutoQuarantine returns false below threshold
  it("shouldAutoQuarantine returns false when restart_count < maxRestarts", () => {
    seedArm("arm-bt", "active", 2);
    const arm = registry.getArm("arm-bt")!;
    expect(service.shouldAutoQuarantine(arm)).toBe(false);
  });

  // 5. quarantine emits arm.quarantined event
  it("quarantine emits arm.quarantined event with reason", async () => {
    seedArm("arm-ev1", "active");
    await service.quarantine("arm-ev1", "crash loop");

    const events = readEvents();
    const qEvent = events.find((e) => e.event_type === "arm.quarantined");
    expect(qEvent).toBeDefined();
    expect(qEvent!.entity_type).toBe("arm");
    expect(qEvent!.entity_id).toBe("arm-ev1");
    expect(qEvent!.actor).toBe("system");
    expect((qEvent!.payload as Record<string, unknown>).reason).toBe("crash loop");
  });

  // 6. release emits arm.recovered event with operator actor
  it("release emits arm.recovered event with operator as actor", async () => {
    seedArm("arm-ev2", "quarantined");
    await service.release("arm-ev2", "operator-bob");

    const events = readEvents();
    const rEvent = events.find((e) => e.event_type === "arm.recovered");
    expect(rEvent).toBeDefined();
    expect(rEvent!.entity_type).toBe("arm");
    expect(rEvent!.entity_id).toBe("arm-ev2");
    expect(rEvent!.actor).toBe("operator-bob");
  });

  // 7. shouldAutoQuarantine returns true above threshold
  it("shouldAutoQuarantine returns true when restart_count exceeds maxRestarts", () => {
    seedArm("arm-above", "active", 5);
    const arm = registry.getArm("arm-above")!;
    expect(service.shouldAutoQuarantine(arm)).toBe(true);
  });

  // 8. quarantine throws for unknown arm
  it("quarantine throws when arm does not exist", async () => {
    await expect(service.quarantine("nonexistent", "reason")).rejects.toThrow("arm not found");
  });

  // 9. release throws for unknown arm
  it("release throws when arm does not exist", async () => {
    await expect(service.release("nonexistent", "op")).rejects.toThrow("arm not found");
  });
});
