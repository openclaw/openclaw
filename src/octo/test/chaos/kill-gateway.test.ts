// Octopus Orchestrator — Chaos test: Gateway kill during active arms (M1-26)
//
// Validates EVENT LOG DURABILITY and REPLAY RECONSTRUCTION after a
// simulated Gateway crash. The "Gateway" is the RegistryService +
// EventLogService pair. "Killing" it means closing the SQLite handle;
// "restarting" means re-opening from the same on-disk path.
//
// Test flow:
//   1. Stand up temp DB + event log in a temp dir
//   2. Spawn 3 arms via OctoGatewayHandlers.armSpawn
//   3. Close the registry (simulates Gateway crash)
//   4. Re-open the registry from the SAME temp DB path
//   5. Assert all arm rows survived with correct states
//   6. Replay the event log and assert: correct count, no duplicate
//      event_ids (ULID monotonicity), events in order
//   7. Run SessionReconciler.reconcile against re-opened registry +
//      still-alive tmux sessions and assert all arms are recovered
//
// Boundary discipline (OCTO-DEC-033): only `@sinclair/typebox`,
// `node:*` builtins, and relative imports inside `src/octo/`.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EventLogService } from "../../head/event-log.ts";
import { RegistryService } from "../../head/registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "../../head/storage/migrate.ts";
import { SessionReconciler } from "../../node-agent/session-reconciler.ts";
import { TmuxManager } from "../../node-agent/tmux-manager.ts";
import type { EventEnvelope } from "../../wire/events.ts";
import { OctoGatewayHandlers, type OctoGatewayHandlerDeps } from "../../wire/gateway-handlers.ts";
import type { OctoArmSpawnRequest } from "../../wire/methods.ts";
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
// Per-run session name scoping
// ──────────────────────────────────────────────────────────────────────────

