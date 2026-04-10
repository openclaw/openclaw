// Octopus Orchestrator — Chaos test: kill arm process (M1-25)
//
// Integration test tying M1-12 ProcessWatcher + M1-13 SessionReconciler
// + M1-14 octo.arm.spawn together. Spawns an arm via OctoGatewayHandlers,
// kills the underlying tmux session to simulate unexpected exit, and
// asserts that ProcessWatcher detects the failure and that the arm's
// state is visible via the registry.
//
// Scope boundary: restart_count increment is an M1-21 concern. This test
// verifies that ProcessWatcher detects the exit and emits the correct
// event. The restart_count field is asserted at its initial value (0).
// M1-21 will add the restart flow that bumps it.
//
// Boundary discipline (OCTO-DEC-033): only node:* builtins and relative
// imports inside src/octo/.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { gatherOctoStatus } from "../../cli/status.ts";
import { EventLogService } from "../../head/event-log.ts";
import { RegistryService } from "../../head/registry.ts";
import { openOctoRegistry, closeOctoRegistry } from "../../head/storage/migrate.ts";
import { ProcessWatcher, type ProcessWatcherEvent } from "../../node-agent/process-watcher.ts";
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
// Per-run session-name scoping
// ──────────────────────────────────────────────────────────────────────────

const RUN_PREFIX = `m1-25-chaos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const SESSION_NAME_PREFIX = "octo-arm-";

function sessionNameForArm(arm_id: string): string {
  return `${SESSION_NAME_PREFIX}${arm_id}`;
}

function nextEvent(watcher: ProcessWatcher, timeoutMs: number): Promise<ProcessWatcherEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.off("process", onEvent);
      reject(new Error(`timed out waiting for process event after ${timeoutMs}ms`));
    }, timeoutMs);
    const onEvent = (evt: ProcessWatcherEvent): void => {
      clearTimeout(timer);
      resolve(evt);
    };
    watcher.once("process", onEvent);
  });
}

/**
 * Build a shell wrapper script that runs `bodyLines` then writes `$?` to
 * the sentinel path. Matches the M1-12 sentinel-file pattern.
 */
function mkWrappedScript(
  tmpDir: string,
  tag: string,
  bodyLines: string[],
  sentinelPath: string,
): string {
  const scriptPath = join(tmpDir, `${tag}.sh`);
  const body = bodyLines.join("\n");
  const script = `#!/bin/sh
set +e
(
${body}
)
_rc=$?
printf '%s\\n' "$_rc" > ${sentinelPath}
exit $_rc
`;
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
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
  const tempDir = mkdtempSync(join(tmpdir(), "octo-chaos-m1-25-"));
  const dbPath = join(tempDir, "registry.sqlite");
  const eventLogPath = join(tempDir, "events.jsonl");
  const db = openOctoRegistry({ path: dbPath });
  const registry = new RegistryService(db);
  const eventLog = new EventLogService({ path: eventLogPath });
  const tmuxManager = new TmuxManager();

  const armId = nextTestArmId();
  const deps: OctoGatewayHandlerDeps = {
    registry,
    eventLog,
    tmuxManager,
    nodeId: "test-node-m1-25",
    now: () => Date.now(),
    generateArmId: () => armId,
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
    mission_id: "mission-chaos-m1-25",
    adapter_type: "pty_tmux",
    runtime_name: "bash",
    agent_id: "agent-chaos-m1-25",
    cwd,
    idempotency_key: `idem-chaos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

