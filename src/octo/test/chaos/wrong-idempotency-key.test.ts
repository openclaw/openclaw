// Octopus Orchestrator -- Chaos test: wrong idempotency key (M4-11)
//
// Verifies idempotency semantics of octo.arm.spawn (M1-14):
//   1. Same key returns same arm (idempotent replay).
//   2. Different key creates a new arm.
//   3. Same key + different spec still returns original (no state change).
//
// Boundary discipline (OCTO-DEC-033): only node:* builtins, vitest, and
// relative imports inside src/octo/.

import { execFileSync } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EventLogService } from "../../head/event-log.ts";
import { RegistryService } from "../../head/registry.ts";
import { openOctoRegistry, closeOctoRegistry } from "../../head/storage/migrate.ts";
import { TmuxManager } from "../../node-agent/tmux-manager.ts";
import { OctoGatewayHandlers, type OctoGatewayHandlerDeps } from "../../wire/gateway-handlers.ts";
import type { ArmSpec } from "../../wire/schema.ts";

const execFileAsync = promisify(execFile);

// ──────────────────────────────────────────────────────────────────────────
// tmux availability gate
// ──────────────────────────────────────────────────────────────────────────

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const TMUX_AVAILABLE = hasTmux();

// ──────────────────────────────────────────────────────────────────────────
// Per-run session-name scoping + cleanup
// ──────────────────────────────────────────────────────────────────────────