const RUN_PREFIX = `m1-26-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
// Event log reader
// ──────────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────────
// Test fixtures
// ──────────────────────────────────────────────────────────────────────────

const NODE_ID = "test-node-m1-26";

let armCounter = 0;
function nextTestArmId(tag: string): string {
  armCounter += 1;
  return `${RUN_PREFIX}-${tag}-${armCounter}`;
}

function makeArmSpec(overrides: Partial<ArmSpec> = {}): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "mission-m1-26",
    adapter_type: "pty_tmux",
    runtime_name: "bash",
    agent_id: "agent-m1-26",
    cwd: "/tmp",
    idempotency_key: `idem-${Math.random().toString(36).slice(2, 10)}`,
    runtime_options: {
      command: "sleep",
      args: ["120"],
    },
    ...overrides,
  };
}

function makeSpawnRequest(specOverrides: Partial<ArmSpec> = {}): OctoArmSpawnRequest {
  const spec = makeArmSpec(specOverrides);
  return {
    idempotency_key: spec.idempotency_key,
    spec,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════

describe.skipIf(!TMUX_AVAILABLE)("Chaos: kill Gateway during active arms (M1-26)", () => {
  afterEach(async () => {
    await sweepRunSessions();
  });

  afterAll(async () => {
    await sweepRunSessions();
  });

  it("registry survives Gateway crash: arm rows persist through close + re-open", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "octo-chaos-kill-gw-"));
    const dbPath = path.join(tempDir, "registry.sqlite");
    const eventLogPath = path.join(tempDir, "events.jsonl");

    try {
      // Phase 1: open services, spawn 3 arms
      const armIds: string[] = [];
      let db = openOctoRegistry({ path: dbPath });
      let registry = new RegistryService(db);
      const eventLog = new EventLogService({ path: eventLogPath });
      const tmuxManager = new TmuxManager();

      let tick = 1_700_000_000_000;
      const armIdGen = (): string => {
        const id = nextTestArmId("crash");
        armIds.push(id);
        return id;
      };

      const deps: OctoGatewayHandlerDeps = {
        registry,
        eventLog,
        tmuxManager,
        nodeId: NODE_ID,
        now: () => {
          const t = tick;
          tick += 1000;
          return t;
        },
        generateArmId: armIdGen,
      };
      const handlers = new OctoGatewayHandlers(deps);

      // Spawn 3 arms
      for (let i = 0; i < 3; i++) {
        await handlers.armSpawn(
          makeSpawnRequest({
            idempotency_key: `idem-crash-${RUN_PREFIX}-${i}`,
          }),
        );
      }

      // Verify pre-crash state
      expect(armIds).toHaveLength(3);
      for (const id of armIds) {
        const row = registry.getArm(id);
        expect(row).not.toBeNull();
        expect(row?.state).toBe("starting");
      }

      // Phase 2: KILL the Gateway (close DB handle)
      closeOctoRegistry(db);

      // Phase 3: RESTART the Gateway (re-open from same path)
      db = openOctoRegistry({ path: dbPath });
      registry = new RegistryService(db);

      // Phase 4: Assert arm rows survived with correct states
      for (const id of armIds) {
        const row = registry.getArm(id);
        expect(row).not.toBeNull();
        expect(row?.state).toBe("starting");
        expect(row?.node_id).toBe(NODE_ID);
        expect(row?.adapter_type).toBe("pty_tmux");
      }
      const allArms = registry.listArms({ node_id: NODE_ID });
      expect(allArms.length).toBe(3);

      // Cleanup
      closeOctoRegistry(db);
      rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      // Best-effort cleanup on failure
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // swallow
      }
      throw err;
    }
  }, 30_000);

  it("event log replay after Gateway crash: correct count, no duplicates, ordered", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "octo-chaos-replay-"));
    const dbPath = path.join(tempDir, "registry.sqlite");
    const eventLogPath = path.join(tempDir, "events.jsonl");

    try {
      // Phase 1: open services, spawn 3 arms
      const armIds: string[] = [];
      const db = openOctoRegistry({ path: dbPath });
      const registry = new RegistryService(db);
      const eventLog = new EventLogService({ path: eventLogPath });
      const tmuxManager = new TmuxManager();

      let tick = 1_700_000_000_000;
      const deps: OctoGatewayHandlerDeps = {
        registry,
        eventLog,
        tmuxManager,
        nodeId: NODE_ID,
        now: () => {
          const t = tick;
          tick += 1000;
          return t;
        },
        generateArmId: () => {
          const id = nextTestArmId("replay");
          armIds.push(id);
          return id;
        },
      };
      const handlers = new OctoGatewayHandlers(deps);

      for (let i = 0; i < 3; i++) {
        await handlers.armSpawn(
          makeSpawnRequest({
            idempotency_key: `idem-replay-${RUN_PREFIX}-${i}`,
          }),
        );
      }

      // Phase 2: close the Gateway
      closeOctoRegistry(db);

      // Phase 3: read raw events from the file
      const rawEvents = readEventLog(eventLogPath);
      // 3 arms x 2 events each (arm.created + arm.starting) = 6
      expect(rawEvents).toHaveLength(6);

      // Phase 4: no duplicate event_ids
      const eventIds = rawEvents.map((e) => e.event_id);
      const uniqueIds = new Set(eventIds);
      expect(uniqueIds.size).toBe(eventIds.length);

      // Phase 5: events are in ULID-monotonic order (lexicographic)
      for (let i = 1; i < eventIds.length; i++) {
        const prev = eventIds[i - 1];
        const curr = eventIds[i];
        expect(curr > prev).toBe(true);
      }

      // Phase 6: replay via EventLogService.replay matches raw count
      const freshEventLog = new EventLogService({ path: eventLogPath });
      const replayedEvents: EventEnvelope[] = [];
      const replayCount = await freshEventLog.replay((envelope) => {
        replayedEvents.push(envelope);
      });
      expect(replayCount).toBe(6);
      expect(replayedEvents).toHaveLength(6);

      // Phase 7: replayed event_ids match raw event_ids exactly
      const replayedIds = replayedEvents.map((e) => e.event_id);
      expect(replayedIds).toEqual(eventIds);

      // Phase 8: event ordering by type is correct per arm
      for (const armId of armIds) {
        const armEvents = replayedEvents.filter((e) => e.entity_id === armId);
        expect(armEvents).toHaveLength(2);
        expect(armEvents[0]?.event_type).toBe("arm.created");
        expect(armEvents[1]?.event_type).toBe("arm.starting");
      }

      // Cleanup
      rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // swallow
      }
      throw err;
    }
  }, 30_000);

  it("SessionReconciler recovers all arms after Gateway restart", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "octo-chaos-reconcile-"));
    const dbPath = path.join(tempDir, "registry.sqlite");
    const eventLogPath = path.join(tempDir, "events.jsonl");

    try {
      // Phase 1: open services, spawn 2 arms
      const armIds: string[] = [];
      let db = openOctoRegistry({ path: dbPath });
      let registry = new RegistryService(db);
      const eventLog = new EventLogService({ path: eventLogPath });
      const tmuxManager = new TmuxManager();

      let tick = 1_700_000_000_000;
      const deps: OctoGatewayHandlerDeps = {
        registry,
        eventLog,
        tmuxManager,
        nodeId: NODE_ID,
        now: () => {
          const t = tick;
          tick += 1000;
          return t;
        },
        generateArmId: () => {
          const id = nextTestArmId("reconcile");
          armIds.push(id);
          return id;
        },
      };
      const handlers = new OctoGatewayHandlers(deps);

      for (let i = 0; i < 2; i++) {
        await handlers.armSpawn(
          makeSpawnRequest({
            idempotency_key: `idem-reconcile-${RUN_PREFIX}-${i}`,
          }),
        );
      }

      // Verify tmux sessions are alive pre-crash
      const livePre = await rawListSessionNames();
      for (const id of armIds) {
        expect(livePre).toContain(`octo-arm-${id}`);
      }

      // Phase 2: KILL the Gateway
      closeOctoRegistry(db);

      // Phase 3: RESTART the Gateway
      db = openOctoRegistry({ path: dbPath });
      registry = new RegistryService(db);

      // Phase 4: run SessionReconciler against re-opened registry
      const reconciler = new SessionReconciler(tmuxManager, registry, {
        nodeId: NODE_ID,
        now: () => Date.now(),
      });
      const report = await reconciler.reconcile();

      // All arms should be recovered (starting -> active).
      // orphan_count may be >0 if other test runs left stale
      // octo-arm-* sessions on the machine; we only assert that
      // OUR arms were recovered and none are missing.
      expect(report.recovered_count).toBe(2);
      expect(report.missing_count).toBe(0);

      // Verify arm states were transitioned to active
      for (const id of armIds) {
        const row = registry.getArm(id);
        expect(row).not.toBeNull();
        expect(row?.state).toBe("active");
      }

      // Verify no duplicate execution: event log still has exactly
      // 2 arms x 2 events = 4 events (reconciler does NOT append
      // events; it returns outcomes for the caller to emit)
      const events = readEventLog(eventLogPath);
      expect(events).toHaveLength(4);
      const eventIds = events.map((e) => e.event_id);
      expect(new Set(eventIds).size).toBe(eventIds.length);

      // Cleanup
      closeOctoRegistry(db);
      rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // swallow
      }
      throw err;
    }
  }, 30_000);

  it("no duplicate execution: replayed events match pre-crash events exactly", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "octo-chaos-nodup-"));
    const dbPath = path.join(tempDir, "registry.sqlite");
    const eventLogPath = path.join(tempDir, "events.jsonl");

    try {
      // Phase 1: spawn arms
      const armIds: string[] = [];
      const db = openOctoRegistry({ path: dbPath });
      const registry = new RegistryService(db);
      const eventLog = new EventLogService({ path: eventLogPath });
      const tmuxManager = new TmuxManager();

      let tick = 1_700_000_000_000;
      const deps: OctoGatewayHandlerDeps = {
        registry,
        eventLog,
        tmuxManager,
        nodeId: NODE_ID,
        now: () => {
          const t = tick;
          tick += 1000;
          return t;
        },
        generateArmId: () => {
          const id = nextTestArmId("nodup");
          armIds.push(id);
          return id;
        },
      };
      const handlers = new OctoGatewayHandlers(deps);

      for (let i = 0; i < 3; i++) {
        await handlers.armSpawn(
          makeSpawnRequest({
            idempotency_key: `idem-nodup-${RUN_PREFIX}-${i}`,
          }),
        );
      }

      // Snapshot pre-crash events
      const preCrashEvents = readEventLog(eventLogPath);
      const preCrashIds = preCrashEvents.map((e) => e.event_id);

      // Phase 2: crash + restart
      closeOctoRegistry(db);

      // Phase 3: replay and compare
      const freshEventLog = new EventLogService({ path: eventLogPath });
      const postCrashEvents: EventEnvelope[] = [];
      await freshEventLog.replay((envelope) => {
        postCrashEvents.push(envelope);
      });

      // Exactly the same events, same order, same ids
      const postCrashIds = postCrashEvents.map((e) => e.event_id);
      expect(postCrashIds).toEqual(preCrashIds);
      expect(postCrashEvents).toHaveLength(preCrashEvents.length);

      // No duplicate event_ids across the entire log
      expect(new Set(postCrashIds).size).toBe(postCrashIds.length);

      // Cleanup
      rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // swallow
      }
      throw err;
    }
  }, 30_000);
});
