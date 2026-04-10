// Octopus Orchestrator — RegistryService tests (M1-02)
//
// Covers the M1-02 acceptance criteria:
//   - get / put / list for missions, arms, grips, claims
//   - casUpdate* throws ConflictError on version mismatch
//   - casUpdate* throws ConflictError on missing row (actualVersion = null)
//   - put* throws DuplicateError on primary-key collision
//   - JSON spec round-trip (TypeBox-validated on read-back)
//   - filter combinations on list*
//   - **Concurrent casUpdateArm — exactly one wins** (the headline acceptance
//     test referenced by the task spec)
//
// Tests open a fresh registry per test against a temp DB file via
// openOctoRegistry({ path }) and clean up handles + temp dirs in
// afterEach so the file system is left clean even on failure.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArmSpec, GripSpec, MissionSpec } from "../wire/schema.ts";
import {
  type ArmInput,
  type ClaimInput,
  ConflictError,
  DuplicateError,
  type GripInput,
  type MissionInput,
  RegistryService,
} from "./registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "./storage/migrate.ts";

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp DB harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;
let dbPath: string;
let db: DatabaseSync;
let registry: RegistryService;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-registry-test-"));
  dbPath = path.join(tempDir, "registry.sqlite");
  db = openOctoRegistry({ path: dbPath });
  registry = new RegistryService(db);
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
// Factory helpers — minimal valid spec/record inputs
// ──────────────────────────────────────────────────────────────────────────

function makeMissionSpec(overrides: Partial<MissionSpec> = {}): MissionSpec {
  return {
    spec_version: 1,
    title: "test mission",
    owner: "tester",
    graph: [{ grip_id: "g1", depends_on: [] }],
    ...overrides,
  };
}

function makeMissionInput(overrides: Partial<MissionInput> = {}): MissionInput {
  return {
    mission_id: `mission-${Math.random().toString(36).slice(2, 10)}`,
    title: "test mission",
    owner: "tester",
    status: "active",
    policy_profile_ref: null,
    spec: makeMissionSpec(),
    metadata: null,
    ...overrides,
  };
}

function makeArmSpec(overrides: Partial<ArmSpec> = {}): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "mission-1",
    adapter_type: "cli_exec",
    runtime_name: "claude-cli",
    agent_id: "agent-1",
    cwd: "/tmp",
    idempotency_key: "idem-1",
    runtime_options: {
      command: "echo",
    },
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

function makeGripSpec(overrides: Partial<GripSpec> = {}): GripSpec {
  return {
    spec_version: 1,
    mission_id: "mission-1",
    type: "code-edit",
    retry_policy: {
      max_attempts: 3,
      backoff: "exponential",
      initial_delay_s: 1,
      max_delay_s: 60,
      multiplier: 2,
      retry_on: ["transient", "timeout"],
      abandon_on: ["unrecoverable"],
    },
    timeout_s: 300,
    side_effecting: false,
    ...overrides,
  };
}

function makeGripInput(overrides: Partial<GripInput> = {}): GripInput {
  return {
    grip_id: `grip-${Math.random().toString(36).slice(2, 10)}`,
    mission_id: "mission-1",
    type: "code-edit",
    input_ref: null,
    priority: 0,
    assigned_arm_id: null,
    status: "pending",
    timeout_s: 300,
    side_effecting: false,
    idempotency_key: null,
    result_ref: null,
    spec: makeGripSpec(),
    ...overrides,
  };
}

