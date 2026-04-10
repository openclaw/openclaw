// Octopus Orchestrator — OctoGatewayHandlers.armSpawn tests (M1-14)
//
// Live tmux integration tests covering the octo.arm.spawn handler:
//   - happy path: arm row + tmux session + ordered events
//   - request envelope validation
//   - ArmSpec cross-check (runtime_options / adapter_type mismatch)
//   - M1 stub rejection of non-pty_tmux adapters
//   - idempotency on spec.idempotency_key
//   - arm.created emitted before arm.starting
//   - session_ref populated after tmux createSession
//   - tmux failure path drives arm -> failed + emits arm.failed
//   - canonical session-name prefix octo-arm-
//
// Session-name scoping: every test uses a deterministic arm_id with a
// per-run prefix so the afterEach/afterAll sweep can kill leftovers
// without collateral damage. The handler's canonical prefix is
// `octo-arm-`, so the full session name is
// `octo-arm-<RUN_PREFIX>-<tag>`.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Value } from "@sinclair/typebox/value";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLogService } from "../head/event-log.ts";
import { LeaseService } from "../head/leases.ts";
import type { PolicyService } from "../head/policy.ts";
import { RegistryService } from "../head/registry.ts";
import type { ArmRecord } from "../head/registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "../head/storage/migrate.ts";
import { TmuxManager } from "../node-agent/tmux-manager.ts";
import {
  HandlerError,
  OctoGatewayHandlers,
  type LeaseRenewResult,
  type OctoGatewayHandlerDeps,
} from "./gateway-handlers.ts";
import {
  OctoArmAttachResponseSchema,
  OctoArmHealthResponseSchema,
  OctoArmSendResponseSchema,
} from "./methods.ts";
import type {
  OctoArmAttachRequest,
  OctoArmHealthRequest,
  OctoArmSendRequest,
  OctoArmSpawnRequest,
  OctoArmTerminateRequest,
} from "./methods.ts";
import type { ArmSpec } from "./schema.ts";

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

