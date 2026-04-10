// Octopus Orchestrator -- `openclaw octo arm terminate` tests (M1-22)
//
// Covers:
//   - happy path: terminate an active arm, exit 0
//   - unknown arm: exit 1 with error message
//   - already terminated: idempotent success, exit 0
//   - json output: --json flag produces valid JSON
//   - missing reason: validation error, exit 1
//   - missing arm_id: validation error, exit 1

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
import { OctoGatewayHandlers } from "../wire/gateway-handlers.ts";
import type { ArmSpec } from "../wire/schema.ts";
import {
  formatArmTerminate,
  formatArmTerminateJson,
  runArmTerminate,
  validateArmTerminateOptions,
} from "./arm-terminate.ts";

// ──────────────────────────────────────────────────────────────────────────
// Skip if tmux is not available
// ──────────────────────────────────────────────────────────────────────────

const tmuxAvailable = TmuxManager.isAvailable();

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp DB + gateway harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;
let db: DatabaseSync;
let registry: RegistryService;
let tmuxManager: TmuxManager;
let handlers: OctoGatewayHandlers;
const createdSessions: string[] = [];

const NODE_ID = "test-node-1";
let armCounter = 0;

function nextArmId(): string {
  armCounter += 1;
  return `arm-term-test-${armCounter}-${Date.now()}`;
}

function makeArmSpec(overrides: Partial<ArmSpec> = {}): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "mission-1",
    adapter_type: "pty_tmux",
    runtime_name: "claude-cli",
    agent_id: "agent-1",
    cwd: "/tmp",
    idempotency_key: `idem-${Math.random().toString(36).slice(2, 10)}`,
    runtime_options: { command: "sleep 3600" },
    ...overrides,
  };
}