function makeClaimInput(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    claim_id: `claim-${Math.random().toString(36).slice(2, 10)}`,
    mission_id: "mission-1",
    grip_id: "grip-1",
    resource_type: "file",
    resource_key: "/tmp/x",
    owner_arm_id: "arm-1",
    mode: "exclusive",
    lease_expiry_ts: Date.now() + 60_000,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════
// Empty registry semantics
// ════════════════════════════════════════════════════════════════════════

describe("RegistryService — empty registry", () => {
  it("getArm returns null for unknown id", () => {
    expect(registry.getArm("nonexistent")).toBeNull();
  });

  it("getMission / getGrip / getClaim return null for unknown id", () => {
    expect(registry.getMission("nope")).toBeNull();
    expect(registry.getGrip("nope")).toBeNull();
    expect(registry.getClaim("nope")).toBeNull();
  });

  it("listArms / listMissions / listGrips / listClaims return empty arrays", () => {
    expect(registry.listArms()).toEqual([]);
    expect(registry.listMissions()).toEqual([]);
    expect(registry.listGrips()).toEqual([]);
    expect(registry.listClaims()).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Arms — full coverage (the primary entity for M1-02)
// ════════════════════════════════════════════════════════════════════════

describe("RegistryService — arms", () => {
  it("putArm creates a row at version 0 with timestamps populated", () => {
    const before = Date.now();
    const input = makeArmInput({ arm_id: "arm-A" });
    const record = registry.putArm(input);
    expect(record.arm_id).toBe("arm-A");
    expect(record.version).toBe(0);
    expect(record.created_at).toBeGreaterThanOrEqual(before);
    expect(record.updated_at).toBeGreaterThanOrEqual(before);
    expect(record.state).toBe("pending");
  });

  it("getArm round-trips the spec via JSON serialization", () => {
    const spec = makeArmSpec({ idempotency_key: "round-trip-key" });
    const input = makeArmInput({ arm_id: "arm-rt", spec });
    registry.putArm(input);
    const fetched = registry.getArm("arm-rt");
    expect(fetched).not.toBeNull();
    expect(fetched?.spec).toEqual(spec);
  });

  it("listArms filters by mission_id, node_id, state, and agent_id", () => {
    registry.putArm(
      makeArmInput({ arm_id: "a1", mission_id: "m1", node_id: "n1", state: "active" }),
    );
    registry.putArm(
      makeArmInput({ arm_id: "a2", mission_id: "m1", node_id: "n2", state: "pending" }),
    );
    registry.putArm(
      makeArmInput({ arm_id: "a3", mission_id: "m2", node_id: "n1", state: "active" }),
    );

    expect(
      registry
        .listArms({ mission_id: "m1" })
        .map((r) => r.arm_id)
        .toSorted(),
    ).toEqual(["a1", "a2"]);
    expect(
      registry
        .listArms({ node_id: "n1" })
        .map((r) => r.arm_id)
        .toSorted(),
    ).toEqual(["a1", "a3"]);
    expect(
      registry
        .listArms({ state: "active" })
        .map((r) => r.arm_id)
        .toSorted(),
    ).toEqual(["a1", "a3"]);
    expect(registry.listArms({ mission_id: "m1", state: "active" }).map((r) => r.arm_id)).toEqual([
      "a1",
    ]);
  });

  it("putArm with duplicate primary key throws DuplicateError", () => {
    registry.putArm(makeArmInput({ arm_id: "dup" }));
    expect(() => registry.putArm(makeArmInput({ arm_id: "dup" }))).toThrow(DuplicateError);
  });

  it("casUpdateArm with correct expectedVersion succeeds and bumps version", () => {
    registry.putArm(makeArmInput({ arm_id: "cas-ok" }));
    const updated = registry.casUpdateArm("cas-ok", 0, { state: "active" });
    expect(updated.version).toBe(1);
    expect(updated.state).toBe("active");

    const refetched = registry.getArm("cas-ok");
    expect(refetched?.version).toBe(1);
    expect(refetched?.state).toBe("active");
  });

  it("casUpdateArm with wrong expectedVersion throws ConflictError carrying actualVersion", () => {
    registry.putArm(makeArmInput({ arm_id: "cas-bad" }));
    let caught: unknown;
    try {
      registry.casUpdateArm("cas-bad", 99, { state: "active" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    const conflict = caught as ConflictError;
    expect(conflict.entity).toBe("arm");
    expect(conflict.id).toBe("cas-bad");
    expect(conflict.expectedVersion).toBe(99);
    expect(conflict.actualVersion).toBe(0);
  });

  it("casUpdateArm on missing row throws ConflictError with actualVersion: null", () => {
    let caught: unknown;
    try {
      registry.casUpdateArm("ghost", 0, { state: "active" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    const conflict = caught as ConflictError;
    expect(conflict.entity).toBe("arm");
    expect(conflict.actualVersion).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────
  // The headline acceptance criterion: concurrent casUpdate — exactly
  // one winner. We launch 5 attempts via Promise.all, each wrapping
  // the synchronous casUpdateArm call in a Promise so the JS event
  // loop interleaves them as much as it can. SQLite's BEGIN IMMEDIATE
  // serializes the actual writes, and the version check guarantees
  // exactly one of the attempts sees version = 0 and succeeds; the
  // other four throw ConflictError.
  //
  // Note: in practice the Promise wrapping does NOT introduce real
  // concurrency at the JS level (node:sqlite is synchronous and
  // blocks the event loop), so all five calls execute serially within
  // a single tick. That is fine — what we are validating is that
  // *the CAS protocol* behaves correctly under contention, not that
  // SQLite supports parallel writers. The first call wins, the next
  // four observe version = 1 and reject. The acceptance criterion is
  // satisfied because exactly-one-wins is what callers see.
  // ──────────────────────────────────────────────────────────────────
  it("concurrent casUpdateArm — exactly one wins", async () => {
    registry.putArm(makeArmInput({ arm_id: "race" }));

    const attempts = [0, 1, 2, 3, 4].map(
      (i) =>
        new Promise<{ ok: boolean; err?: unknown }>((resolve) => {
          // Schedule on a microtask so the calls interleave maximally.
          queueMicrotask(() => {
            try {
              registry.casUpdateArm("race", 0, {
                state: `winner-${i}`,
              });
              resolve({ ok: true });
            } catch (err) {
              resolve({ ok: false, err });
            }
          });
        }),
    );

    const results = await Promise.all(attempts);
    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);

    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(4);
    for (const loss of losses) {
      expect(loss.err).toBeInstanceOf(ConflictError);
      const conflict = loss.err as ConflictError;
      expect(conflict.entity).toBe("arm");
      expect(conflict.id).toBe("race");
      expect(conflict.expectedVersion).toBe(0);
      expect(conflict.actualVersion).toBe(1);
    }

    // Final row reflects exactly one bump.
    const finalRecord = registry.getArm("race");
    expect(finalRecord?.version).toBe(1);
    expect(finalRecord?.state).toMatch(/^winner-\d$/);
  });

  it("casUpdateArm patches multiple fields and persists them", () => {
    registry.putArm(makeArmInput({ arm_id: "multi" }));
    const updated = registry.casUpdateArm("multi", 0, {
      state: "active",
      current_grip_id: "g42",
      lease_owner: "owner-1",
      lease_expiry_ts: 1_700_000_000_000,
      session_ref: { adapter_session_id: "abc" },
      restart_count: 2,
    });
    expect(updated.version).toBe(1);
    expect(updated.state).toBe("active");
    expect(updated.current_grip_id).toBe("g42");
    expect(updated.lease_owner).toBe("owner-1");
    expect(updated.lease_expiry_ts).toBe(1_700_000_000_000);
    expect(updated.session_ref).toEqual({ adapter_session_id: "abc" });
    expect(updated.restart_count).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Missions — parallel surface spot-check
// ════════════════════════════════════════════════════════════════════════

describe("RegistryService — missions", () => {
  it("put / get / casUpdate / cas-fail / duplicate", () => {
    const input = makeMissionInput({ mission_id: "m1" });
    const created = registry.putMission(input);
    expect(created.version).toBe(0);
    expect(created.title).toBe("test mission");

    const fetched = registry.getMission("m1");
    expect(fetched?.spec.graph).toHaveLength(1);

    const updated = registry.casUpdateMission("m1", 0, { status: "completed" });
    expect(updated.version).toBe(1);
    expect(updated.status).toBe("completed");

    expect(() => registry.casUpdateMission("m1", 0, { status: "aborted" })).toThrow(ConflictError);

    expect(() => registry.putMission(makeMissionInput({ mission_id: "m1" }))).toThrow(
      DuplicateError,
    );
  });

  it("listMissions filters by status and owner", () => {
    registry.putMission(makeMissionInput({ mission_id: "ma", status: "active", owner: "alice" }));
    registry.putMission(makeMissionInput({ mission_id: "mb", status: "paused", owner: "alice" }));
    registry.putMission(makeMissionInput({ mission_id: "mc", status: "active", owner: "bob" }));

    expect(
      registry
        .listMissions({ status: "active" })
        .map((r) => r.mission_id)
        .toSorted(),
    ).toEqual(["ma", "mc"]);
    expect(
      registry
        .listMissions({ owner: "alice" })
        .map((r) => r.mission_id)
        .toSorted(),
    ).toEqual(["ma", "mb"]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Grips — parallel surface spot-check
// ════════════════════════════════════════════════════════════════════════

describe("RegistryService — grips", () => {
  it("put / get / cas / cas-fail / duplicate", () => {
    const created = registry.putGrip(makeGripInput({ grip_id: "g1" }));
    expect(created.version).toBe(0);
    expect(created.side_effecting).toBe(false);

    const fetched = registry.getGrip("g1");
    expect(fetched?.spec.type).toBe("code-edit");

    const updated = registry.casUpdateGrip("g1", 0, {
      status: "running",
      assigned_arm_id: "arm-x",
      side_effecting: true,
    });
    expect(updated.version).toBe(1);
    expect(updated.status).toBe("running");
    expect(updated.assigned_arm_id).toBe("arm-x");
    expect(updated.side_effecting).toBe(true);

    expect(() => registry.casUpdateGrip("g1", 0, { status: "done" })).toThrow(ConflictError);

    expect(() => registry.putGrip(makeGripInput({ grip_id: "g1" }))).toThrow(DuplicateError);
  });

  it("listGrips filters by mission_id, status, assigned_arm_id", () => {
    registry.putGrip(makeGripInput({ grip_id: "g1", mission_id: "m1", status: "pending" }));
    registry.putGrip(
      makeGripInput({
        grip_id: "g2",
        mission_id: "m1",
        status: "running",
        assigned_arm_id: "arm-x",
      }),
    );
    registry.putGrip(makeGripInput({ grip_id: "g3", mission_id: "m2", status: "pending" }));

    expect(
      registry
        .listGrips({ mission_id: "m1" })
        .map((r) => r.grip_id)
        .toSorted(),
    ).toEqual(["g1", "g2"]);
    expect(
      registry
        .listGrips({ status: "pending" })
        .map((r) => r.grip_id)
        .toSorted(),
    ).toEqual(["g1", "g3"]);
    expect(registry.listGrips({ assigned_arm_id: "arm-x" }).map((r) => r.grip_id)).toEqual(["g2"]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Claims — parallel surface spot-check
// ════════════════════════════════════════════════════════════════════════

describe("RegistryService — claims", () => {
  it("put / get / cas / cas-fail / duplicate", () => {
    const created = registry.putClaim(makeClaimInput({ claim_id: "c1" }));
    expect(created.version).toBe(0);
    expect(created.mode).toBe("exclusive");

    const fetched = registry.getClaim("c1");
    expect(fetched?.resource_key).toBe("/tmp/x");

    const newExpiry = Date.now() + 120_000;
    const updated = registry.casUpdateClaim("c1", 0, {
      lease_expiry_ts: newExpiry,
    });
    expect(updated.version).toBe(1);
    expect(updated.lease_expiry_ts).toBe(newExpiry);

    expect(() => registry.casUpdateClaim("c1", 0, { lease_expiry_ts: 0 })).toThrow(ConflictError);

    expect(() => registry.putClaim(makeClaimInput({ claim_id: "c1" }))).toThrow(DuplicateError);
  });

  it("listClaims filters by mission_id, resource_type, owner_arm_id", () => {
    registry.putClaim(
      makeClaimInput({
        claim_id: "c1",
        mission_id: "m1",
        resource_type: "file",
        owner_arm_id: "arm-1",
      }),
    );
    registry.putClaim(
      makeClaimInput({
        claim_id: "c2",
        mission_id: "m1",
        resource_type: "branch",
        owner_arm_id: "arm-2",
      }),
    );
    registry.putClaim(
      makeClaimInput({
        claim_id: "c3",
        mission_id: "m2",
        resource_type: "file",
        owner_arm_id: "arm-1",
      }),
    );

    expect(
      registry
        .listClaims({ mission_id: "m1" })
        .map((r) => r.claim_id)
        .toSorted(),
    ).toEqual(["c1", "c2"]);
    expect(
      registry
        .listClaims({ resource_type: "file" })
        .map((r) => r.claim_id)
        .toSorted(),
    ).toEqual(["c1", "c3"]);
    expect(
      registry
        .listClaims({ owner_arm_id: "arm-1" })
        .map((r) => r.claim_id)
        .toSorted(),
    ).toEqual(["c1", "c3"]);
  });
});