describe.skipIf(!TMUX_AVAILABLE)("Chaos: kill arm process (M1-25)", () => {
  let harness: Harness | null = null;
  let activeWatchers: ProcessWatcher[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const w of activeWatchers) {
      try {
        w.stop();
      } catch {
        // swallow
      }
    }
    activeWatchers = [];
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

  it("detects killed tmux session and emits failed event with correct arm_id", async () => {
    harness = makeHarness();
    const { handlers, registry, tmuxManager } = harness;
    const cwd = mkdtempSync(join(tmpdir(), "chaos-kill-arm-"));
    tempDirs.push(cwd);

    // 1. Spawn an arm via armSpawn (creates tmux session running sleep 300)
    const spec = makeArmSpec(cwd);
    const spawnResult = await handlers.armSpawn({
      idempotency_key: spec.idempotency_key,
      spec,
    });
    const { arm_id } = spawnResult;

    // Verify the arm exists in registry in "starting" state
    const armBefore = registry.getArm(arm_id);
    expect(armBefore).not.toBeNull();
    expect(armBefore!.state).toBe("starting");
    expect(armBefore!.restart_count).toBe(0);

    // 2. Verify tmux session is alive
    const sessionName = sessionNameForArm(arm_id);
    const liveBefore = await tmuxManager.listSessions();
    expect(liveBefore).toContain(sessionName);

    // 3. Set up ProcessWatcher with a sentinel file (matches M1-12 pattern)
    const sentinelPath = join(cwd, "exit.sentinel");
    const watcher = new ProcessWatcher({
      pollIntervalMs: 50,
      tmuxManager,
    });
    activeWatchers.push(watcher);

    watcher.watch({
      arm_id,
      session_name: sessionName,
      exit_sentinel_path: sentinelPath,
    });

    // 4. Kill the tmux session (simulates unexpected process death)
    // Wait one poll cycle for the watcher to observe the session is alive
    await new Promise((r) => setTimeout(r, 100));
    await execFileAsync("tmux", ["kill-session", "-t", sessionName]);

    // 5. Wait for ProcessWatcher to emit the failed event (max 10s)
    const evt = await nextEvent(watcher, 10_000);

    // 6. Assert the event was emitted with the right arm_id and type
    expect(evt.type).toBe("failed");
    expect(evt.arm_id).toBe(arm_id);
    expect(evt.session_name).toBe(sessionName);
    if (evt.type === "failed") {
      expect(evt.exit_code).toBeNull();
      expect(evt.reason).toContain("session_terminated_no_sentinel");
    }

    // 7. Restart count scope boundary: restart_count increment is M1-21.
    // Here we assert ProcessWatcher detected the exit. The initial
    // restart_count from the spawn is 0 and has not been bumped because
    // the restart flow (M1-21) is not wired into this test.
    const armAfter = registry.getArm(arm_id);
    expect(armAfter).not.toBeNull();
    expect(armAfter!.restart_count).toBe(0);
    expect(armAfter!.arm_id).toBe(arm_id);
    expect(armAfter!.node_id).toBe("test-node-m1-25");
    expect(armAfter!.mission_id).toBe("mission-chaos-m1-25");

    // 8. Assert the arm's state is visible via gatherOctoStatus
    const status = gatherOctoStatus(registry);
    expect(status.arms.total).toBeGreaterThanOrEqual(1);
    // The arm is still in "starting" in the registry because
    // ProcessWatcher only emits events -- it does NOT mutate the
    // registry. The FSM transition to "failed" is the responsibility
    // of the Node Agent main loop (M1-21). We verify the arm is
    // visible (total >= 1) and readable via getArm.
    expect(status.arms.starting).toBeGreaterThanOrEqual(1);

    // Verify watcher cleaned up its internal state
    expect(watcher.watchedCount()).toBe(0);
  }, 30_000);

  it("detects killed process with sentinel file present (clean exit path)", async () => {
    harness = makeHarness();
    const { handlers, registry, tmuxManager } = harness;
    const cwd = mkdtempSync(join(tmpdir(), "chaos-sentinel-"));
    tempDirs.push(cwd);

    // Spawn with a wrapped script that writes a sentinel before exit
    const sentinelPath = join(cwd, "exit.sentinel");
    const script = mkWrappedScript(cwd, "chaos-sentinel", ["sleep 0.3", "exit 1"], sentinelPath);

    const spec = makeArmSpec(cwd, {
      runtime_options: { command: script },
      idempotency_key: `idem-sentinel-${Date.now()}`,
    });
    const spawnResult = await handlers.armSpawn({
      idempotency_key: spec.idempotency_key,
      spec,
    });
    const { arm_id } = spawnResult;

    const sessionName = sessionNameForArm(arm_id);
    const watcher = new ProcessWatcher({
      pollIntervalMs: 50,
      tmuxManager,
    });
    activeWatchers.push(watcher);

    watcher.watch({
      arm_id,
      session_name: sessionName,
      exit_sentinel_path: sentinelPath,
    });

    // Wait for the script to exit naturally (writes sentinel with code 1)
    const evt = await nextEvent(watcher, 10_000);
    expect(evt.type).toBe("failed");
    expect(evt.arm_id).toBe(arm_id);
    if (evt.type === "failed") {
      expect(evt.exit_code).toBe(1);
      expect(evt.reason).toContain("exit_code_1");
    }

    // Arm visible via registry
    const arm = registry.getArm(arm_id);
    expect(arm).not.toBeNull();
    expect(arm!.restart_count).toBe(0);

    expect(watcher.watchedCount()).toBe(0);
  }, 30_000);
});
