// Octopus Orchestrator -- GripLifecycleService tests (M3-04)
//
// Covers: startGrip (queued->assigned->running), completeGrip
// (running->completed + result_ref + wakeGripIds), failGrip
// (running->failed + blocks_mission_on_failure), invalid transitions.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GripSpec, MissionSpec } from "../wire/schema.ts";
import { EventLogService } from "./event-log.ts";
import { InvalidTransitionError } from "./grip-fsm.ts";
import { GripLifecycleService, GripNotFoundError } from "./grip-lifecycle.ts";
import { RegistryService, type GripInput, type MissionInput } from "./registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "./storage/migrate.ts";

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp DB + event log harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;
let db: DatabaseSync;
let registry: RegistryService;
let eventLog: EventLogService;
let lifecycle: GripLifecycleService;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-grip-lifecycle-test-"));
  const dbPath = path.join(tempDir, "registry.sqlite");
  db = openOctoRegistry({ path: dbPath });
  registry = new RegistryService(db);
  eventLog = new EventLogService({ path: path.join(tempDir, "events.jsonl") });
  lifecycle = new GripLifecycleService(registry, eventLog);
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
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

function makeGripSpec(overrides: Partial<GripSpec> = {}): GripSpec {
  return {
    spec_version: 1,
    mission_id: "m1",
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
    grip_id: "g1",
    mission_id: "m1",
    type: "code-edit",
    input_ref: null,
    priority: 0,
    assigned_arm_id: null,
    status: "queued",
    timeout_s: 300,
    side_effecting: false,
    idempotency_key: null,
    result_ref: null,
    spec: makeGripSpec(),
    ...overrides,
  };
}

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
    mission_id: "m1",
    title: "test mission",
    owner: "tester",
    status: "active",
    policy_profile_ref: null,
    spec: makeMissionSpec(),
    metadata: null,
    ...overrides,
  };
}

