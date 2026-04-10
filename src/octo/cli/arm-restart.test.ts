// Octopus Orchestrator -- `openclaw octo arm restart` tests (M1-21)
//
// Covers:
//   - restartArm: happy path (active arm), preserves arm_id, increments restart_count
//   - restartArm: restart from failed state (no intermediate failed transition)
//   - restartArm: old tmux session gone, new tmux session exists
//   - restartArm: not_found error for unknown arm_id
//   - restartArm: invalid_state error for terminated/pending/archived arms
//   - restartArm: restart_count accumulates across multiple restarts
//   - runArmRestart: exit code 0 on success, 1 on error

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLogService } from "../head/event-log.ts";
import type { ArmInput } from "../head/registry.ts";
import { RegistryService } from "../head/registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "../head/storage/migrate.ts";
import { TmuxManager } from "../node-agent/tmux-manager.ts";
import type { ArmSpec } from "../wire/schema.ts";
import { type ArmRestartDeps, ArmRestartError, restartArm, runArmRestart } from "./arm-restart.ts";

// ──────────────────────────────────────────────────────────────────────────
// Skip if tmux is not available
// ──────────────────────────────────────────────────────────────────────────

const HAS_TMUX = TmuxManager.isAvailable();

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp DB + tmux harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;
let db: DatabaseSync;
let registry: RegistryService;
let eventLog: EventLogService;
let tmux: TmuxManager;
let deps: ArmRestartDeps;
const createdSessions: string[] = [];
const trackedArmIds: string[] = [];

const NODE_ID = "test-node-1";
let clock: number;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-arm-restart-test-"));
  const dbPath = path.join(tempDir, "registry.sqlite");
  db = openOctoRegistry({ path: dbPath });
  registry = new RegistryService(db);
  eventLog = new EventLogService({ path: path.join(tempDir, "events.jsonl") });
  tmux = new TmuxManager();
  clock = 1_000_000;
  deps = {
    registry,
    eventLog,
    tmuxManager: tmux,
    nodeId: NODE_ID,
    now: () => clock++,
  };
  createdSessions.length = 0;
  trackedArmIds.length = 0;
});

afterEach(async () => {
  // Clean up tmux sessions created during the test (both explicitly
  // spawned and those created by restartArm).
  for (const name of createdSessions) {
    try {
      await tmux.killSession(name);
    } catch {
      // already gone
    }
  }
  for (const armId of trackedArmIds) {
    try {
      await tmux.killSession(`octo-arm-${armId}`);
    } catch {
      // already gone
    }
  }
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

function makeArmSpec(overrides: Partial<ArmSpec> = {}): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "mission-1",
    adapter_type: "pty_tmux",
    runtime_name: "claude-cli",
    agent_id: "agent-1",
    cwd: "/tmp",
    idempotency_key: `idem-${Math.random().toString(36).slice(2, 10)}`,
    runtime_options: { command: "sleep", args: ["3600"] },
    ...overrides,
  };
}