const RUN_PREFIX = `m1-14-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
// Test fixtures
// ──────────────────────────────────────────────────────────────────────────

interface Harness {
  tempDir: string;
  registry: RegistryService;
  eventLog: EventLogService;
  tmuxManager: TmuxManager;
  handlers: OctoGatewayHandlers;
  eventLogPath: string;
  closeDb: () => void;
}

function makeArmSpec(overrides: Partial<ArmSpec> = {}): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "mission-m1-14",
    adapter_type: "pty_tmux",
    runtime_name: "bash",
    agent_id: "agent-m1-14",
    cwd: "/tmp",
    idempotency_key: "idem-default",
    runtime_options: {
      command: "sleep",
      args: ["60"],
    },
    ...overrides,
  };
}

function makeSpawnRequest(
  specOverrides: Partial<ArmSpec> = {},
  envelopeOverrides: Partial<OctoArmSpawnRequest> = {},
): OctoArmSpawnRequest {
  return {
    idempotency_key: "envelope-idem-default",
    spec: makeArmSpec(specOverrides),
    ...envelopeOverrides,
  };
}

let armCounter = 0;
function nextTestArmId(tag: string): string {
  armCounter += 1;
  return `arm-${RUN_PREFIX}-${tag}-${armCounter}`;
}

function makeHarness(
  opts: {
    now?: () => number;
    generateArmId?: () => string;
    tmuxManager?: TmuxManager;
    policyService?: PolicyService;
  } = {},
): Harness {
  const tempDir = mkdtempSync(path.join(tmpdir(), "octo-gateway-handlers-test-"));
  const dbPath = path.join(tempDir, "registry.sqlite");
  const eventLogPath = path.join(tempDir, "events.jsonl");
  const db = openOctoRegistry({ path: dbPath });
  const registry = new RegistryService(db);
  const eventLog = new EventLogService({ path: eventLogPath });
  const tmuxManager = opts.tmuxManager ?? new TmuxManager();

  const deps: OctoGatewayHandlerDeps = {
    registry,
    eventLog,
    tmuxManager,
    nodeId: "test-node-m1-14",
    now: opts.now ?? (() => 1_700_000_000_000),
    generateArmId: opts.generateArmId,
    policyService: opts.policyService,
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
// Harness state (fresh per test)
// ──────────────────────────────────────────────────────────────────────────

let harness: Harness | null = null;

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

// ══════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════

describe.skipIf(!TMUX_AVAILABLE)("OctoGatewayHandlers.armSpawn (M1-14)", () => {
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

  it("octo.arm.spawn happy path with pty_tmux adapter creates arm and tmux session", async () => {
    const armId = nextTestArmId("happy");
    harness = makeHarness({ generateArmId: () => armId });
    const request = makeSpawnRequest({ idempotency_key: "idem-happy" });

    const response = await harness.handlers.armSpawn(request);

    expect(response.arm_id).toBe(armId);
    expect(response.session_ref.tmux_session_name).toBe(`octo-arm-${armId}`);
    expect(response.session_ref.cwd).toBe("/tmp");

    // Registry has the arm in state "starting" with the session_ref set.
    const row = harness.registry.getArm(armId);
    expect(row).not.toBeNull();
    expect(row?.state).toBe("starting");
    expect(row?.node_id).toBe("test-node-m1-14");
    expect(row?.session_ref).toEqual({
      tmux_session_name: `octo-arm-${armId}`,
      cwd: "/tmp",
    });

    // tmux session exists.
    const liveSessions = await rawListSessionNames();
    expect(liveSessions).toContain(`octo-arm-${armId}`);

    // Event log has arm.created THEN arm.starting for this arm.
    const events = readEventLog(harness.eventLogPath).filter((e) => e.entity_id === armId);
    expect(events.length).toBe(2);
    expect(events[0]?.event_type).toBe("arm.created");
    expect(events[1]?.event_type).toBe("arm.starting");
  });

  it("octo.arm.spawn rejects an invalid request envelope (missing idempotency_key)", async () => {
    harness = makeHarness();
    const badRequest = {
      // missing idempotency_key
      spec: makeArmSpec({ idempotency_key: "idem-bad-envelope" }),
    };

    await expect(harness.handlers.armSpawn(badRequest)).rejects.toBeInstanceOf(HandlerError);
    await expect(harness.handlers.armSpawn(badRequest)).rejects.toMatchObject({
      code: "invalid_spec",
    });
  });

  it("octo.arm.spawn rejects a request with invalid ArmSpec business rules (runtime_options mismatch)", async () => {
    harness = makeHarness();
    // adapter_type pty_tmux but runtime_options shaped like structured_acp.
    const badRequest = {
      idempotency_key: "envelope-idem",
      spec: {
        spec_version: 1,
        mission_id: "mission-1",
        adapter_type: "pty_tmux",
        runtime_name: "bash",
        agent_id: "agent-1",
        cwd: "/tmp",
        idempotency_key: "idem-cross-check",
        runtime_options: {
          acpxHarness: "claude",
        },
      },
    };

    await expect(harness.handlers.armSpawn(badRequest)).rejects.toBeInstanceOf(HandlerError);
    await expect(harness.handlers.armSpawn(badRequest)).rejects.toMatchObject({
      code: "invalid_spec",
    });
  });

  it("octo.arm.spawn rejects adapter_type when bridge dep is missing (not_supported)", async () => {
    harness = makeHarness();
    const request = makeSpawnRequest({
      adapter_type: "structured_subagent",
      idempotency_key: "idem-unsupported-adapter",
      runtime_options: {},
    });

    let thrown: unknown;
    try {
      await harness.handlers.armSpawn(request);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("invalid_spec");
    expect((thrown as HandlerError).message).toMatch(/sessionsSpawnBridge/);
  });

  it("octo.arm.spawn is idempotent on the same idempotency_key (single arm + single tmux session)", async () => {
    const armId = nextTestArmId("idem");
    harness = makeHarness({ generateArmId: () => armId });
    const request = makeSpawnRequest({ idempotency_key: "idem-replay" });

    const first = await harness.handlers.armSpawn(request);
    const second = await harness.handlers.armSpawn(request);

    expect(second.arm_id).toBe(first.arm_id);
    expect(second.session_ref).toEqual(first.session_ref);

    // Only one arm row.
    const arms = harness.registry.listArms({});
    expect(arms.length).toBe(1);

    // Only one tmux session with the canonical name.
    const live = await rawListSessionNames();
    const matches = live.filter((n) => n === `octo-arm-${armId}`);
    expect(matches.length).toBe(1);

    // Event log only contains the original arm.created + arm.starting
    // pair — NOT duplicated by the replay.
    const events = readEventLog(harness.eventLogPath).filter((e) => e.entity_id === armId);
    expect(events.filter((e) => e.event_type === "arm.created").length).toBe(1);
    expect(events.filter((e) => e.event_type === "arm.starting").length).toBe(1);
  });

  it("octo.arm.spawn emits arm.created before arm.starting in the event log", async () => {
    const armId = nextTestArmId("order");
    // Distinct timestamps so the ordering is visible in ts as well.
    let tick = 1_700_000_000_000;
    harness = makeHarness({
      generateArmId: () => armId,
      now: () => {
        const t = tick;
        tick += 1000;
        return t;
      },
    });
    const request = makeSpawnRequest({ idempotency_key: "idem-order" });

    await harness.handlers.armSpawn(request);

    const events = readEventLog(harness.eventLogPath).filter((e) => e.entity_id === armId);
    const createdIdx = events.findIndex((e) => e.event_type === "arm.created");
    const startingIdx = events.findIndex((e) => e.event_type === "arm.starting");
    expect(createdIdx).toBeGreaterThanOrEqual(0);
    expect(startingIdx).toBeGreaterThan(createdIdx);
  });

  it("octo.arm.spawn populates session_ref on the arm row after tmux createSession succeeds", async () => {
    const armId = nextTestArmId("sessref");
    harness = makeHarness({ generateArmId: () => armId });
    const request = makeSpawnRequest({ idempotency_key: "idem-sessref" });

    await harness.handlers.armSpawn(request);

    const row = harness.registry.getArm(armId);
    expect(row?.session_ref).not.toBeNull();
    const sessionRef = row?.session_ref as { tmux_session_name?: string; cwd?: string };
    expect(sessionRef.tmux_session_name).toBe(`octo-arm-${armId}`);
    expect(sessionRef.cwd).toBe("/tmp");
  });

  it("octo.arm.spawn handler error path: tmux createSession failure marks arm failed and raises tmux_failed", async () => {
    const armId = nextTestArmId("tmuxfail");
    // Mock TmuxManager that throws on createSession.
    class ExplodingTmux extends TmuxManager {
      async createSession(_name: string, _cmd: string, _cwd: string): Promise<string> {
        throw new Error("simulated tmux outage");
      }
    }
    harness = makeHarness({
      generateArmId: () => armId,
      tmuxManager: new ExplodingTmux(),
    });
    const request = makeSpawnRequest({ idempotency_key: "idem-tmuxfail" });

    let thrown: unknown;
    try {
      await harness.handlers.armSpawn(request);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("tmux_failed");

    // The arm row was written and driven to "failed" (not deleted).
    const row = harness.registry.getArm(armId);
    expect(row).not.toBeNull();
    expect(row?.state).toBe("failed");

    // arm.created, arm.starting, arm.failed in the log.
    const events = readEventLog(harness.eventLogPath).filter((e) => e.entity_id === armId);
    const types = events.map((e) => e.event_type);
    expect(types).toContain("arm.created");
    expect(types).toContain("arm.starting");
    expect(types).toContain("arm.failed");
  });

  it("octo.arm.spawn arm_id session naming uses the canonical octo-arm- prefix", async () => {
    const armId = nextTestArmId("prefix");
    harness = makeHarness({ generateArmId: () => armId });
    const request = makeSpawnRequest({ idempotency_key: "idem-prefix" });

    const response = await harness.handlers.armSpawn(request);

    expect(response.session_ref.tmux_session_name).toBeDefined();
    expect(response.session_ref.tmux_session_name?.startsWith("octo-arm-")).toBe(true);
    expect(response.session_ref.tmux_session_name).toBe(`octo-arm-${armId}`);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// M1-15 + M1-16 tests — armHealth + armTerminate
// ══════════════════════════════════════════════════════════════════════════

// Helper: promote a just-spawned arm (state "starting") to "active" via
// a direct casUpdate. The handler tests use this to reach a state from
// which `terminate` is a valid FSM transition, since `starting` is not
// in the set of termination sources per M1-07.
function promoteToActive(harness: Harness, arm_id: string): ArmRecord {
  const row = harness.registry.getArm(arm_id);
  if (row === null) {
    throw new Error(`promoteToActive: arm ${arm_id} not found`);
  }
  return harness.registry.casUpdateArm(arm_id, row.version, {
    state: "active",
    updated_at: row.updated_at + 1,
  });
}

describe.skipIf(!TMUX_AVAILABLE)("OctoGatewayHandlers.armHealth (M1-15)", () => {
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

  it("armHealth returns health snapshot for a spawned arm", async () => {
    const armId = nextTestArmId("health-happy");
    harness = makeHarness({ generateArmId: () => armId });
    await harness.handlers.armSpawn(makeSpawnRequest({ idempotency_key: "idem-health-happy" }));

    const req: OctoArmHealthRequest = { arm_id: armId };
    const snapshot = await harness.handlers.armHealth(req);

    expect(snapshot.arm_id).toBe(armId);
    expect(snapshot.status).toBe("starting");
    expect(snapshot.restart_count).toBe(0);
  });

  it("armHealth returns not_found health error for unknown arm_id", async () => {
    harness = makeHarness();
    let thrown: unknown;
    try {
      await harness.handlers.armHealth({ arm_id: "arm-does-not-exist-xyz" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("not_found");
  });

  it("armHealth health response validates against OctoArmHealthResponseSchema", async () => {
    const armId = nextTestArmId("health-schema");
    harness = makeHarness({ generateArmId: () => armId });
    await harness.handlers.armSpawn(makeSpawnRequest({ idempotency_key: "idem-health-schema" }));

    const snapshot = await harness.handlers.armHealth({ arm_id: armId });
    expect(Value.Check(OctoArmHealthResponseSchema, snapshot)).toBe(true);
  });

  it("armHealth rejects an invalid request envelope with invalid_spec (health)", async () => {
    harness = makeHarness();
    let thrown: unknown;
    try {
      // missing arm_id
      await harness.handlers.armHealth({});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("invalid_spec");
  });

  it("armHealth reflects current health state after a manual transition to active", async () => {
    const armId = nextTestArmId("health-transition");
    harness = makeHarness({ generateArmId: () => armId });
    await harness.handlers.armSpawn(
      makeSpawnRequest({ idempotency_key: "idem-health-transition" }),
    );
    promoteToActive(harness, armId);

    const snapshot = await harness.handlers.armHealth({ arm_id: armId });
    expect(snapshot.status).toBe("active");
  });
});

describe.skipIf(!TMUX_AVAILABLE)("OctoGatewayHandlers.armTerminate (M1-16)", () => {
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

  it("armTerminate happy path: terminates an active spawned arm and emits event", async () => {
    const armId = nextTestArmId("term-happy");
    harness = makeHarness({ generateArmId: () => armId });
    await harness.handlers.armSpawn(makeSpawnRequest({ idempotency_key: "idem-term-happy" }));
    promoteToActive(harness, armId);

    const req: OctoArmTerminateRequest = {
      idempotency_key: "idem-term-happy-call",
      arm_id: armId,
      reason: "test-requested shutdown",
    };
    const response = await harness.handlers.armTerminate(req);

    expect(response.arm_id).toBe(armId);
    expect(response.terminated).toBe(true);
    expect(response.final_status).toBe("terminated");

    // Arm row transitioned to terminated.
    const row = harness.registry.getArm(armId);
    expect(row?.state).toBe("terminated");
    expect(row?.health_status).toBe("terminated");

    // tmux session is gone.
    const live = await rawListSessionNames();
    expect(live).not.toContain(`octo-arm-${armId}`);

    // Event log contains arm.terminated with the reason in the payload.
    const events = readEventLog(harness.eventLogPath).filter((e) => e.entity_id === armId);
    const terminatedEvent = events.find((e) => e.event_type === "arm.terminated");
    expect(terminatedEvent).toBeDefined();
    expect(terminatedEvent?.payload.reason).toBe("test-requested shutdown");
  });

  it("armTerminate returns not_found for unknown arm_id on terminate", async () => {
    harness = makeHarness();
    let thrown: unknown;
    try {
      await harness.handlers.armTerminate({
        idempotency_key: "idem-term-notfound",
        arm_id: "arm-missing-xyz",
        reason: "cleanup",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("not_found");
  });

  it("armTerminate rejects an invalid terminate request envelope with invalid_spec", async () => {
    harness = makeHarness();
    let thrown: unknown;
    try {
      // missing reason
      await harness.handlers.armTerminate({
        idempotency_key: "idem-term-bad",
        arm_id: "whatever",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("invalid_spec");
  });

  it("armTerminate is idempotent when the arm has already been terminated", async () => {
    const armId = nextTestArmId("term-idem");
    harness = makeHarness({ generateArmId: () => armId });
    await harness.handlers.armSpawn(makeSpawnRequest({ idempotency_key: "idem-term-idem" }));
    promoteToActive(harness, armId);

    const req: OctoArmTerminateRequest = {
      idempotency_key: "idem-term-idem-1",
      arm_id: armId,
      reason: "first call",
    };
    const first = await harness.handlers.armTerminate(req);
    expect(first.terminated).toBe(true);

    // Second call with a different reason should succeed without error
    // and should NOT produce a duplicate arm.terminated event (the
    // handler takes the idempotent no-op path as soon as it sees the
    // arm is already in state "terminated").
    const second = await harness.handlers.armTerminate({
      idempotency_key: "idem-term-idem-2",
      arm_id: armId,
      reason: "second call",
    });
    expect(second.terminated).toBe(true);
    expect(second.final_status).toBe("terminated");

    const events = readEventLog(harness.eventLogPath).filter(
      (e) => e.entity_id === armId && e.event_type === "arm.terminated",
    );
    expect(events.length).toBe(1);
  });

  it("armTerminate rejects terminate call on a completed arm with invalid_state", async () => {
    const armId = nextTestArmId("term-completed");
    harness = makeHarness({ generateArmId: () => armId });
    await harness.handlers.armSpawn(makeSpawnRequest({ idempotency_key: "idem-term-completed" }));
    promoteToActive(harness, armId);
    // active -> completed is a valid FSM edge, but completed -> terminated is NOT.
    const activeRow = harness.registry.getArm(armId);
    if (activeRow === null) {
      throw new Error("missing arm after promote");
    }
    harness.registry.casUpdateArm(armId, activeRow.version, {
      state: "completed",
      updated_at: activeRow.updated_at + 1,
    });

    let thrown: unknown;
    try {
      await harness.handlers.armTerminate({
        idempotency_key: "idem-term-completed-call",
        arm_id: armId,
        reason: "trying the impossible",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("invalid_state");
    expect((thrown as HandlerError).details?.current_state).toBe("completed");
  });

  it("armTerminate can terminate gracefully when the tmux session is already gone", async () => {
    const armId = nextTestArmId("term-notmux");
    harness = makeHarness({ generateArmId: () => armId });
    await harness.handlers.armSpawn(makeSpawnRequest({ idempotency_key: "idem-term-notmux" }));
    promoteToActive(harness, armId);

    // Kill the tmux session out from under the handler.
    await harness.tmuxManager.killSession(`octo-arm-${armId}`);

    const response = await harness.handlers.armTerminate({
      idempotency_key: "idem-term-notmux-call",
      arm_id: armId,
      reason: "session already gone",
    });
    expect(response.terminated).toBe(true);

    // Event payload should record that tmux did NOT kill anything
    // (because it was already dead).
    const events = readEventLog(harness.eventLogPath).filter(
      (e) => e.entity_id === armId && e.event_type === "arm.terminated",
    );
    expect(events.length).toBe(1);
    expect(events[0]?.payload.tmux_session_killed).toBe(false);
  });

  it("armTerminate writes the reason into the arm.terminated event payload", async () => {
    const armId = nextTestArmId("term-reason");
    harness = makeHarness({ generateArmId: () => armId });
    await harness.handlers.armSpawn(makeSpawnRequest({ idempotency_key: "idem-term-reason" }));
    promoteToActive(harness, armId);

    const reason = "operator requested shutdown";
    await harness.handlers.armTerminate({
      idempotency_key: "idem-term-reason-call",
      arm_id: armId,
      reason,
    });

    const events = readEventLog(harness.eventLogPath).filter(
      (e) => e.entity_id === armId && e.event_type === "arm.terminated",
    );
    expect(events.length).toBe(1);
    expect(events[0]?.payload.reason).toBe(reason);
  });

  it("armTerminate terminate with force true flows the force hint through to the event payload", async () => {
    const armId = nextTestArmId("term-force");
    harness = makeHarness({ generateArmId: () => armId });
    await harness.handlers.armSpawn(makeSpawnRequest({ idempotency_key: "idem-term-force" }));
    promoteToActive(harness, armId);

    await harness.handlers.armTerminate({
      idempotency_key: "idem-term-force-call",
      arm_id: armId,
      reason: "force shutdown",
      force: true,
    });

    const row = harness.registry.getArm(armId);
    expect(row?.state).toBe("terminated");

    const events = readEventLog(harness.eventLogPath).filter(
      (e) => e.entity_id === armId && e.event_type === "arm.terminated",
    );
    expect(events.length).toBe(1);
    expect(events[0]?.payload.force).toBe(true);
  });

  it("armTerminate returns conflict on a concurrent terminate race", async () => {
    const armId = nextTestArmId("term-conflict");
    harness = makeHarness({ generateArmId: () => armId });
    await harness.handlers.armSpawn(makeSpawnRequest({ idempotency_key: "idem-term-conflict" }));
    promoteToActive(harness, armId);

    // Simulate a concurrent writer by wrapping the registry's getArm
    // method so it returns a stale version (one less than the current
    // row version). The handler will then attempt casUpdateArm with a
    // version that no longer matches, producing a ConflictError that
    // the handler surfaces as HandlerError("conflict").
    const realGetArm = harness.registry.getArm.bind(harness.registry);
    harness.registry.getArm = (id: string) => {
      const row = realGetArm(id);
      if (row === null || id !== armId) {
        return row;
      }
      return { ...row, version: row.version - 1 };
    };

    let thrown: unknown;
    try {
      await harness.handlers.armTerminate({
        idempotency_key: "idem-term-conflict-call",
        arm_id: armId,
        reason: "conflict test",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("conflict");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// M2-13 tests — armSend
// ══════════════════════════════════════════════════════════════════════════

describe.skipIf(!TMUX_AVAILABLE)("OctoGatewayHandlers.armSend (M2-13)", () => {
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

  it("send to a pty_tmux arm returns delivered false (stub adapter does not support send)", async () => {
    const armId = nextTestArmId("send-tmux");
    harness = makeHarness({ generateArmId: () => armId });
    await harness.handlers.armSpawn(makeSpawnRequest({ idempotency_key: "idem-send-tmux" }));

    const req: OctoArmSendRequest = {
      idempotency_key: "idem-send-tmux-call",
      arm_id: armId,
      kind: "keys",
      payload: "echo hello",
    };
    const response = await harness.handlers.armSend(req);

    // The real PtyTmuxAdapter supports send via tmux send-keys.
    expect(response.arm_id).toBe(armId);
    expect(response.delivered).toBe(true);
    expect(Value.Check(OctoArmSendResponseSchema, response)).toBe(true);
  });

  it("send message to a pty_tmux arm delivers successfully", async () => {
    const armId = nextTestArmId("send-unsupported");
    harness = makeHarness({ generateArmId: () => armId });
    await harness.handlers.armSpawn(makeSpawnRequest({ idempotency_key: "idem-send-unsupported" }));

    const req: OctoArmSendRequest = {
      idempotency_key: "idem-send-unsupported-call",
      arm_id: armId,
      kind: "message",
      payload: "test message",
    };
    const response = await harness.handlers.armSend(req);

    expect(response.delivered).toBe(true);
    expect(response.arm_id).toBe(armId);
  });

  it("send to unknown arm returns not_found", async () => {
    harness = makeHarness();
    let thrown: unknown;
    try {
      await harness.handlers.armSend({
        idempotency_key: "idem-send-notfound",
        arm_id: "arm-does-not-exist-send",
        kind: "keys",
        payload: "hello",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("not_found");
  });

  it("send rejects an invalid request envelope with invalid_spec", async () => {
    harness = makeHarness();
    let thrown: unknown;
    try {
      // missing kind and payload
      await harness.handlers.armSend({
        idempotency_key: "idem-send-bad",
        arm_id: "arm-whatever",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("invalid_spec");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// M2-14 tests — armAttach + armCheckpoint
// ══════════════════════════════════════════════════════════════════════════

describe.skipIf(!TMUX_AVAILABLE)("OctoGatewayHandlers.armAttach (M2-14)", () => {
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

  it("attach for a pty_tmux arm returns attach command", async () => {
    const armId = nextTestArmId("attach-tmux");
    harness = makeHarness({ generateArmId: () => armId });
    await harness.handlers.armSpawn(makeSpawnRequest({ idempotency_key: "idem-attach-tmux" }));

    const req: OctoArmAttachRequest = { arm_id: armId };
    const response = await harness.handlers.armAttach(req);

    expect(response.arm_id).toBe(armId);
    expect(response.attach_command).toBe(`tmux attach -t octo-arm-${armId}`);
    expect(response.session_ref).toBeDefined();
    expect(response.session_ref.cwd).toBe("/tmp");
    expect(Value.Check(OctoArmAttachResponseSchema, response)).toBe(true);
  });

  it("attach for a cli_exec arm returns not_supported", async () => {
    // We cannot spawn a cli_exec arm (factory rejects it), so we
    // manually insert a cli_exec arm row into the registry.
    harness = makeHarness();
    const armId = nextTestArmId("attach-cli");
    harness.registry.putArm({
      arm_id: armId,
      mission_id: "mission-attach-cli",
      node_id: "test-node-m1-14",
      adapter_type: "cli_exec",
      runtime_name: "bash",
      agent_id: "agent-attach",
      task_ref: null,
      state: "active",
      current_grip_id: null,
      lease_owner: null,
      lease_expiry_ts: null,
      session_ref: { cwd: "/tmp" },
      checkpoint_ref: null,
      health_status: null,
      restart_count: 0,
      policy_profile: null,
      spec: makeArmSpec({
        adapter_type: "cli_exec",
        idempotency_key: "idem-attach-cli",
        runtime_options: { command: "echo", args: ["hi"] },
      }),
      created_at: Date.now(),
    });

    let thrown: unknown;
    try {
      await harness.handlers.armAttach({ arm_id: armId });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("not_supported");
  });

  it("attach for unknown arm returns not_found", async () => {
    harness = makeHarness();
    let thrown: unknown;
    try {
      await harness.handlers.armAttach({ arm_id: "arm-does-not-exist-attach" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("not_found");
  });
});

describe.skipIf(!TMUX_AVAILABLE)("OctoGatewayHandlers.armCheckpoint (M2-14)", () => {
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

  it("checkpoint on a live arm returns checkpoint metadata", async () => {
    const armId = nextTestArmId("chk-live");
    harness = makeHarness({ generateArmId: () => armId });
    await harness.handlers.armSpawn(makeSpawnRequest({ idempotency_key: "idem-chk-live" }));

    const response = await harness.handlers.armCheckpoint({
      idempotency_key: "idem-chk-live-call",
      arm_id: armId,
    });

    expect(response.arm_id).toBe(armId);
    expect(typeof response.ts).toBe("number");
    expect(typeof response.checkpoint_ref).toBe("string");
  });

  it("checkpoint on unknown arm returns not_found", async () => {
    harness = makeHarness();
    let thrown: unknown;
    try {
      await harness.handlers.armCheckpoint({
        idempotency_key: "idem-chk-notfound",
        arm_id: "arm-does-not-exist-chk",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("not_found");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// OctoGatewayHandlers.missionCreate tests (M3-01)
// ══════════════════════════════════════════════════════════════════════════

import type { MissionSpec } from "./schema.ts";

function makeMissionSpec(overrides: Partial<MissionSpec> = {}): MissionSpec {
  return {
    spec_version: 1,
    title: "Test Mission",
    owner: "test-owner",
    graph: [{ grip_id: "grip-A", depends_on: [] }],
    ...overrides,
  };
}

function makeMissionCreateRequest(
  specOverrides: Partial<MissionSpec> = {},
  envelopeOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    idempotency_key: "idem-mission-default",
    mission_spec: makeMissionSpec(specOverrides),
    ...envelopeOverrides,
  };
}

describe("OctoGatewayHandlers.missionCreate (M3-01)", () => {
  let missionHarness: Harness | null = null;
  let missionCounter = 0;

  function nextMissionId(tag: string): string {
    missionCounter += 1;
    return `mis-test-${tag}-${missionCounter}`;
  }

  function makeMissionHarness(opts: { generateMissionId?: () => string } = {}): Harness {
    const tempDir = mkdtempSync(path.join(tmpdir(), "octo-mission-create-test-"));
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
      nodeId: "test-node-m3-01",
      now: () => 1_700_000_000_000,
      generateMissionId: opts.generateMissionId,
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

  beforeEach(() => {
    missionHarness = null;
  });

  afterEach(() => {
    if (missionHarness !== null) {
      disposeHarness(missionHarness);
      missionHarness = null;
    }
  });

  it("mission create happy path: 3 grips (A -> B -> C), verifies mission row + grip rows + event", async () => {
    const missionId = nextMissionId("happy");
    missionHarness = makeMissionHarness({ generateMissionId: () => missionId });

    const request = makeMissionCreateRequest({
      graph: [
        { grip_id: "grip-A", depends_on: [] },
        { grip_id: "grip-B", depends_on: ["grip-A"] },
        { grip_id: "grip-C", depends_on: ["grip-B"] },
      ],
    });

    const response = await missionHarness.handlers.missionCreate(request);

    expect(response.mission_id).toBe(missionId);
    expect(response.grip_count).toBe(3);

    // Mission row exists with status "active".
    const mission = missionHarness.registry.getMission(missionId);
    expect(mission).not.toBeNull();
    expect(mission?.status).toBe("active");
    expect(mission?.title).toBe("Test Mission");
    expect(mission?.owner).toBe("test-owner");

    // 3 grip rows exist with status "queued".
    const grips = missionHarness.registry.listGrips({ mission_id: missionId });
    expect(grips.length).toBe(3);
    const gripIds = grips.map((g) => g.grip_id).toSorted();
    expect(gripIds).toEqual(["grip-A", "grip-B", "grip-C"]);
    for (const grip of grips) {
      expect(grip.status).toBe("queued");
    }

    // Event log has mission.created.
    const events = readEventLog(missionHarness.eventLogPath).filter(
      (e) => e.entity_id === missionId,
    );
    expect(events.length).toBe(1);
    expect(events[0]?.event_type).toBe("mission.created");
    expect(events[0]?.entity_type).toBe("mission");
  });

  it("mission create rejects invalid MissionSpec with cycle in graph", async () => {
    missionHarness = makeMissionHarness();

    const request = makeMissionCreateRequest({
      graph: [
        { grip_id: "grip-A", depends_on: ["grip-B"] },
        { grip_id: "grip-B", depends_on: ["grip-A"] },
      ],
    });

    let thrown: unknown;
    try {
      await missionHarness.handlers.missionCreate(request);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("invalid_spec");
    expect((thrown as HandlerError).message).toContain("cycle");
  });

  it("mission create rejects MissionSpec with duplicate grip_ids", async () => {
    missionHarness = makeMissionHarness();

    const request = makeMissionCreateRequest({
      graph: [
        { grip_id: "grip-A", depends_on: [] },
        { grip_id: "grip-A", depends_on: [] },
      ],
    });

    let thrown: unknown;
    try {
      await missionHarness.handlers.missionCreate(request);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("invalid_spec");
    expect((thrown as HandlerError).message).toContain("duplicate");
  });

  it("mission create rejects MissionSpec with unknown dep references", async () => {
    missionHarness = makeMissionHarness();

    const request = makeMissionCreateRequest({
      graph: [{ grip_id: "grip-A", depends_on: ["grip-Z"] }],
    });

    let thrown: unknown;
    try {
      await missionHarness.handlers.missionCreate(request);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("invalid_spec");
    expect((thrown as HandlerError).message).toContain("unknown");
  });

  it("mission create is idempotent on same idempotency_key", async () => {
    let callCount = 0;
    missionHarness = makeMissionHarness({
      generateMissionId: () => {
        callCount += 1;
        return `mis-idem-${callCount}`;
      },
    });

    const request = makeMissionCreateRequest(
      { graph: [{ grip_id: "grip-A", depends_on: [] }] },
      { idempotency_key: "idem-same-key" },
    );

    const first = await missionHarness.handlers.missionCreate(request);
    const second = await missionHarness.handlers.missionCreate(request);

    // Same mission_id returned both times.
    expect(second.mission_id).toBe(first.mission_id);
    expect(second.grip_count).toBe(1);

    // Only one mission in the registry.
    const missions = missionHarness.registry.listMissions();
    expect(missions.length).toBe(1);

    // Only one mission.created event.
    const events = readEventLog(missionHarness.eventLogPath).filter(
      (e) => e.event_type === "mission.created",
    );
    expect(events.length).toBe(1);
  });

  it("mission create with template_id returns structured error", async () => {
    missionHarness = makeMissionHarness();

    const request = {
      idempotency_key: "idem-template",
      template_id: "some-template",
    };

    let thrown: unknown;
    try {
      await missionHarness.handlers.missionCreate(request);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("not_supported");
    expect((thrown as HandlerError).message).toContain("templates not yet supported");
  });

  it("mission create rejects empty graph per MissionSpecSchema minItems constraint", async () => {
    missionHarness = makeMissionHarness();

    const request = makeMissionCreateRequest({
      graph: [] as never,
    });

    let thrown: unknown;
    try {
      await missionHarness.handlers.missionCreate(request);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("invalid_spec");
  });

  it("mission create rejects request missing both mission_spec and template_id", async () => {
    missionHarness = makeMissionHarness();

    const request = { idempotency_key: "idem-neither" };

    let thrown: unknown;
    try {
      await missionHarness.handlers.missionCreate(request);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("invalid_spec");
    expect((thrown as HandlerError).message).toContain("one of mission_spec or template_id");
  });

  it("mission create generates mis- prefixed mission_id", async () => {
    missionHarness = makeMissionHarness();

    const request = makeMissionCreateRequest({}, { idempotency_key: "idem-prefix-check" });

    const response = await missionHarness.handlers.missionCreate(request);
    expect(response.mission_id).toMatch(/^mis-/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// OctoGatewayHandlers.missionPause / missionResume / missionAbort (M3-02)
// ══════════════════════════════════════════════════════════════════════════

describe("OctoGatewayHandlers mission pause/resume/abort (M3-02)", () => {
  let m302Harness: Harness | null = null;
  let m302MissionCounter = 0;

  function nextM302MissionId(tag: string): string {
    m302MissionCounter += 1;
    return `mis-m302-${tag}-${m302MissionCounter}`;
  }

  function makeM302Harness(
    opts: { generateMissionId?: () => string; generateArmId?: () => string } = {},
  ): Harness {
    const tempDir = mkdtempSync(path.join(tmpdir(), "octo-mission-m302-test-"));
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
      nodeId: "test-node-m3-02",
      now: () => 1_700_000_000_000,
      generateMissionId: opts.generateMissionId,
      generateArmId: opts.generateArmId,
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

  /** Helper: create a mission in "active" state and return its id. */
  async function createActiveMission(
    h: Harness,
    missionId: string,
    idemKey: string,
  ): Promise<string> {
    const request = makeMissionCreateRequest(
      { graph: [{ grip_id: "grip-A", depends_on: [] }] },
      { idempotency_key: idemKey },
    );
    const response = await h.handlers.missionCreate(request);
    return response.mission_id;
  }

  beforeEach(() => {
    m302Harness = null;
  });

  afterEach(() => {
    if (m302Harness !== null) {
      disposeHarness(m302Harness);
      m302Harness = null;
    }
  });

  // ── Test 1: pause an active mission ────────────────────────────────────

  it("mission pause: active → paused, verifies state + event", async () => {
    const missionId = nextM302MissionId("pause");
    m302Harness = makeM302Harness({ generateMissionId: () => missionId });

    await createActiveMission(m302Harness, missionId, "idem-pause-1");

    const response = await m302Harness.handlers.missionPause({
      idempotency_key: "idem-pause-act",
      mission_id: missionId,
      reason: "maintenance window",
    });

    expect(response.mission_id).toBe(missionId);
    expect(response.status).toBe("paused");

    // Verify persisted state.
    const mission = m302Harness.registry.getMission(missionId);
    expect(mission).not.toBeNull();
    expect(mission?.status).toBe("paused");

    // Verify mission.paused event.
    const events = readEventLog(m302Harness.eventLogPath).filter(
      (e) => e.entity_id === missionId && e.event_type === "mission.paused",
    );
    expect(events.length).toBe(1);
    expect(events[0]?.payload?.reason).toBe("maintenance window");
  });

  // ── Test 2: resume a paused mission ────────────────────────────────────

  it("mission resume: paused → active, verifies state + event", async () => {
    const missionId = nextM302MissionId("resume");
    m302Harness = makeM302Harness({ generateMissionId: () => missionId });

    await createActiveMission(m302Harness, missionId, "idem-resume-1");

    // Pause first.
    await m302Harness.handlers.missionPause({
      idempotency_key: "idem-resume-p",
      mission_id: missionId,
    });

    // Resume.
    const response = await m302Harness.handlers.missionResume({
      idempotency_key: "idem-resume-r",
      mission_id: missionId,
    });

    expect(response.mission_id).toBe(missionId);
    expect(response.status).toBe("active");

    const mission = m302Harness.registry.getMission(missionId);
    expect(mission?.status).toBe("active");

    // Verify mission.resumed event.
    const events = readEventLog(m302Harness.eventLogPath).filter(
      (e) => e.entity_id === missionId && e.event_type === "mission.resumed",
    );
    expect(events.length).toBe(1);
  });

  // ── Test 3: abort active mission with 2 active arms ────────────────────

  it("mission abort: active mission with 2 arms, cascades termination", async () => {
    const missionId = nextM302MissionId("abort-arms");
    m302Harness = makeM302Harness({ generateMissionId: () => missionId });

    await createActiveMission(m302Harness, missionId, "idem-abort-arms-1");

    // Insert 2 arm rows directly in "active" state with session_ref.
    const armSpec = makeArmSpec({
      mission_id: missionId,
      idempotency_key: "arm-abort-spec-1",
    });
    for (const armId of ["arm-abort-1", "arm-abort-2"]) {
      m302Harness.registry.putArm({
        arm_id: armId,
        mission_id: missionId,
        node_id: "test-node-m3-02",
        adapter_type: "pty_tmux",
        runtime_name: "bash",
        agent_id: "agent-m3-02",
        task_ref: null,
        state: "active",
        current_grip_id: null,
        lease_owner: null,
        lease_expiry_ts: null,
        session_ref: { cwd: "/tmp", tmux_session_name: `octo-arm-${armId}` },
        checkpoint_ref: null,
        health_status: "active",
        restart_count: 0,
        policy_profile: null,
        spec: { ...armSpec, idempotency_key: `arm-abort-spec-${armId}` },
        created_at: 1_700_000_000_000,
      });
    }

    const response = await m302Harness.handlers.missionAbort({
      idempotency_key: "idem-abort-arms-act",
      mission_id: missionId,
      reason: "operator cancelled",
    });

    expect(response.mission_id).toBe(missionId);
    expect(response.status).toBe("aborted");
    expect(response.arms_terminated).toBe(2);

    // Verify mission row is aborted.
    const mission = m302Harness.registry.getMission(missionId);
    expect(mission?.status).toBe("aborted");

    // Verify mission.aborted event.
    const events = readEventLog(m302Harness.eventLogPath).filter(
      (e) => e.entity_id === missionId && e.event_type === "mission.aborted",
    );
    expect(events.length).toBe(1);
    expect(events[0]?.payload?.reason).toBe("operator cancelled");
    expect(events[0]?.payload?.arms_terminated).toBe(2);
  });

  // ── Test 4: abort a paused mission ─────────────────────────────────────

  it("mission abort: paused mission → aborted", async () => {
    const missionId = nextM302MissionId("abort-paused");
    m302Harness = makeM302Harness({ generateMissionId: () => missionId });

    await createActiveMission(m302Harness, missionId, "idem-abort-paused-1");

    // Pause first.
    await m302Harness.handlers.missionPause({
      idempotency_key: "idem-abort-paused-p",
      mission_id: missionId,
    });

    // Abort the paused mission.
    const response = await m302Harness.handlers.missionAbort({
      idempotency_key: "idem-abort-paused-a",
      mission_id: missionId,
      reason: "deadline passed",
    });

    expect(response.mission_id).toBe(missionId);
    expect(response.status).toBe("aborted");

    const mission = m302Harness.registry.getMission(missionId);
    expect(mission?.status).toBe("aborted");
  });

  // ── Test 5: pause already-paused mission → error ───────────────────────

  it("mission pause rejects already-paused mission with invalid_state", async () => {
    const missionId = nextM302MissionId("pause-twice");
    m302Harness = makeM302Harness({ generateMissionId: () => missionId });

    await createActiveMission(m302Harness, missionId, "idem-pause-twice-1");

    // First pause succeeds.
    await m302Harness.handlers.missionPause({
      idempotency_key: "idem-pause-twice-p1",
      mission_id: missionId,
    });

    // Second pause fails.
    let thrown: unknown;
    try {
      await m302Harness.handlers.missionPause({
        idempotency_key: "idem-pause-twice-p2",
        mission_id: missionId,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("invalid_state");
    expect((thrown as HandlerError).message).toContain("paused");
  });

  // ── Test 6: resume non-paused mission → error ─────────────────────────

  it("mission resume rejects non-paused mission with invalid_state", async () => {
    const missionId = nextM302MissionId("resume-active");
    m302Harness = makeM302Harness({ generateMissionId: () => missionId });

    await createActiveMission(m302Harness, missionId, "idem-resume-active-1");

    // Try to resume an active mission.
    let thrown: unknown;
    try {
      await m302Harness.handlers.missionResume({
        idempotency_key: "idem-resume-active-r",
        mission_id: missionId,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("invalid_state");
    expect((thrown as HandlerError).message).toContain("active");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// M4-02: leaseRenew tests
// ══════════════════════════════════════════════════════════════════════════

describe("OctoGatewayHandlers.leaseRenew (M4-02)", () => {
  interface LeaseHarness {
    tempDir: string;
    registry: RegistryService;
    eventLog: EventLogService;
    tmuxManager: TmuxManager;
    leaseService: LeaseService;
    handlers: OctoGatewayHandlers;
    eventLogPath: string;
    closeDb: () => void;
    db: ReturnType<typeof openOctoRegistry>;
  }

  let leaseHarness: LeaseHarness | null = null;

  const LEASE_CONFIG = { renewIntervalS: 10, ttlS: 30, graceS: 5, sideEffectingGraceS: 15 };
  let leaseArmCounter = 0;

  function nextLeaseArmId(tag: string): string {
    leaseArmCounter += 1;
    return `arm-${RUN_PREFIX}-lease-${tag}-${leaseArmCounter}`;
  }

  function makeLeaseHarness(): LeaseHarness {
    const tempDir = mkdtempSync(path.join(tmpdir(), "octo-lease-renew-test-"));
    const dbPath = path.join(tempDir, "registry.sqlite");
    const eventLogPath = path.join(tempDir, "events.jsonl");
    const db = openOctoRegistry({ path: dbPath });
    const registry = new RegistryService(db);
    const eventLog = new EventLogService({ path: eventLogPath });
    const tmuxManager = new TmuxManager();
    const leaseService = new LeaseService(db, eventLog, LEASE_CONFIG);

    const deps: OctoGatewayHandlerDeps = {
      registry,
      eventLog,
      tmuxManager,
      leaseService,
      nodeId: "test-node-m4-02",
      now: () => 1_700_000_000_000,
    };
    const handlers = new OctoGatewayHandlers(deps);

    return {
      tempDir,
      registry,
      eventLog,
      tmuxManager,
      leaseService,
      handlers,
      eventLogPath,
      closeDb: () => {
        try {
          closeOctoRegistry(db);
        } catch {
          // already closed
        }
      },
      db,
    };
  }

  function disposeLeaseHarness(h: LeaseHarness | null): void {
    if (h === null) {
      return;
    }
    h.closeDb();
    try {
      rmSync(h.tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  /** Insert an arm row and issue a lease for it. */
  async function seedArmWithLease(h: LeaseHarness, armId: string): Promise<void> {
    h.registry.putArm({
      arm_id: armId,
      mission_id: "mission-lease-test",
      node_id: "test-node-m4-02",
      adapter_type: "pty_tmux",
      runtime_name: "bash",
      agent_id: "agent-lease",
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
      spec: {
        spec_version: 1,
        mission_id: "mission-lease-test",
        adapter_type: "pty_tmux",
        runtime_name: "bash",
        agent_id: "agent-lease",
        cwd: "/tmp",
        idempotency_key: `idem-${armId}`,
        runtime_options: { command: "sleep", args: ["60"] },
      },
      created_at: 1_700_000_000_000,
    });
    await h.leaseService.issue(armId, "test-node-m4-02");
  }

  afterEach(() => {
    disposeLeaseHarness(leaseHarness);
    leaseHarness = null;
  });

  // ── Test 1: batch of 3 renewals ──────────────────────────────────────

  it("renews a batch of 3 leases successfully", async () => {
    leaseHarness = makeLeaseHarness();
    const arm1 = nextLeaseArmId("batch-1");
    const arm2 = nextLeaseArmId("batch-2");
    const arm3 = nextLeaseArmId("batch-3");

    await seedArmWithLease(leaseHarness, arm1);
    await seedArmWithLease(leaseHarness, arm2);
    await seedArmWithLease(leaseHarness, arm3);

    const result: LeaseRenewResult = await leaseHarness.handlers.leaseRenew({
      node_id: "test-node-m4-02",
      ts: new Date().toISOString(),
      leases: [
        { arm_id: arm1, lease_expiry_ts: new Date(Date.now() + 30_000).toISOString() },
        { arm_id: arm2, lease_expiry_ts: new Date(Date.now() + 30_000).toISOString() },
        { arm_id: arm3, lease_expiry_ts: new Date(Date.now() + 30_000).toISOString() },
      ],
    });

    expect(result.node_id).toBe("test-node-m4-02");
    expect(result.results).toHaveLength(3);
    for (const entry of result.results) {
      expect(entry.renewed).toBe(true);
      expect(entry.error).toBeUndefined();
    }

    // Verify lease.renewed events were emitted (one per renewal from LeaseService).
    const events = readEventLog(leaseHarness.eventLogPath);
    const renewedEvents = events.filter((e) => e.event_type === "lease.renewed");
    expect(renewedEvents.length).toBeGreaterThanOrEqual(3);
  });

  // ── Test 2: unknown arm rejected ─────────────────────────────────────

  it("rejects renewal for unknown arm without blocking other entries", async () => {
    leaseHarness = makeLeaseHarness();
    const knownArm = nextLeaseArmId("known");
    await seedArmWithLease(leaseHarness, knownArm);

    const result = await leaseHarness.handlers.leaseRenew({
      node_id: "test-node-m4-02",
      ts: new Date().toISOString(),
      leases: [
        { arm_id: knownArm, lease_expiry_ts: new Date(Date.now() + 30_000).toISOString() },
        {
          arm_id: "arm-does-not-exist",
          lease_expiry_ts: new Date(Date.now() + 30_000).toISOString(),
        },
      ],
    });

    expect(result.results).toHaveLength(2);
    const knownResult = result.results.find((r) => r.arm_id === knownArm);
    const unknownResult = result.results.find((r) => r.arm_id === "arm-does-not-exist");

    expect(knownResult?.renewed).toBe(true);
    expect(unknownResult?.renewed).toBe(false);
    expect(unknownResult?.error).toContain("unknown arm");
  });

  // ── Test 3: expired lease rejected ───────────────────────────────────

  it("rejects renewal for expired lease (no lease row)", async () => {
    leaseHarness = makeLeaseHarness();
    const armId = nextLeaseArmId("expired");

    // Insert arm row but do NOT issue a lease.
    leaseHarness.registry.putArm({
      arm_id: armId,
      mission_id: "mission-lease-test",
      node_id: "test-node-m4-02",
      adapter_type: "pty_tmux",
      runtime_name: "bash",
      agent_id: "agent-lease",
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
      spec: {
        spec_version: 1,
        mission_id: "mission-lease-test",
        adapter_type: "pty_tmux",
        runtime_name: "bash",
        agent_id: "agent-lease",
        cwd: "/tmp",
        idempotency_key: `idem-${armId}`,
        runtime_options: { command: "sleep", args: ["60"] },
      },
      created_at: 1_700_000_000_000,
    });

    const result = await leaseHarness.handlers.leaseRenew({
      node_id: "test-node-m4-02",
      ts: new Date().toISOString(),
      leases: [{ arm_id: armId, lease_expiry_ts: new Date(Date.now() + 30_000).toISOString() }],
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].renewed).toBe(false);
    expect(result.results[0].error).toContain("no lease found");
  });

  // ── Test 4: invalid push envelope rejected ───────────────────────────

  it("rejects invalid push envelope with invalid_spec", async () => {
    leaseHarness = makeLeaseHarness();

    let thrown: unknown;
    try {
      await leaseHarness.handlers.leaseRenew({
        // Missing node_id and ts.
        leases: [],
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("invalid_spec");
  });

  // ── Test 5: leaseService not configured → internal error ─────────────

  it("throws internal error when leaseService is not configured", async () => {
    // Use the standard makeHarness which does NOT inject leaseService.
    const h = makeHarness();
    let thrown: unknown;
    try {
      await h.handlers.leaseRenew({
        node_id: "test-node",
        ts: new Date().toISOString(),
        leases: [{ arm_id: "arm-1", lease_expiry_ts: new Date().toISOString() }],
      });
    } catch (err) {
      thrown = err;
    } finally {
      h.closeDb();
      try {
        rmSync(h.tempDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }

    expect(thrown).toBeInstanceOf(HandlerError);
    expect((thrown as HandlerError).code).toBe("internal");
    expect((thrown as HandlerError).message).toContain("leaseService not configured");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Policy enforcement in arm.spawn (M5-02)
// ══════════════════════════════════════════════════════════════════════════

describe.skipIf(!TMUX_AVAILABLE)("OctoGatewayHandlers — policy enforcement (M5-02)", () => {
  afterEach(async () => {
    disposeHarness(harness);
    harness = null;
    await sweepRunSessions();
  });

  afterAll(async () => {
    await sweepRunSessions();
  });

  it("rejects arm.spawn with policy_denied when policy returns deny", async () => {
    const armId = nextTestArmId("policy-deny");
    const denyPolicy = {
      resolve: () => ({ name: "__test__", allowedTools: [], deniedTools: [] }),
      check: () => ({
        decision: "deny" as const,
        reason: "too many arms",
        ruleId: "max-arms-per-mission",
      }),
    } as unknown as PolicyService;
    harness = makeHarness({ generateArmId: () => armId, policyService: denyPolicy });
    const request = makeSpawnRequest({
      idempotency_key: "idem-policy-deny",
      policy_profile_ref: "strict-refactor",
    });

    let thrown: unknown;
    try {
      await harness.handlers.armSpawn(request);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HandlerError);
    const he = thrown as HandlerError;
    expect(he.code).toBe("policy_denied");
    expect(he.message).toContain("too many arms");
    expect(he.details?.ruleId).toBe("max-arms-per-mission");
    expect(he.details?.reason).toBe("too many arms");

    // No arm row should exist — spawn was blocked before insert.
    const row = harness.registry.getArm(armId);
    expect(row).toBeNull();
  });

  it("rejects arm.spawn with policy_escalated when policy returns escalate", async () => {
    const armId = nextTestArmId("policy-escalate");
    const escalatePolicy = {
      resolve: () => ({ name: "__test__", allowedTools: [], deniedTools: [] }),
      check: () => ({
        decision: "escalate" as const,
        reason: "requires approval",
      }),
    } as unknown as PolicyService;
    harness = makeHarness({ generateArmId: () => armId, policyService: escalatePolicy });
    const request = makeSpawnRequest({ idempotency_key: "idem-policy-escalate" });

    let thrown: unknown;
    try {
      await harness.handlers.armSpawn(request);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HandlerError);
    const he = thrown as HandlerError;
    expect(he.code).toBe("policy_escalated");
    expect(he.message).toContain("requires escalation");
    expect(he.details?.reason).toBe("requires approval");
  });

  it("allows arm.spawn to proceed when policy returns allow", async () => {
    const armId = nextTestArmId("policy-allow");
    const allowPolicy = {
      resolve: () => ({ name: "__test__", allowedTools: [], deniedTools: [] }),
      check: () => ({ decision: "allow" as const }),
    } as unknown as PolicyService;
    harness = makeHarness({ generateArmId: () => armId, policyService: allowPolicy });
    const request = makeSpawnRequest({ idempotency_key: "idem-policy-allow" });

    const response = await harness.handlers.armSpawn(request);

    expect(response.arm_id).toBe(armId);
    expect(response.session_ref).toBeDefined();
    expect(response.session_ref.cwd).toBe("/tmp");
  });

  it("logs every policy decision to the event log", async () => {
    const armId = nextTestArmId("policy-log");
    const denyPolicy = {
      resolve: () => ({ name: "__test__", allowedTools: [], deniedTools: [] }),
      check: () => ({
        decision: "deny" as const,
        reason: "blocked by rule",
        ruleId: "rule-42",
      }),
    } as unknown as PolicyService;
    harness = makeHarness({ generateArmId: () => armId, policyService: denyPolicy });
    const request = makeSpawnRequest({
      idempotency_key: "idem-policy-log",
      policy_profile_ref: "strict-refactor",
    });

    try {
      await harness.handlers.armSpawn(request);
    } catch {
      // expected
    }

    const events = readEventLog(harness.eventLogPath);
    const policyEvents = events.filter((e) => e.event_type === "policy.decision");
    expect(policyEvents).toHaveLength(1);

    const evt = policyEvents[0];
    expect(evt.entity_type).toBe("policy");
    expect(evt.entity_id).toBe("arm.spawn");
    expect(evt.payload.action).toBe("arm.spawn");
    expect(evt.payload.verdict).toBe("deny");
    expect(evt.payload.reason).toBe("blocked by rule");
    expect(evt.payload.rule_id).toBe("rule-42");
    expect(evt.payload.profile).toBe("__test__");
  });

  it("skips policy check when policyService is not provided (backward compat)", async () => {
    const armId = nextTestArmId("no-policy");
    // No policyService in harness opts — backward compat path.
    harness = makeHarness({ generateArmId: () => armId });
    const request = makeSpawnRequest({ idempotency_key: "idem-no-policy" });

    const response = await harness.handlers.armSpawn(request);

    expect(response.arm_id).toBe(armId);
    expect(response.session_ref).toBeDefined();

    // Confirm no policy decision events were emitted.
    const events = readEventLog(harness.eventLogPath);
    const policyEvents = events.filter((e) => e.event_type === "policy.decision");
    expect(policyEvents).toHaveLength(0);
  });
});
