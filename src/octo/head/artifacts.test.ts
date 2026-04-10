// Octopus Orchestrator -- ArtifactService tests (M3-06)
//
// Covers:
//   - Record an artifact and get it back by ID
//   - Record 5 artifacts across 2 missions, listByMission returns correct subset
//   - listByArm returns correct subset
//   - listByGrip returns correct subset
//   - get returns null for unknown ID
//   - artifact.recorded event emitted on record
//   - artifact_type must be one of the valid literals
//   - metadata round-trips through JSON
//   - Multiple artifacts with same mission_id returned in created_at DESC order

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactInput, ArtifactService } from "./artifacts.ts";
import { EventLogService } from "./event-log.ts";
import { closeOctoRegistry, openOctoRegistry } from "./storage/migrate.ts";

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;
let db: DatabaseSync;
let eventLog: EventLogService;
let service: ArtifactService;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-artifact-test-"));
  const dbPath = path.join(tempDir, "registry.sqlite");
  db = openOctoRegistry({ path: dbPath });
  eventLog = new EventLogService({ path: path.join(tempDir, "events.jsonl") });
  service = new ArtifactService(db, eventLog);
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
// Factory helper
// ──────────────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<ArtifactInput> = {}): ArtifactInput {
  return {
    artifact_type: "log",
    mission_id: "mission-1",
    grip_id: null,
    arm_id: "arm-1",
    storage_ref: "blob://artifacts/test.log",
    metadata: null,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("ArtifactService", () => {
  it("records an artifact and retrieves it by ID", async () => {
    const recorded = await service.record(makeInput());
    expect(recorded.artifact_id).toMatch(/^art-/);
    expect(recorded.artifact_type).toBe("log");
    expect(recorded.mission_id).toBe("mission-1");
    expect(recorded.arm_id).toBe("arm-1");
    expect(recorded.storage_ref).toBe("blob://artifacts/test.log");
    expect(typeof recorded.created_at).toBe("number");

    const fetched = service.get(recorded.artifact_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.artifact_id).toBe(recorded.artifact_id);
    expect(fetched!.artifact_type).toBe("log");
  });

  it("listByMission returns correct subset across 2 missions (5 artifacts)", async () => {
    const m1Arts = [];
    for (let i = 0; i < 3; i++) {
      m1Arts.push(await service.record(makeInput({ mission_id: "m1", created_at: 1000 + i })));
    }
    for (let i = 0; i < 2; i++) {
      await service.record(makeInput({ mission_id: "m2", created_at: 2000 + i }));
    }

    const m1Result = service.listByMission("m1");
    expect(m1Result).toHaveLength(3);
    for (const r of m1Result) {
      expect(r.mission_id).toBe("m1");
    }

    const m2Result = service.listByMission("m2");
    expect(m2Result).toHaveLength(2);
    for (const r of m2Result) {
      expect(r.mission_id).toBe("m2");
    }
  });

  it("listByArm returns correct subset", async () => {
    await service.record(makeInput({ arm_id: "arm-a" }));
    await service.record(makeInput({ arm_id: "arm-a" }));
    await service.record(makeInput({ arm_id: "arm-b" }));

    const result = service.listByArm("arm-a");
    expect(result).toHaveLength(2);
    for (const r of result) {
      expect(r.arm_id).toBe("arm-a");
    }
  });

  it("listByGrip returns correct subset", async () => {
    await service.record(makeInput({ grip_id: "grip-x" }));
    await service.record(makeInput({ grip_id: "grip-x" }));
    await service.record(makeInput({ grip_id: "grip-y" }));

    const result = service.listByGrip("grip-x");
    expect(result).toHaveLength(2);
    for (const r of result) {
      expect(r.grip_id).toBe("grip-x");
    }
  });

  it("get returns null for unknown ID", () => {
    const result = service.get("art-nonexistent");
    expect(result).toBeNull();
  });

  it("emits artifact.recorded event on record", async () => {
    await service.record(makeInput({ artifact_type: "summary" }));

    const logContent = readFileSync(path.join(tempDir, "events.jsonl"), "utf8");
    const lines = logContent.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const lastLine = lines[lines.length - 1] ?? "";
    const event = JSON.parse(lastLine) as Record<string, unknown>;
    expect(event.entity_type).toBe("artifact");
    expect(event.event_type).toBe("artifact.recorded");
    expect((event.payload as Record<string, unknown>).artifact_type).toBe("summary");
  });

  it("rejects invalid artifact_type", async () => {
    await expect(service.record(makeInput({ artifact_type: "invalid" as "log" }))).rejects.toThrow(
      /invalid artifact_type/,
    );
  });

  it("metadata round-trips through JSON", async () => {
    const meta = { foo: "bar", count: 42, nested: { a: [1, 2, 3] } };
    const recorded = await service.record(makeInput({ metadata: meta }));
    const fetched = service.get(recorded.artifact_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.metadata).toEqual(meta);
  });

  it("returns artifacts in created_at DESC order for same mission", async () => {
    await service.record(makeInput({ mission_id: "m-order", created_at: 100 }));
    await service.record(makeInput({ mission_id: "m-order", created_at: 300 }));
    await service.record(makeInput({ mission_id: "m-order", created_at: 200 }));

    const result = service.listByMission("m-order");
    expect(result).toHaveLength(3);
    expect(result[0]?.created_at).toBe(300);
    expect(result[1]?.created_at).toBe(200);
    expect(result[2]?.created_at).toBe(100);
  });
});