const RUN_PREFIX = `m4-11-chaos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const _SESSION_NAME_PREFIX = "octo-arm-";

async function rawListSessionNames(): Promise<readonly string[]> {
  try {
    const { stdout } = await execFileAsync("tmux", ["list-sessions", "-F", "#{session_name}"]);
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

async function sweepRunSessions(): Promise<void> {
  const names = await rawListSessionNames();
  for (const n of names) {
    if (n.includes(RUN_PREFIX)) {
      try {
        await execFileAsync("tmux", ["kill-session", "-t", n]);
      } catch {
        // best-effort
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Harness
// ──────────────────────────────────────────────────────────────────────────

interface Harness {
  tempDir: string;
  registry: RegistryService;
  eventLog: EventLogService;
  tmuxManager: TmuxManager;
  handlers: OctoGatewayHandlers;
  closeDb: () => void;
}

let armCounter = 0;
function nextTestArmId(): string {
  armCounter += 1;
  return `${RUN_PREFIX}-${armCounter}`;
}

function makeHarness(): Harness {
  const tempDir = mkdtempSync(join(tmpdir(), "octo-chaos-m4-11-"));
  const dbPath = join(tempDir, "registry.sqlite");
  const eventLogPath = join(tempDir, "events.jsonl");
  const db = openOctoRegistry({ path: dbPath });
  const registry = new RegistryService(db);
  const eventLog = new EventLogService({ path: eventLogPath });
  const tmuxManager = new TmuxManager();

  // Use a rotating arm-id generator so each spawn call gets a unique id.
  const deps: OctoGatewayHandlerDeps = {
    registry,
    eventLog,
    tmuxManager,
    nodeId: "test-node-m4-11",
    now: () => Date.now(),
    generateArmId: () => nextTestArmId(),
  };
  const handlers = new OctoGatewayHandlers(deps);

  return {
    tempDir,
    registry,
    eventLog,
    tmuxManager,
    handlers,
    closeDb: () => {
      try {
        closeOctoRegistry(db);
      } catch {
        // already closed
      }
    },
  };
}

function makeArmSpec(cwd: string, overrides: Partial<ArmSpec> = {}): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "mission-chaos-m4-11",
    adapter_type: "pty_tmux",
    runtime_name: "bash",
    agent_id: "agent-chaos-m4-11",
    cwd,
    idempotency_key: `idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    runtime_options: {
      command: "sleep",
      args: ["300"],
    },
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe.skipIf(!TMUX_AVAILABLE)("Chaos: wrong idempotency key (M4-11)", () => {
  let harness: Harness | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    await sweepRunSessions();
    if (harness !== null) {
      harness.closeDb();
      try {
        rmSync(harness.tempDir, { recursive: true, force: true });
      } catch {
        // swallow
      }
      harness = null;
    }
  });

  afterAll(async () => {
    await sweepRunSessions();
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // swallow
      }
    }
  });

  it("idempotent retry with same key returns same arm", async () => {
    harness = makeHarness();
    const { handlers, registry } = harness;
    const cwd = mkdtempSync(join(tmpdir(), "chaos-idem-same-"));
    tempDirs.push(cwd);

    const key = "abc";
    const spec = makeArmSpec(cwd, { idempotency_key: key });

    const first = await handlers.armSpawn({ idempotency_key: key, spec });
    const second = await handlers.armSpawn({ idempotency_key: key, spec });

    expect(second.arm_id).toBe(first.arm_id);
    expect(second.session_ref).toStrictEqual(first.session_ref);

    // Registry has exactly one arm with this key.
    const arms = registry.listArms({ node_id: "test-node-m4-11" });
    const matching = arms.filter((a) => a.spec.idempotency_key === key);
    expect(matching).toHaveLength(1);
  }, 30_000);

  it("different key creates a new arm", async () => {
    harness = makeHarness();
    const { handlers, registry } = harness;
    const cwd = mkdtempSync(join(tmpdir(), "chaos-idem-diff-"));
    tempDirs.push(cwd);

    const specA = makeArmSpec(cwd, { idempotency_key: "abc" });
    const specB = makeArmSpec(cwd, { idempotency_key: "xyz" });

    const first = await handlers.armSpawn({ idempotency_key: "abc", spec: specA });
    const second = await handlers.armSpawn({ idempotency_key: "xyz", spec: specB });

    expect(second.arm_id).not.toBe(first.arm_id);

    // Registry has two distinct arms.
    const arms = registry.listArms({ node_id: "test-node-m4-11" });
    const ids = new Set(arms.map((a) => a.arm_id));
    expect(ids.has(first.arm_id)).toBe(true);
    expect(ids.has(second.arm_id)).toBe(true);
    expect(ids.size).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("same key + different spec still returns original (no state change)", async () => {
    harness = makeHarness();
    const { handlers, registry } = harness;
    const cwd = mkdtempSync(join(tmpdir(), "chaos-idem-tamper-"));
    tempDirs.push(cwd);

    const key = "abc";
    const originalSpec = makeArmSpec(cwd, {
      idempotency_key: key,
      agent_id: "agent-original",
    });

    const first = await handlers.armSpawn({ idempotency_key: key, spec: originalSpec });

    // Tamper: same key but different agent_id.
    const tamperedSpec = makeArmSpec(cwd, {
      idempotency_key: key,
      agent_id: "agent-tampered",
    });
    const second = await handlers.armSpawn({ idempotency_key: key, spec: tamperedSpec });

    // Idempotency returns the original arm, ignoring the tampered spec.
    expect(second.arm_id).toBe(first.arm_id);
    expect(second.session_ref).toStrictEqual(first.session_ref);

    // The stored spec retains the original agent_id -- no mutation.
    const arm = registry.getArm(first.arm_id);
    expect(arm).not.toBeNull();
    expect(arm!.agent_id).toBe("agent-original");
    expect(arm!.spec.agent_id).toBe("agent-original");

    // Still only one arm with this key.
    const arms = registry.listArms({ node_id: "test-node-m4-11" });
    const matching = arms.filter((a) => a.spec.idempotency_key === key);
    expect(matching).toHaveLength(1);
  }, 30_000);

  it("leak check: no tmux sessions survive after cleanup", async () => {
    const sessions = await rawListSessionNames();
    const leaked = sessions.filter((n) => n.includes(RUN_PREFIX));
    expect(leaked).toHaveLength(0);
  });
});