/** Create a mission and grip in the registry, return the grip. */
function seedGrip(
  gripOverrides: Partial<GripInput> = {},
  missionOverrides: Partial<MissionInput> = {},
): void {
  const gripId = gripOverrides.grip_id ?? "g1";
  const missionId = gripOverrides.mission_id ?? missionOverrides.mission_id ?? "m1";

  // Build graph including this grip
  const existingGraph = missionOverrides.spec?.graph ?? [];
  const graphHasGrip = existingGraph.some((n) => n.grip_id === gripId);
  const graph = graphHasGrip
    ? existingGraph
    : [...existingGraph, { grip_id: gripId, depends_on: [] as string[] }];

  const missionSpec = makeMissionSpec({ ...missionOverrides.spec, graph });

  // Only create mission if it does not already exist
  if (!registry.getMission(missionId)) {
    registry.putMission(
      makeMissionInput({
        mission_id: missionId,
        ...missionOverrides,
        spec: missionSpec,
      }),
    );
  }

  registry.putGrip(
    makeGripInput({
      mission_id: missionId,
      ...gripOverrides,
    }),
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("GripLifecycleService", () => {
  // 1. startGrip: queued -> assigned -> running
  it("startGrip transitions queued -> assigned -> running", async () => {
    seedGrip({ grip_id: "g1", status: "queued" });

    const result = await lifecycle.startGrip("g1", "arm-1", { now: NOW });

    expect(result.grip.status).toBe("running");
    expect(result.grip.assigned_arm_id).toBe("arm-1");
    expect(result.wakeGripIds).toEqual([]);
  });

  // 2. completeGrip: running -> completed + result_ref stored
  it("completeGrip stores result_ref and transitions to completed", async () => {
    seedGrip({ grip_id: "g1", status: "queued" });
    await lifecycle.startGrip("g1", "arm-1", { now: NOW });

    const result = await lifecycle.completeGrip("g1", "artifact://output/result.json", {
      now: NOW + 1000,
    });

    expect(result.grip.status).toBe("completed");
    expect(result.grip.result_ref).toBe("artifact://output/result.json");
  });

  // 3. Linear chain: complete g1 wakes g2
  it("completeGrip returns wakeGripIds for dependent grips", async () => {
    const graph = [
      { grip_id: "g1", depends_on: [] as string[] },
      { grip_id: "g2", depends_on: ["g1"] },
    ];
    const mSpec = makeMissionSpec({ graph });
    registry.putMission(makeMissionInput({ mission_id: "m1", spec: mSpec }));
    registry.putGrip(makeGripInput({ grip_id: "g1", status: "queued" }));
    registry.putGrip(makeGripInput({ grip_id: "g2", status: "queued" }));

    await lifecycle.startGrip("g1", "arm-1", { now: NOW });
    const result = await lifecycle.completeGrip("g1", "ref-1", { now: NOW + 1000 });

    expect(result.wakeGripIds).toEqual(["g2"]);
  });

  // 4. failGrip: running -> failed
  it("failGrip transitions running -> failed", async () => {
    seedGrip({ grip_id: "g1", status: "queued" });
    await lifecycle.startGrip("g1", "arm-1", { now: NOW });

    const result = await lifecycle.failGrip("g1", "timeout exceeded", { now: NOW + 1000 });

    expect(result.grip.status).toBe("failed");
  });

  // 5. failGrip with blocks_mission_on_failure=true (default)
  it("failGrip reports blocksMission=true when blocks_mission_on_failure defaults", async () => {
    const graph = [{ grip_id: "g1", depends_on: [] as string[] }];
    const mSpec = makeMissionSpec({ graph });
    registry.putMission(makeMissionInput({ mission_id: "m1", spec: mSpec }));
    registry.putGrip(makeGripInput({ grip_id: "g1", status: "queued" }));

    await lifecycle.startGrip("g1", "arm-1", { now: NOW });
    const result = await lifecycle.failGrip("g1", "crash", { now: NOW + 1000 });

    expect(result.blocksMission).toBe(true);
  });

  // 6. failGrip with blocks_mission_on_failure=false
  it("failGrip reports blocksMission=false when blocks_mission_on_failure is false", async () => {
    const graph = [{ grip_id: "g1", depends_on: [] as string[], blocks_mission_on_failure: false }];
    const mSpec = makeMissionSpec({ graph });
    registry.putMission(makeMissionInput({ mission_id: "m1", spec: mSpec }));
    registry.putGrip(makeGripInput({ grip_id: "g1", status: "queued" }));

    await lifecycle.startGrip("g1", "arm-1", { now: NOW });
    const result = await lifecycle.failGrip("g1", "non-critical failure", { now: NOW + 1000 });

    expect(result.blocksMission).toBe(false);
  });

  // 7. Invalid transition: startGrip on a running grip throws
  it("startGrip throws InvalidTransitionError on non-queued grip", async () => {
    seedGrip({ grip_id: "g1", status: "queued" });
    await lifecycle.startGrip("g1", "arm-1", { now: NOW });

    await expect(lifecycle.startGrip("g1", "arm-2", { now: NOW + 1000 })).rejects.toThrow(
      InvalidTransitionError,
    );
  });

  // 8. Invalid transition: completeGrip on a queued grip throws
  it("completeGrip throws InvalidTransitionError on non-running grip", async () => {
    seedGrip({ grip_id: "g1", status: "queued" });

    await expect(lifecycle.completeGrip("g1", "ref", { now: NOW })).rejects.toThrow(
      InvalidTransitionError,
    );
  });

  // 9. Invalid transition: failGrip on a completed grip throws
  it("failGrip throws InvalidTransitionError on completed grip", async () => {
    seedGrip({ grip_id: "g1", status: "queued" });
    await lifecycle.startGrip("g1", "arm-1", { now: NOW });
    await lifecycle.completeGrip("g1", "ref", { now: NOW + 1000 });

    await expect(lifecycle.failGrip("g1", "too late", { now: NOW + 2000 })).rejects.toThrow(
      InvalidTransitionError,
    );
  });

  // 10. GripNotFoundError for unknown grip_id
  it("throws GripNotFoundError for unknown grip_id", async () => {
    await expect(lifecycle.startGrip("nonexistent", "arm-1")).rejects.toThrow(GripNotFoundError);
  });

  // 11. failGrip returns wakeGripIds for dependents
  it("failGrip returns wakeGripIds for dependent grips", async () => {
    const graph = [
      { grip_id: "g1", depends_on: [] as string[], blocks_mission_on_failure: false },
      { grip_id: "g2", depends_on: ["g1"] },
    ];
    const mSpec = makeMissionSpec({ graph });
    registry.putMission(makeMissionInput({ mission_id: "m1", spec: mSpec }));
    registry.putGrip(makeGripInput({ grip_id: "g1", status: "queued" }));
    registry.putGrip(makeGripInput({ grip_id: "g2", status: "queued" }));

    await lifecycle.startGrip("g1", "arm-1", { now: NOW });
    const result = await lifecycle.failGrip("g1", "fail", { now: NOW + 1000 });

    expect(result.wakeGripIds).toEqual(["g2"]);
  });
});
