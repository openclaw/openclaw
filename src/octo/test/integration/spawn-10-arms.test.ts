// Octopus Orchestrator -- Integration test: spawn 10 arms under 30 seconds (M1-28)
//
// PRD success metric: spawn 10 arms concurrently, all reach `starting`
// within 30 seconds wall clock. This validates the M1-14 end-to-end path
// through OctoGatewayHandlers.armSpawn at scale.
//
// M1 scope limitation: armSpawn transitions arms to `starting` (not
// `active`). The `active` transition is driven asynchronously by
// ProcessWatcher / Node Agent liveness detection, which is not wired up
// in the M1 synchronous spawn path. The full `starting -> active`
// lifecycle will be validated in a later milestone when the async
// liveness detection loop is integrated.
//
// Boundary discipline (OCTO-DEC-033): only `node:*` builtins,
// `@sinclair/typebox`, and relative imports inside `src/octo/`.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLogService } from "../../head/event-log.ts";
import { RegistryService } from "../../head/registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "../../head/storage/migrate.ts";
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
// Per-run session-name scoping for safe cleanup
// ──────────────────────────────────────────────────────────────────────────

const RUN_PREFIX = `m1-28-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

const ARM_COUNT = 10;
const PRD_BUDGET_MS = 30_000;

interface Harness {
  tempDir: string;
  registry: RegistryService;
  eventLog: EventLogService;
  tmuxManager: TmuxManager;
  handlers: OctoGatewayHandlers;
  eventLogPath: string;
  closeDb: () => void;
}

let armCounter = 0;
function nextTestArmId(): string {
  armCounter += 1;
  return `arm-${RUN_PREFIX}-${armCounter}`;
}

function makeHarness(): Harness {
  const tempDir = mkdtempSync(path.join(tmpdir(), "octo-spawn-10-integration-"));
  const dbPath = path.join(tempDir, "registry.sqlite");
  const eventLogPath = path.join(tempDir, "events.jsonl");
  const db = openOctoRegistry({ path: dbPath });
  const registry = new RegistryService(db);
  const eventLog = new EventLogService({ path: eventLogPath });
  const tmuxManager = new TmuxManager();

  const deps: OctoGatewayHandlerDeps = {
    registry,
    eventLog,
    tmuxManager,
    nodeId: "test-node-m1-28",
    generateArmId: () => nextTestArmId(),
  };
  const handlers = new OctoGatewayHandlers(deps);

  return {
    tempDir,
    registry,
    eventLog,
    tmuxManager,
    handlers,
    eventLogPath,
    closeDb: () => {
      try {
        closeOctoRegistry(db);
      } catch {
        // already closed
      }
    },
  };
}

function makeSpawnRequest(index: number): {
  idempotency_key: string;
  spec: ArmSpec;
} {
  return {
    idempotency_key: `spawn-10-idem-${RUN_PREFIX}-${index}`,
    spec: {
      spec_version: 1,
      mission_id: "mission-m1-28-spawn10",
      adapter_type: "pty_tmux",
      runtime_name: "bash",
      agent_id: `agent-m1-28-${index}`,
      cwd: "/tmp",
      idempotency_key: `spawn-10-idem-${RUN_PREFIX}-${index}`,
      runtime_options: {
        command: "sleep",
        args: ["300"],
      },
    },
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

function readEventLog(file: string): ReadEvent[] {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return contents
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ReadEvent);
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

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

let harness: Harness | null = null;

describe.skipIf(!TMUX_AVAILABLE)("Integration: spawn 10 arms under 30s (M1-28 PRD metric)", () => {
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

  it(
    "spawns 10 arms concurrently, all reaching starting state within 30s wall clock",
    { timeout: 60_000 },
    async () => {
      harness = makeHarness();
      const { handlers, registry, eventLogPath } = harness;

      // -- Spawn 10 arms concurrently and measure wall clock --
      const startMs = performance.now();
      const results = await Promise.all(
        Array.from({ length: ARM_COUNT }, (_, i) => handlers.armSpawn(makeSpawnRequest(i))),
      );
      const elapsedMs = performance.now() - startMs;

      // -- PRD metric: under 30 seconds --
      expect(elapsedMs).toBeLessThan(PRD_BUDGET_MS);

      // -- All 10 resolved without throwing --
      expect(results).toHaveLength(ARM_COUNT);

      // -- Registry has 10 arm rows, all in state "starting" --
      const arms = registry.listArms({ node_id: "test-node-m1-28" });
      expect(arms).toHaveLength(ARM_COUNT);
      for (const arm of arms) {
        expect(arm.state).toBe("starting");
      }

      // -- Event log has 20 events (10 x arm.created + 10 x arm.starting) --
      const events = readEventLog(eventLogPath);
      expect(events).toHaveLength(ARM_COUNT * 2);
      const createdEvents = events.filter((e) => e.event_type === "arm.created");
      const startingEvents = events.filter((e) => e.event_type === "arm.starting");
      expect(createdEvents).toHaveLength(ARM_COUNT);
      expect(startingEvents).toHaveLength(ARM_COUNT);

      // -- 10 tmux sessions exist matching octo-arm- prefix --
      const sessionNames = await rawListSessionNames();
      const ourSessions = sessionNames.filter((n) => n.includes(RUN_PREFIX));
      expect(ourSessions).toHaveLength(ARM_COUNT);
      for (const name of ourSessions) {
        expect(name).toMatch(/^octo-arm-/);
      }
    },
  );

  it("each spawned arm has a unique arm_id and session_ref", { timeout: 60_000 }, async () => {
    harness = makeHarness();
    const { handlers } = harness;

    const results = await Promise.all(
      Array.from({ length: ARM_COUNT }, (_, i) => handlers.armSpawn(makeSpawnRequest(i))),
    );

    const armIds = results.map((r) => r.arm_id);
    const uniqueIds = new Set(armIds);
    expect(uniqueIds.size).toBe(ARM_COUNT);

    const sessionNames = results.map((r) => r.session_ref.tmux_session_name);
    const uniqueSessions = new Set(sessionNames);
    expect(uniqueSessions.size).toBe(ARM_COUNT);
  });

  it(
    "all arm_ids reference the run prefix for safe tmux cleanup scoping",
    { timeout: 60_000 },
    async () => {
      harness = makeHarness();
      const { handlers } = harness;

      const results = await Promise.all(
        Array.from({ length: ARM_COUNT }, (_, i) => handlers.armSpawn(makeSpawnRequest(i))),
      );

      for (const result of results) {
        expect(result.arm_id).toContain(RUN_PREFIX);
        expect(result.session_ref.tmux_session_name).toContain(RUN_PREFIX);
      }
    },
  );
});