function makeArmInput(overrides: Partial<ArmInput> = {}): ArmInput {
  return {
    arm_id: nextArmId(),
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

function createStubEventLog(): EventLogService {
  const logDir = path.join(tempDir, "events");
  return new EventLogService({ path: path.join(logDir, "events.jsonl") });
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-arm-terminate-test-"));
  const dbPath = path.join(tempDir, "registry.sqlite");
  db = openOctoRegistry({ path: dbPath });
  registry = new RegistryService(db);
  tmuxManager = new TmuxManager();
  armCounter = 0;
  createdSessions.length = 0;

  handlers = new OctoGatewayHandlers({
    registry,
    eventLog: createStubEventLog(),
    tmuxManager,
    nodeId: NODE_ID,
    now: () => Date.now(),
    generateArmId: nextArmId,
  });
});

afterEach(async () => {
  // Cleanup tmux sessions created during tests.
  for (const session of createdSessions) {
    try {
      await tmuxManager.killSession(session);
    } catch {
      // Already gone -- fine.
    }
  }
  createdSessions.length = 0;

  try {
    closeOctoRegistry(db);
  } catch {
    // Already closed.
  }
  rmSync(tempDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────
// Helper: insert an arm in a terminatable state with a live tmux session
// ──────────────────────────────────────────────────────────────────────────

async function insertActiveArmWithSession(armId: string): Promise<void> {
  const sessionName = `octo-arm-${armId}`;
  await tmuxManager.createSession(sessionName, "sleep 3600", "/tmp");
  createdSessions.push(sessionName);
  registry.putArm(
    makeArmInput({
      arm_id: armId,
      state: "active",
      session_ref: { tmux_session_name: sessionName, cwd: "/tmp" },
    }),
  );
}

// ════════════════════════════════════════════════════════════════════════
// validateArmTerminateOptions
// ════════════════════════════════════════════════════════════════════════

describe("validateArmTerminateOptions", () => {
  it("returns ok for valid options", () => {
    const result = validateArmTerminateOptions({
      arm_id: "arm-1",
      reason: "test reason",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects missing arm_id", () => {
    const result = validateArmTerminateOptions({ reason: "test reason" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("arm_id");
    }
  });

  it("rejects missing reason", () => {
    const result = validateArmTerminateOptions({ arm_id: "arm-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("reason");
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// formatArmTerminate
// ════════════════════════════════════════════════════════════════════════

describe("formatArmTerminate", () => {
  it("produces human-readable output", () => {
    const output = formatArmTerminate({
      arm_id: "arm-xyz",
      terminated: true,
      final_status: "terminated",
    });
    expect(output).toContain("Arm arm-xyz terminated.");
  });
});

// ════════════════════════════════════════════════════════════════════════
// formatArmTerminateJson
// ════════════════════════════════════════════════════════════════════════

describe("formatArmTerminateJson", () => {
  it("produces valid JSON that round-trips", () => {
    const response = {
      arm_id: "arm-xyz",
      terminated: true as const,
      final_status: "terminated" as const,
    };
    const json = formatArmTerminateJson(response);
    const parsed = JSON.parse(json) as typeof response;
    expect(parsed).toEqual(response);
  });
});

// ════════════════════════════════════════════════════════════════════════
// runArmTerminate
// ════════════════════════════════════════════════════════════════════════

describe("runArmTerminate", () => {
  it.skipIf(!tmuxAvailable)("happy path: terminates an active arm and exits 0", async () => {
    const armId = `arm-happy-${Date.now()}`;
    await insertActiveArmWithSession(armId);

    const out = { write: vi.fn() };
    const errOut = { write: vi.fn() };
    const code = await runArmTerminate(
      handlers,
      { arm_id: armId, reason: "operator requested" },
      out,
      errOut,
    );

    expect(code).toBe(0);
    const written = out.write.mock.calls[0][0] as string;
    expect(written).toContain(`Arm ${armId} terminated.`);
    expect(errOut.write).not.toHaveBeenCalled();
  });

  it("unknown arm: exits 1 with error", async () => {
    const out = { write: vi.fn() };
    const errOut = { write: vi.fn() };
    const code = await runArmTerminate(
      handlers,
      { arm_id: "arm-does-not-exist", reason: "cleanup" },
      out,
      errOut,
    );

    expect(code).toBe(1);
    expect(out.write).not.toHaveBeenCalled();
    const errMsg = errOut.write.mock.calls[0][0] as string;
    expect(errMsg).toContain("not found");
  });

  it.skipIf(!tmuxAvailable)("already terminated: idempotent success, exits 0", async () => {
    const armId = `arm-idem-${Date.now()}`;
    await insertActiveArmWithSession(armId);

    const out1 = { write: vi.fn() };
    const errOut1 = { write: vi.fn() };
    const code1 = await runArmTerminate(
      handlers,
      { arm_id: armId, reason: "first call" },
      out1,
      errOut1,
    );
    expect(code1).toBe(0);

    // Second call should also succeed (idempotent).
    const out2 = { write: vi.fn() };
    const errOut2 = { write: vi.fn() };
    const code2 = await runArmTerminate(
      handlers,
      { arm_id: armId, reason: "second call" },
      out2,
      errOut2,
    );
    expect(code2).toBe(0);
    const written = out2.write.mock.calls[0][0] as string;
    expect(written).toContain(`Arm ${armId} terminated.`);
  });

  it.skipIf(!tmuxAvailable)("json output: --json flag produces valid JSON response", async () => {
    const armId = `arm-json-${Date.now()}`;
    await insertActiveArmWithSession(armId);

    const out = { write: vi.fn() };
    const errOut = { write: vi.fn() };
    const code = await runArmTerminate(
      handlers,
      { arm_id: armId, reason: "json test", json: true },
      out,
      errOut,
    );

    expect(code).toBe(0);
    const written = out.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed.arm_id).toBe(armId);
    expect(parsed.terminated).toBe(true);
    expect(parsed.final_status).toBe("terminated");
  });

  it("missing reason: validation error, exits 1", async () => {
    const out = { write: vi.fn() };
    const errOut = { write: vi.fn() };
    const code = await runArmTerminate(handlers, { arm_id: "arm-1", reason: "" }, out, errOut);

    expect(code).toBe(1);
    expect(out.write).not.toHaveBeenCalled();
    const errMsg = errOut.write.mock.calls[0][0] as string;
    expect(errMsg).toContain("reason");
  });

  it("missing arm_id: validation error, exits 1", async () => {
    const out = { write: vi.fn() };
    const errOut = { write: vi.fn() };
    const code = await runArmTerminate(
      handlers,
      { arm_id: "", reason: "some reason" },
      out,
      errOut,
    );

    expect(code).toBe(1);
    expect(out.write).not.toHaveBeenCalled();
    const errMsg = errOut.write.mock.calls[0][0] as string;
    expect(errMsg).toContain("arm_id");
  });
});
