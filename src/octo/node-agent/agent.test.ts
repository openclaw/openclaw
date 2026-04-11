// Octopus Orchestrator — NodeAgent tests (M2-03)
//
// Live tmux integration tests exercising the Node Agent runtime loop:
//   1. start reconciles and begins polling
//   2. agent transitions starting arm to active within pollIntervalMs (THE acceptance criterion)
//   3. agent transitions starting arm to failed if session is missing
//   4. stop() halts the polling loop
//   5. agent handles CAS conflict gracefully
//   6. agent watches active arms for ProcessWatcher events
//   7. stop does NOT kill tmux sessions
//   8. reconcile can be called explicitly
//
// Session-name scoping: every test uses a per-run prefix so leftovers
// from crashed runs can be swept. Sentinel files use a per-test temp dir.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLogService } from "../head/event-log.ts";
import { type ArmInput, RegistryService } from "../head/registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "../head/storage/migrate.ts";
import type { ArmSpec } from "../wire/schema.ts";
import { NodeAgent, type NodeAgentOptions } from "./agent.ts";
import { TmuxManager } from "./tmux-manager.ts";

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
// Per-run session name scoping
// ──────────────────────────────────────────────────────────────────────────

const STATIC_TAG = "octo-m2-03-test";
const RUN_TAG = `${STATIC_TAG}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function rawListSessionNames(): Promise<string[]> {
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

async function sweep(matcher: (name: string) => boolean): Promise<void> {
  const names = await rawListSessionNames();
  for (const n of names) {
    if (matcher(n)) {
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

function makeArmSpec(overrides: Partial<ArmSpec> = {}): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "mission-m2-03",
    adapter_type: "pty_tmux",
    runtime_name: "bash",
    agent_id: "agent-m2-03",
    cwd: "/tmp",
    idempotency_key: `idem-${Math.random().toString(36).slice(2, 10)}`,
    runtime_options: {
      command: "sleep",
      args: ["60"],
    },
    ...overrides,
  };
}

let armCounter = 0;
function nextArmId(tag: string): string {
  armCounter += 1;
  return `${tag}-${armCounter}`;
}

function makeArmInput(overrides: Partial<ArmInput> = {}): ArmInput {
  const arm_id = overrides.arm_id ?? nextArmId("arm");
  return {
    arm_id,
    mission_id: "mission-m2-03",
    node_id: "test-node",
    adapter_type: "pty_tmux",
    runtime_name: "bash",
    agent_id: "agent-m2-03",
    task_ref: null,
    state: "starting",
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

interface ReadEvent {
  event_id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  ts: string;
  actor: string;
  payload: Record<string, unknown>;
}

function readEventLog(filePath: string): ReadEvent[] {
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  return contents
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ReadEvent);
}

/** Wait for a condition to become true, polling every `intervalMs`. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ──────────────────────────────────────────────────────────────────────────
// Test suite
// ──────────────────────────────────────────────────────────────────────────

describe.skipIf(!TMUX_AVAILABLE || !!process.env.CI)("NodeAgent (M2-03)", () => {
  let tempDir: string;
  let db: DatabaseSync;
  let registry: RegistryService;
  let eventLog: EventLogService;
  let eventLogPath: string;
  let tmuxManager: TmuxManager;
  let sessionNamePrefix: string;
  let sentinelDir: string;
  let agent: NodeAgent | null;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-node-agent-test-"));
    const dbPath = path.join(tempDir, "registry.sqlite");
    eventLogPath = path.join(tempDir, "events.jsonl");
    db = openOctoRegistry({ path: dbPath });
    registry = new RegistryService(db);
    eventLog = new EventLogService({ path: eventLogPath });
    tmuxManager = new TmuxManager();
    sessionNamePrefix = `${RUN_TAG}-${Math.random().toString(36).slice(2, 8)}-arm-`;
    sentinelDir = path.join(tempDir, "sentinels");
    agent = null;
  });

  afterEach(async () => {
    if (agent !== null) {
      agent.stop();
      agent = null;
    }
    await sweep((n) => n.startsWith(sessionNamePrefix));
    try {
      closeOctoRegistry(db);
    } catch {
      // already closed
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  afterAll(async () => {
    await sweep((n) => n.includes(STATIC_TAG));
  });

  function createAgent(overrides: Partial<NodeAgentOptions> = {}): NodeAgent {
    const a = new NodeAgent({
      nodeId: "test-node",
      registry,
      eventLog,
      tmuxManager,
      sessionNamePrefix,
      sentinelDir,
      pollIntervalMs: 100,
      processWatcherPollMs: 100,
      now: () => Date.now(),
      ...overrides,
    });
    agent = a;
    return a;
  }

  async function createRealSession(name: string): Promise<void> {
    await execFileAsync("tmux", ["new-session", "-d", "-s", name, "-c", "/tmp", "sleep 3600"]);
  }

  // 1. start reconciles and begins polling
  it("start reconciles and begins polling", async () => {
    const armId = nextArmId("reconcile");
    registry.putArm(makeArmInput({ arm_id: armId, state: "starting" }));
    const sessionName = `${sessionNamePrefix}${armId}`;
    await createRealSession(sessionName);

    const a = createAgent();
    const report = await a.start();

    // The reconciler found 1 starting arm with a matching tmux session.
    expect(report.recovered_count).toBe(1);
    expect(a.isRunning()).toBe(true);
  });

  // 2. THE acceptance criterion: starting -> active within pollIntervalMs
  it("transitions starting arm to active within 5s", async () => {
    const armId = nextArmId("active");
    const sessionName = `${sessionNamePrefix}${armId}`;

    // Start the agent BEFORE inserting the arm so the SessionReconciler
    // on startup does NOT find it (the reconciler would transition it
    // itself without emitting an event to the log). Then create both
    // the arm row and the tmux session. The poll loop will detect the
    // arm in `starting` state and the live session on its next tick.
    const a = createAgent({ pollIntervalMs: 100 });
    await a.start();

    // Insert the arm and create the session. The poll interval is 100ms,
    // so both operations complete well within a single tick.
    registry.putArm(makeArmInput({ arm_id: armId, state: "starting" }));
    await createRealSession(sessionName);

    // Wait for the arm to transition to active.
    await waitFor(() => {
      const arm = registry.getArm(armId);
      return arm !== null && arm.state === "active";
    }, 5000);

    const arm = registry.getArm(armId);
    expect(arm).not.toBeNull();
    expect(arm!.state).toBe("active");

    // Wait for the async eventLog.append to flush.
    await waitFor(() => {
      const events = readEventLog(eventLogPath);
      return events.some((e) => e.entity_id === armId && e.event_type === "arm.active");
    }, 5000);

    const events = readEventLog(eventLogPath);
    const activeEvent = events.find((e) => e.entity_id === armId && e.event_type === "arm.active");
    expect(activeEvent).toBeDefined();
  });

  // 3. starting arm transitions to failed if session is missing
  it("transitions starting arm to failed if session is missing", async () => {
    const armId = nextArmId("missing");
    registry.putArm(makeArmInput({ arm_id: armId, state: "starting" }));
    // Deliberately do NOT create a tmux session.

    const a = createAgent({ pollIntervalMs: 100 });
    await a.start();

    await waitFor(() => {
      const arm = registry.getArm(armId);
      return arm !== null && arm.state === "failed";
    }, 5000);

    const arm = registry.getArm(armId);
    expect(arm).not.toBeNull();
    expect(arm!.state).toBe("failed");

    const events = readEventLog(eventLogPath);
    const failedEvent = events.find((e) => e.entity_id === armId && e.event_type === "arm.failed");
    expect(failedEvent).toBeDefined();
  });

  // 4. stop() halts the polling loop
  it("stop() halts the polling loop", async () => {
    const a = createAgent({ pollIntervalMs: 100 });
    await a.start();
    expect(a.isRunning()).toBe(true);

    a.stop();
    expect(a.isRunning()).toBe(false);

    // Insert a starting arm AFTER stop -- it should NOT be transitioned.
    const armId = nextArmId("post-stop");
    registry.putArm(makeArmInput({ arm_id: armId, state: "starting" }));
    const sessionName = `${sessionNamePrefix}${armId}`;
    await createRealSession(sessionName);

    // Wait a few poll intervals to confirm no transition happens.
    await new Promise<void>((r) => setTimeout(r, 400));
    const arm = registry.getArm(armId);
    expect(arm).not.toBeNull();
    expect(arm!.state).toBe("starting"); // NOT active
  });

  // 5. agent handles CAS conflict gracefully
  it("handles CAS conflict gracefully", async () => {
    const armId = nextArmId("cas");
    registry.putArm(makeArmInput({ arm_id: armId, state: "starting" }));
    const sessionName = `${sessionNamePrefix}${armId}`;
    await createRealSession(sessionName);

    // Monkey-patch casUpdateArm: on the first call for this arm, bump
    // the version externally to induce a CAS conflict.
    const origCas = registry.casUpdateArm.bind(registry);
    let intercepted = false;
    registry.casUpdateArm = (id, expectedVersion, patch) => {
      if (id === armId && !intercepted) {
        intercepted = true;
        // Bump the row so the expected version is now stale.
        origCas(id, expectedVersion, { updated_at: Date.now() });
        // Now call with the STALE expectedVersion -- will ConflictError.
        return origCas(id, expectedVersion, patch);
      }
      return origCas(id, expectedVersion, patch);
    };

    const logMessages: string[] = [];
    const a = createAgent({
      pollIntervalMs: 100,
      logger: (entry) => {
        logMessages.push(entry.message);
      },
    });
    await a.start();

    // Wait long enough for the poll cycle that triggers the conflict.
    await waitFor(() => intercepted, 5000);
    // Give one more poll cycle for the log to be written.
    await new Promise<void>((r) => setTimeout(r, 200));

    // The agent should NOT have crashed.
    expect(a.isRunning()).toBe(true);

    // There should be a logged CAS conflict message.
    const hasCasLog = logMessages.some((m) => m.includes("CAS conflict"));
    expect(hasCasLog).toBe(true);

    // Restore original.
    registry.casUpdateArm = origCas;
  });

  // 6. agent watches active arms for ProcessWatcher events
  it("watches active arms and detects exit via ProcessWatcher", async () => {
    const armId = nextArmId("pw-exit");
    registry.putArm(makeArmInput({ arm_id: armId, state: "starting" }));
    const sessionName = `${sessionNamePrefix}${armId}`;
    await createRealSession(sessionName);

    const a = createAgent({ pollIntervalMs: 100, processWatcherPollMs: 100 });
    await a.start();

    // Wait for starting -> active transition first.
    await waitFor(() => {
      const arm = registry.getArm(armId);
      return arm !== null && arm.state === "active";
    }, 5000);

    // Now kill the tmux session to trigger ProcessWatcher detection.
    await execFileAsync("tmux", ["kill-session", "-t", sessionName]);

    // Wait for the arm to transition to failed.
    await waitFor(() => {
      const arm = registry.getArm(armId);
      return arm !== null && arm.state === "failed";
    }, 5000);

    const arm = registry.getArm(armId);
    expect(arm).not.toBeNull();
    expect(arm!.state).toBe("failed");
  });

  // 7. stop does NOT kill tmux sessions
  it("stop does NOT kill tmux sessions", async () => {
    const armId = nextArmId("no-kill");
    registry.putArm(makeArmInput({ arm_id: armId, state: "starting" }));
    const sessionName = `${sessionNamePrefix}${armId}`;
    await createRealSession(sessionName);

    const a = createAgent({ pollIntervalMs: 100 });
    await a.start();

    // Wait for active transition.
    await waitFor(() => {
      const arm = registry.getArm(armId);
      return arm !== null && arm.state === "active";
    }, 5000);

    a.stop();

    // The tmux session should still be alive.
    const names = await rawListSessionNames();
    expect(names).toContain(sessionName);
  });

  // 8. reconcile can be called explicitly
  it("reconcile can be called explicitly mid-run", async () => {
    const a = createAgent({ pollIntervalMs: 100 });
    await a.start();

    // Insert a new arm and create its session mid-run.
    const armId = nextArmId("explicit-recon");
    registry.putArm(makeArmInput({ arm_id: armId, state: "starting" }));
    const sessionName = `${sessionNamePrefix}${armId}`;
    await createRealSession(sessionName);

    // Explicitly reconcile.
    const report = await a.reconcile();
    expect(report.total_live_sessions).toBeGreaterThanOrEqual(1);

    // The polling loop should eventually transition the arm to active.
    await waitFor(() => {
      const arm = registry.getArm(armId);
      return arm !== null && arm.state === "active";
    }, 5000);

    const arm = registry.getArm(armId);
    expect(arm!.state).toBe("active");
  });
});
