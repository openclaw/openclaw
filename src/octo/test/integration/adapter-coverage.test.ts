// Octopus Orchestrator -- Integration test: all 4 adapter types (M2-21)
//
// Validates that each of the four adapter types (pty_tmux, cli_exec,
// structured_subagent, structured_acp) can spawn, appear in
// RegistryService.listArms, and terminate cleanly.
//
// pty_tmux and cli_exec are tested via real processes/sessions.
// structured_subagent and structured_acp are tested directly at the
// adapter level using mock bridges (factory.ts does not wire them yet).
//
// Boundary discipline (OCTO-DEC-033): only node:* builtins,
// @sinclair/typebox, and relative imports inside src/octo/.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpAdapter } from "../../adapters/acp.ts";
import type { SessionRef } from "../../adapters/base.ts";
import { CliExecAdapter } from "../../adapters/cli-exec.ts";
import { createMockAcpxBridge } from "../../adapters/openclaw/acpx-bridge.ts";
import { createMockSessionsSpawnBridge } from "../../adapters/openclaw/sessions-spawn.ts";
import { PtyTmuxAdapter } from "../../adapters/pty-tmux.ts";
import { SubagentAdapter } from "../../adapters/subagent.ts";
import { EventLogService } from "../../head/event-log.ts";
import { RegistryService, type ArmInput } from "../../head/registry.ts";
import { openOctoRegistry, closeOctoRegistry } from "../../head/storage/migrate.ts";
import { TmuxManager } from "../../node-agent/tmux-manager.ts";
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
// Per-run scoping for safe cleanup
// ──────────────────────────────────────────────────────────────────────────