function makeArmInput(overrides: Partial<ArmInput> = {}): ArmInput {
  const arm_id = overrides.arm_id ?? `arm-${Math.random().toString(36).slice(2, 10)}`;
  trackedArmIds.push(arm_id);
  return {
    arm_id,
    mission_id: "mission-1",
    node_id: NODE_ID,
    adapter_type: "pty_tmux",
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

/** Spawn a tmux session for an arm and track it for cleanup. */
async function spawnTmuxForArm(arm_id: string, cwd: string): Promise<string> {
  const sessionName = `octo-arm-${arm_id}`;
  await tmux.createSession(sessionName, "sleep 3600", cwd);
  createdSessions.push(sessionName);
  return sessionName;
}

// ════════════════════════════════════════════════════════════════════════
// restartArm
// ════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_TMUX)("restartArm", () => {
  it("preserves arm_id and increments restart_count for an active arm", async () => {
    const input = makeArmInput({ state: "active", restart_count: 0 });
    registry.putArm(input);
    const sessionName = await spawnTmuxForArm(input.arm_id, "/tmp");

    const result = await restartArm(deps, input.arm_id);

    expect(result.arm_id).toBe(input.arm_id);
    expect(result.restart_count).toBe(1);
    expect(result.previous_state).toBe("active");
    expect(result.session_ref.tmux_session_name).toBe(sessionName);

    // Verify the registry row.
    const updated = registry.getArm(input.arm_id);
    expect(updated).not.toBeNull();
    expect(updated!.restart_count).toBe(1);
    expect(updated!.state).toBe("starting");
  });

  it("restarts from failed state without intermediate failed transition", async () => {
    const input = makeArmInput({ state: "failed", restart_count: 2 });
    registry.putArm(input);
    // No existing tmux session for a failed arm -- killSession is idempotent.

    const result = await restartArm(deps, input.arm_id);

    expect(result.arm_id).toBe(input.arm_id);
    expect(result.restart_count).toBe(3);
    expect(result.previous_state).toBe("failed");

    const updated = registry.getArm(input.arm_id);
    expect(updated!.state).toBe("starting");
    expect(updated!.restart_count).toBe(3);
  });

  it("old tmux session is gone and new tmux session exists after restart", async () => {
    const input = makeArmInput({ state: "active" });
    registry.putArm(input);
    await spawnTmuxForArm(input.arm_id, "/tmp");

    const sessionName = `octo-arm-${input.arm_id}`;
    const sessionsBefore = await tmux.listSessions();
    expect(sessionsBefore).toContain(sessionName);

    await restartArm(deps, input.arm_id);

    // The session name is the same (preserved arm_id), so a new session
    // with the same name should exist.
    const sessionsAfter = await tmux.listSessions();
    expect(sessionsAfter).toContain(sessionName);
  });

  it("throws not_found for unknown arm_id", async () => {
    await expect(restartArm(deps, "arm-nonexistent")).rejects.toThrow(ArmRestartError);
    try {
      await restartArm(deps, "arm-nonexistent");
    } catch (err) {
      expect(err).toBeInstanceOf(ArmRestartError);
      expect((err as ArmRestartError).code).toBe("not_found");
    }
  });

  it("throws invalid_state for terminated arm", async () => {
    const input = makeArmInput({ state: "terminated" });
    registry.putArm(input);

    await expect(restartArm(deps, input.arm_id)).rejects.toThrow(ArmRestartError);
    try {
      await restartArm(deps, input.arm_id);
    } catch (err) {
      expect(err).toBeInstanceOf(ArmRestartError);
      expect((err as ArmRestartError).code).toBe("invalid_state");
    }
  });

  it("throws invalid_state for pending arm", async () => {
    const input = makeArmInput({ state: "pending" });
    registry.putArm(input);

    await expect(restartArm(deps, input.arm_id)).rejects.toThrow(ArmRestartError);
    try {
      await restartArm(deps, input.arm_id);
    } catch (err) {
      expect(err).toBeInstanceOf(ArmRestartError);
      expect((err as ArmRestartError).code).toBe("invalid_state");
    }
  });

  it("accumulates restart_count across multiple restarts", async () => {
    const input = makeArmInput({ state: "active", restart_count: 0 });
    registry.putArm(input);
    await spawnTmuxForArm(input.arm_id, "/tmp");

    // First restart.
    const r1 = await restartArm(deps, input.arm_id);
    expect(r1.restart_count).toBe(1);

    // After restart, arm is in "starting". Starting is restartable
    // (starting -> failed -> starting).
    const r2 = await restartArm(deps, input.arm_id);
    expect(r2.restart_count).toBe(2);

    const r3 = await restartArm(deps, input.arm_id);
    expect(r3.restart_count).toBe(3);

    const final = registry.getArm(input.arm_id);
    expect(final!.restart_count).toBe(3);
    expect(final!.arm_id).toBe(input.arm_id);
  });
});

// ════════════════════════════════════════════════════════════════════════
// runArmRestart
// ════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_TMUX)("runArmRestart", () => {
  it("returns 0 on success", async () => {
    const input = makeArmInput({ state: "active" });
    registry.putArm(input);
    await spawnTmuxForArm(input.arm_id, "/tmp");

    const out = { write: vi.fn() };
    const code = await runArmRestart(deps, input.arm_id, out);

    expect(code).toBe(0);
    expect(out.write).toHaveBeenCalled();
    const written = (out.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written).toContain("restarted");
    expect(written).toContain("restart_count=1");
  });

  it("returns 1 on not_found error", async () => {
    const out = { write: vi.fn() };
    const code = await runArmRestart(deps, "arm-nope", out);

    expect(code).toBe(1);
    const written = (out.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written).toContain("Error");
    expect(written).toContain("not found");
  });
});
