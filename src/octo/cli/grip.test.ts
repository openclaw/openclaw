// Octopus Orchestrator -- `openclaw octo grip list/show/reassign` tests (M3-09)
//
// Covers:
//   - gatherGripList: empty registry, populated, filter by status
//   - formatGripList: human-readable table, empty state message
//   - runGripList: exit code 0, json mode
//   - gatherGripShow: found and not-found
//   - runGripShow: exit code 0 on found, exit code 1 on not-found, json mode
//   - runGripReassign: returns 1 with not-yet-implemented message

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GripInput, RegistryService } from "../head/registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "../head/storage/migrate.ts";
import type { GripSpec } from "../wire/schema.ts";
import {
  formatGripList,
  gatherGripList,
  gatherGripShow,
  runGripList,
  runGripReassign,
  runGripShow,
} from "./grip.ts";

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp DB harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;
let db: DatabaseSync;
let registry: RegistryService;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-grip-test-"));
  const dbPath = path.join(tempDir, "registry.sqlite");
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
// Factory helpers -- minimal valid inputs
// ──────────────────────────────────────────────────────────────────────────

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
    status: "queued",
    timeout_s: 300,
    side_effecting: false,
    idempotency_key: null,
    result_ref: null,
    spec: makeGripSpec(),
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════
// gatherGripList
// ════════════════════════════════════════════════════════════════════════

describe("gatherGripList", () => {
  it("returns empty array on empty registry", () => {
    const grips = gatherGripList(registry, {});
    expect(grips).toEqual([]);
  });

  it("returns all grips when no filters are applied", () => {
    registry.putGrip(makeGripInput({ status: "queued" }));
    registry.putGrip(makeGripInput({ status: "running" }));
    registry.putGrip(makeGripInput({ status: "completed" }));

    const grips = gatherGripList(registry, {});
    expect(grips).toHaveLength(3);
  });

  it("filters by status", () => {
    registry.putGrip(makeGripInput({ status: "queued" }));
    registry.putGrip(makeGripInput({ status: "running" }));
    registry.putGrip(makeGripInput({ status: "completed" }));

    const grips = gatherGripList(registry, { status: "running" });
    expect(grips).toHaveLength(1);
    expect(grips[0].status).toBe("running");
  });
});

// ════════════════════════════════════════════════════════════════════════
// formatGripList
// ════════════════════════════════════════════════════════════════════════

describe("formatGripList", () => {
  it("shows empty message when no grips", () => {
    const output = formatGripList([]);
    expect(output).toContain("No grips found.");
  });

  it("renders table with header and grip rows", () => {
    const grip = {
      grip_id: "grip-001",
      mission_id: "mission-x",
      type: "code-edit",
      input_ref: null,
      priority: 5,
      assigned_arm_id: "arm-abc",
      status: "running",
      timeout_s: 300,
      side_effecting: false,
      idempotency_key: null,
      result_ref: null,
      spec: makeGripSpec(),
      created_at: Date.now(),
      updated_at: Date.now(),
      version: 1,
    };

    const output = formatGripList([grip]);
    expect(output).toContain("GRIP_ID");
    expect(output).toContain("MISSION");
    expect(output).toContain("TYPE");
    expect(output).toContain("STATUS");
    expect(output).toContain("grip-001");
    expect(output).toContain("running");
    expect(output).toContain("arm-abc");
    expect(output).toContain("1 grip(s) total");
  });
});

// ════════════════════════════════════════════════════════════════════════
// runGripList
// ════════════════════════════════════════════════════════════════════════

describe("runGripList", () => {
  it("returns 0 and writes output", () => {
    registry.putGrip(makeGripInput({ status: "queued" }));

    const out = { write: vi.fn() };
    const code = runGripList(registry, {}, out);

    expect(code).toBe(0);
    expect(out.write).toHaveBeenCalledTimes(1);
  });

  it("with json: true produces JSON output", () => {
    registry.putGrip(makeGripInput({ status: "queued" }));

    const out = { write: vi.fn() };
    const code = runGripList(registry, { json: true }, out);

    expect(code).toBe(0);
    const written = (out.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written.trimStart().startsWith("[")).toBe(true);

    const parsed = JSON.parse(written) as unknown[];
    expect(parsed).toHaveLength(1);
    expect((parsed[0] as Record<string, unknown>).status).toBe("queued");
  });
});

// ════════════════════════════════════════════════════════════════════════
// gatherGripShow + runGripShow
// ════════════════════════════════════════════════════════════════════════

describe("gatherGripShow", () => {
  it("returns the grip when it exists", () => {
    const inserted = registry.putGrip(makeGripInput({ grip_id: "grip-show-1" }));

    const grip = gatherGripShow(registry, "grip-show-1");
    expect(grip).not.toBeNull();
    expect(grip!.grip_id).toBe(inserted.grip_id);
  });

  it("returns null when grip does not exist", () => {
    const grip = gatherGripShow(registry, "nonexistent");
    expect(grip).toBeNull();
  });
});

describe("runGripShow", () => {
  it("returns 0 on found grip", () => {
    registry.putGrip(makeGripInput({ grip_id: "grip-found" }));

    const out = { write: vi.fn() };
    const code = runGripShow(registry, "grip-found", {}, out);

    expect(code).toBe(0);
    const written = (out.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written).toContain("grip-found");
    expect(written).toContain("Status:");
  });

  it("returns 1 on unknown grip", () => {
    const out = { write: vi.fn() };
    const code = runGripShow(registry, "no-such-grip", {}, out);

    expect(code).toBe(1);
    const written = (out.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written).toContain("unknown grip_id");
  });

  it("with json: true produces JSON output", () => {
    registry.putGrip(makeGripInput({ grip_id: "grip-json" }));

    const out = { write: vi.fn() };
    const code = runGripShow(registry, "grip-json", { json: true }, out);

    expect(code).toBe(0);
    const written = (out.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed.grip_id).toBe("grip-json");
  });
});

// ════════════════════════════════════════════════════════════════════════
// runGripReassign (stub)
// ════════════════════════════════════════════════════════════════════════

describe("runGripReassign", () => {
  it("returns 1 with not-yet-implemented message", () => {
    const out = { write: vi.fn() };
    const code = runGripReassign(registry, "grip-1", "arm-2", out);

    expect(code).toBe(1);
    const written = (out.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written).toContain("not yet implemented");
  });
});