const RUN_PREFIX = `m2-21-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
// Test harness
// ──────────────────────────────────────────────────────────────────────────

interface Harness {
  tempDir: string;
  registry: RegistryService;
  eventLog: EventLogService;
  tmuxManager: TmuxManager;
  closeDb: () => void;
}

let armCounter = 0;
function nextArmId(): string {
  armCounter += 1;
  return `arm-${RUN_PREFIX}-${armCounter}`;
}

function makeHarness(): Harness {
  const tempDir = mkdtempSync(path.join(tmpdir(), "octo-adapter-coverage-"));
  const dbPath = path.join(tempDir, "registry.sqlite");
  const eventLogPath = path.join(tempDir, "events.jsonl");
  const db = openOctoRegistry({ path: dbPath });
  const registry = new RegistryService(db);
  const eventLog = new EventLogService({ path: eventLogPath });
  const tmuxManager = new TmuxManager();

  return {
    tempDir,
    registry,
    eventLog,
    tmuxManager,
    closeDb: () => {
      try {
        closeOctoRegistry(db);
      } catch {
        // already closed
      }
    },
  };
}

function disposeHarness(h: Harness | null): void {
  if (h === null) {
    return;
  }
  h.closeDb();
  try {
    rmSync(h.tempDir, { recursive: true, force: true });
  } catch {
    // swallow
  }
}

/** Insert an arm record into the registry to track an adapter session. */
function registerArm(
  registry: RegistryService,
  armId: string,
  adapterType: string,
  sessionRef: SessionRef,
  spec: ArmSpec,
): void {
  const input: ArmInput = {
    arm_id: armId,
    mission_id: `mission-${RUN_PREFIX}`,
    node_id: `node-${RUN_PREFIX}`,
    adapter_type: adapterType,
    runtime_name: spec.runtime_name,
    agent_id: spec.agent_id,
    task_ref: null,
    state: "starting",
    current_grip_id: null,
    lease_owner: null,
    lease_expiry_ts: null,
    session_ref: sessionRef as unknown as Record<string, unknown>,
    checkpoint_ref: null,
    health_status: null,
    restart_count: 0,
    policy_profile: null,
    spec,
  };
  registry.putArm(input);
}

// ──────────────────────────────────────────────────────────────────────────
// Specs
// ──────────────────────────────────────────────────────────────────────────

function makePtyTmuxSpec(armId: string): ArmSpec {
  return {
    spec_version: 1,
    mission_id: `mission-${RUN_PREFIX}`,
    adapter_type: "pty_tmux",
    runtime_name: "bash",
    agent_id: `agent-pty-${armId}`,
    cwd: "/tmp",
    idempotency_key: `idem-pty-${armId}`,
    runtime_options: {
      command: "sleep",
      args: ["300"],
      tmuxSessionName: `octo-arm-${armId}`,
    },
  };
}

function makeCliExecSpec(armId: string): ArmSpec {
  return {
    spec_version: 1,
    mission_id: `mission-${RUN_PREFIX}`,
    adapter_type: "cli_exec",
    runtime_name: "echo",
    agent_id: `agent-cli-${armId}`,
    cwd: "/tmp",
    idempotency_key: `idem-cli-${armId}`,
    runtime_options: {
      command: "sleep",
      args: ["300"],
    },
  };
}

function makeSubagentSpec(armId: string): ArmSpec {
  return {
    spec_version: 1,
    mission_id: `mission-${RUN_PREFIX}`,
    adapter_type: "structured_subagent",
    runtime_name: "subagent",
    agent_id: `agent-sub-${armId}`,
    cwd: "/tmp",
    idempotency_key: `idem-sub-${armId}`,
    runtime_options: {},
  };
}

function makeAcpSpec(armId: string): ArmSpec {
  return {
    spec_version: 1,
    mission_id: `mission-${RUN_PREFIX}`,
    adapter_type: "structured_acp",
    runtime_name: "acp",
    agent_id: `agent-acp-${armId}`,
    cwd: "/tmp",
    idempotency_key: `idem-acp-${armId}`,
    runtime_options: {
      acpxHarness: "test-harness",
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

let harness: Harness | null = null;

describe.skipIf(!TMUX_AVAILABLE)(
  "Integration: all 4 adapter types spawn + list + terminate (M2-21)",
  () => {
    beforeEach(() => {
      harness = null;
    });

    afterEach(async () => {
      disposeHarness(harness);
      harness = null;
      await sweepRunSessions();
    });

    afterAll(async () => {
      await sweepRunSessions();
    });

    // ── pty_tmux ──────────────────────────────────────────────────────────

    it(
      "pty_tmux adapter spawns a tmux session, appears in listArms, terminates",
      {
        timeout: 30_000,
      },
      async () => {
        harness = makeHarness();
        const { registry, tmuxManager } = harness;
        const adapter = new PtyTmuxAdapter(tmuxManager);
        const armId = nextArmId();
        const spec = makePtyTmuxSpec(armId);

        // Spawn
        const ref = await adapter.spawn(spec);
        expect(ref.adapter_type).toBe("pty_tmux");
        expect(ref.session_id).toContain(armId);

        // Register in DB
        registerArm(registry, armId, "pty_tmux", ref, spec);

        // Verify in listArms
        const arms = registry.listArms({ mission_id: `mission-${RUN_PREFIX}` });
        const found = arms.find((a) => a.arm_id === armId);
        expect(found).toBeDefined();
        expect(found?.adapter_type).toBe("pty_tmux");

        // Verify tmux session exists
        const sessions = await rawListSessionNames();
        expect(sessions).toContain(ref.session_id);

        // Terminate
        await adapter.terminate(ref);

        // Verify tmux session is gone
        const afterSessions = await rawListSessionNames();
        expect(afterSessions).not.toContain(ref.session_id);
      },
    );

    // ── cli_exec ─────────────────────────────────────────────────────────

    it(
      "cli_exec adapter spawns a subprocess, appears in listArms, terminates",
      {
        timeout: 30_000,
      },
      async () => {
        harness = makeHarness();
        const { registry } = harness;
        const adapter = new CliExecAdapter();
        const armId = nextArmId();
        const spec = makeCliExecSpec(armId);

        // Spawn
        const ref = await adapter.spawn(spec);
        expect(ref.adapter_type).toBe("cli_exec");
        expect(ref.session_id).toBeTruthy();

        // Register in DB
        registerArm(registry, armId, "cli_exec", ref, spec);

        // Verify in listArms
        const arms = registry.listArms({ mission_id: `mission-${RUN_PREFIX}` });
        const found = arms.find((a) => a.arm_id === armId);
        expect(found).toBeDefined();
        expect(found?.adapter_type).toBe("cli_exec");

        // Verify process is alive
        const healthBefore = await adapter.health(ref);
        expect(healthBefore).toBe("alive");

        // Terminate
        await adapter.terminate(ref);

        // Verify process is dead
        const healthAfter = await adapter.health(ref);
        expect(healthAfter).toBe("unknown");
      },
    );

    // ── structured_subagent (mock bridge, adapter-level) ─────────────────

    it(
      "subagent adapter (mock bridge) spawns, appears in listArms, terminates",
      {
        timeout: 15_000,
      },
      async () => {
        harness = makeHarness();
        const { registry } = harness;
        const mockBridge = createMockSessionsSpawnBridge();
        const adapter = new SubagentAdapter(mockBridge);
        const armId = nextArmId();
        const spec = makeSubagentSpec(armId);

        // Spawn
        const ref = await adapter.spawn(spec);
        expect(ref.adapter_type).toBe("structured_subagent");
        expect(ref.session_id).toBeTruthy();

        // Register in DB
        registerArm(registry, armId, "structured_subagent", ref, spec);

        // Verify in listArms
        const arms = registry.listArms({ mission_id: `mission-${RUN_PREFIX}` });
        const found = arms.find((a) => a.arm_id === armId);
        expect(found).toBeDefined();
        expect(found?.adapter_type).toBe("structured_subagent");

        // Verify bridge tracked the spawn
        expect(mockBridge.calls.spawn).toHaveLength(1);
        expect(mockBridge.aliveMap.get(ref.session_id)).toBe(true);

        // Terminate
        await adapter.terminate(ref);

        // Verify bridge cancelled
        expect(mockBridge.calls.cancel).toHaveLength(1);
        expect(mockBridge.aliveMap.get(ref.session_id)).toBe(false);
      },
    );

    // ── structured_acp (mock bridge, adapter-level) ──────────────────────

    it(
      "acp adapter (mock bridge) spawns, appears in listArms, terminates",
      {
        timeout: 15_000,
      },
      async () => {
        harness = makeHarness();
        const { registry } = harness;
        const mockBridge = createMockAcpxBridge();
        const silentLogger = { warn: (_msg: string): void => {} };
        const adapter = new AcpAdapter(mockBridge, silentLogger);
        const armId = nextArmId();
        const spec = makeAcpSpec(armId);

        // Spawn
        const ref = await adapter.spawn(spec);
        expect(ref.adapter_type).toBe("structured_acp");
        expect(ref.session_id).toBeTruthy();

        // Register in DB
        registerArm(registry, armId, "structured_acp", ref, spec);

        // Verify in listArms
        const arms = registry.listArms({ mission_id: `mission-${RUN_PREFIX}` });
        const found = arms.find((a) => a.arm_id === armId);
        expect(found).toBeDefined();
        expect(found?.adapter_type).toBe("structured_acp");

        // Verify bridge tracked the spawn
        expect(mockBridge.calls.spawn).toHaveLength(1);

        // Terminate
        await adapter.terminate(ref);

        // Verify bridge closed
        expect(mockBridge.calls.close).toHaveLength(1);
      },
    );

    // ── Cross-adapter type field check ───────────────────────────────────

    it(
      "all 4 adapter types report correct adapter_type field on each arm",
      {
        timeout: 30_000,
      },
      async () => {
        harness = makeHarness();
        const { registry, tmuxManager } = harness;
        const missionId = `mission-${RUN_PREFIX}`;

        // Track refs for cleanup
        const cleanups: Array<() => Promise<void>> = [];

        // pty_tmux
        const ptyAdapter = new PtyTmuxAdapter(tmuxManager);
        const ptyArmId = nextArmId();
        const ptySpec = makePtyTmuxSpec(ptyArmId);
        const ptyRef = await ptyAdapter.spawn(ptySpec);
        registerArm(registry, ptyArmId, "pty_tmux", ptyRef, ptySpec);
        cleanups.push(async () => ptyAdapter.terminate(ptyRef));

        // cli_exec
        const cliAdapter = new CliExecAdapter();
        const cliArmId = nextArmId();
        const cliSpec = makeCliExecSpec(cliArmId);
        const cliRef = await cliAdapter.spawn(cliSpec);
        registerArm(registry, cliArmId, "cli_exec", cliRef, cliSpec);
        cleanups.push(async () => cliAdapter.terminate(cliRef));

        // structured_subagent
        const subBridge = createMockSessionsSpawnBridge();
        const subAdapter = new SubagentAdapter(subBridge);
        const subArmId = nextArmId();
        const subSpec = makeSubagentSpec(subArmId);
        const subRef = await subAdapter.spawn(subSpec);
        registerArm(registry, subArmId, "structured_subagent", subRef, subSpec);
        cleanups.push(async () => subAdapter.terminate(subRef));

        // structured_acp
        const acpBridge = createMockAcpxBridge();
        const silentLogger = { warn: (_msg: string): void => {} };
        const acpAdapter = new AcpAdapter(acpBridge, silentLogger);
        const acpArmId = nextArmId();
        const acpSpec = makeAcpSpec(acpArmId);
        const acpRef = await acpAdapter.spawn(acpSpec);
        registerArm(registry, acpArmId, "structured_acp", acpRef, acpSpec);
        cleanups.push(async () => acpAdapter.terminate(acpRef));

        // Verify all 4 in registry
        const arms = registry.listArms({ mission_id: missionId });
        expect(arms).toHaveLength(4);

        const types = new Set(arms.map((a) => a.adapter_type));
        expect(types).toEqual(
          new Set(["pty_tmux", "cli_exec", "structured_subagent", "structured_acp"]),
        );

        // Verify each arm's adapter_type matches its expected value
        const byId = new Map(arms.map((a) => [a.arm_id, a]));
        expect(byId.get(ptyArmId)?.adapter_type).toBe("pty_tmux");
        expect(byId.get(cliArmId)?.adapter_type).toBe("cli_exec");
        expect(byId.get(subArmId)?.adapter_type).toBe("structured_subagent");
        expect(byId.get(acpArmId)?.adapter_type).toBe("structured_acp");

        // Cleanup all
        for (const cleanup of cleanups) {
          await cleanup();
        }
      },
    );
  },
);
