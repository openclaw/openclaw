// Octopus Orchestrator — mission CLI subcommand tests (M3-08)
//
// Integration tests that exercise the full gather + format + run pipeline
// for each mission subcommand (create, show, list, pause, resume, abort)
// against a real RegistryService backed by a temp SQLite DB.
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventLogService } from "../head/event-log.ts";
import { RegistryService } from "../head/registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "../head/storage/migrate.ts";
import type { TmuxManager } from "../node-agent/tmux-manager.ts";
import { OctoGatewayHandlers } from "../wire/gateway-handlers.ts";
import {
  formatMissionAbort,
  formatMissionAbortJson,
  formatMissionCreate,
  formatMissionCreateJson,
  formatMissionList,
  formatMissionListJson,
  formatMissionPause,
  formatMissionPauseJson,
  formatMissionResume,
  formatMissionResumeJson,
  formatMissionShow,
  formatMissionShowJson,
  gatherMissionCreate,
  gatherMissionList,
  gatherMissionShow,
  runMissionAbort,
  runMissionCreate,
  runMissionList,
  runMissionPause,
  runMissionResume,
  runMissionShow,
} from "./mission.ts";

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp DB harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;
let db: DatabaseSync;
let registry: RegistryService;
let handlers: OctoGatewayHandlers;
let missionCounter: number;

function createMockEventLog(): EventLogService {
  return {
    append: vi.fn().mockResolvedValue({
      event_id: "test-event-id",
      schema_version: 1,
      entity_type: "mission",
      entity_id: "test",
      event_type: "mission.created",
      ts: new Date().toISOString(),
      actor: "test",
      payload: {},
    }),
  } as unknown as EventLogService;
}

function createMockTmuxManager(): TmuxManager {
  return {
    createSession: vi.fn().mockResolvedValue("mock-session"),
    killSession: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
    hasSession: vi.fn().mockResolvedValue(false),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    capturePane: vi.fn().mockResolvedValue(""),
  } as unknown as TmuxManager;
}

function capture(): { write: (s: string) => void; output: () => string } {
  let buf = "";
  return {
    write: (s: string) => {
      buf += s;
    },
    output: () => buf,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-mission-cli-test-"));
  const dbPath = path.join(tempDir, "registry.sqlite");
  db = openOctoRegistry({ path: dbPath });
  registry = new RegistryService(db);
  missionCounter = 0;
  handlers = new OctoGatewayHandlers({
    registry,
    eventLog: createMockEventLog(),
    tmuxManager: createMockTmuxManager(),
    nodeId: "test-node",
    now: () => 1700000000000,
    generateMissionId: () => `mission-${++missionCounter}`,
    generateArmId: () => `arm-${Date.now()}`,
  });
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

let gripCounter = 0;

async function createTestMission(
  title = "test mission",
  owner = "tester",
): Promise<{ mission_id: string; grip_count: number }> {
  const g1 = `g-${++gripCounter}`;
  const g2 = `g-${++gripCounter}`;
  return gatherMissionCreate(handlers, {
    title,
    owner,
    gripIds: [g1, g2],
    idempotencyKey: `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════

describe("mission create", () => {
  it("creates a mission and returns id + grip count", async () => {
    const result = await createTestMission();
    expect(result.mission_id).toBe("mission-1");
    expect(result.grip_count).toBe(2);
  });

  it("runMissionCreate writes human output", async () => {
    const out = capture();
    const code = await runMissionCreate(
      handlers,
      {
        title: "my mission",
        owner: "alice",
        gripIds: ["g1"],
        idempotencyKey: "idem-run-create",
      },
      out,
    );
    expect(code).toBe(0);
    expect(out.output()).toContain("Mission created: mission-1");
    expect(out.output()).toContain("Grips: 1");
  });

  it("runMissionCreate writes JSON output", async () => {
    const out = capture();
    const code = await runMissionCreate(
      handlers,
      {
        title: "json mission",
        owner: "bob",
        gripIds: ["g1", "g2", "g3"],
        idempotencyKey: "idem-json-create",
        json: true,
      },
      out,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out.output()) as { mission_id: string; grip_count: number };
    expect(parsed.mission_id).toBe("mission-1");
    expect(parsed.grip_count).toBe(3);
  });
});

describe("mission show", () => {
  it("shows an existing mission", async () => {
    const { mission_id } = await createTestMission("show-test", "tester");
    const result = gatherMissionShow(registry, { missionId: mission_id });
    expect(result).not.toBeNull();
    expect(result!.mission.title).toBe("show-test");
    expect(result!.mission.status).toBe("active");
  });

  it("returns null for missing mission", () => {
    const result = gatherMissionShow(registry, { missionId: "no-such-mission" });
    expect(result).toBeNull();
  });

  it("runMissionShow returns exit code 1 for missing mission", () => {
    const out = capture();
    const code = runMissionShow(registry, { missionId: "missing" }, out);
    expect(code).toBe(1);
    expect(out.output()).toContain("Mission not found: missing");
  });

  it("runMissionShow --json emits valid JSON", async () => {
    const { mission_id } = await createTestMission("json-show", "tester");
    const out = capture();
    const code = runMissionShow(registry, { missionId: mission_id, json: true }, out);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.output()) as { mission_id: string; title: string };
    expect(parsed.mission_id).toBe(mission_id);
    expect(parsed.title).toBe("json-show");
  });
});

describe("mission list", () => {
  it("lists no missions when empty", () => {
    const result = gatherMissionList(registry);
    expect(result.missions).toHaveLength(0);
  });

  it("lists created missions", async () => {
    await createTestMission("m1", "alice");
    await createTestMission("m2", "bob");
    const result = gatherMissionList(registry);
    expect(result.missions).toHaveLength(2);
  });

  it("runMissionList --json emits array", async () => {
    await createTestMission("list-json", "tester");
    const out = capture();
    const code = runMissionList(registry, { json: true }, out);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.output()) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it("formats empty list message", () => {
    const text = formatMissionList({ missions: [] });
    expect(text).toContain("No missions found.");
  });
});

describe("mission pause", () => {
  it("pauses an active mission", async () => {
    const { mission_id } = await createTestMission();
    const out = capture();
    const code = await runMissionPause(
      handlers,
      { missionId: mission_id, idempotencyKey: "idem-pause" },
      out,
    );
    expect(code).toBe(0);
    expect(out.output()).toContain(`Mission ${mission_id} paused.`);
    // Verify state in registry
    const m = registry.getMission(mission_id);
    expect(m).not.toBeNull();
    expect(m!.status).toBe("paused");
  });

  it("pause --json emits valid JSON", async () => {
    const { mission_id } = await createTestMission();
    const out = capture();
    await runMissionPause(
      handlers,
      { missionId: mission_id, idempotencyKey: "idem-pause-json", json: true },
      out,
    );
    const parsed = JSON.parse(out.output()) as { mission_id: string; status: string };
    expect(parsed.status).toBe("paused");
  });
});

describe("mission resume", () => {
  it("resumes a paused mission", async () => {
    const { mission_id } = await createTestMission();
    // Pause first
    await handlers.missionPause({
      mission_id,
      idempotency_key: "idem-pause-pre-resume",
    });
    const out = capture();
    const code = await runMissionResume(
      handlers,
      { missionId: mission_id, idempotencyKey: "idem-resume" },
      out,
    );
    expect(code).toBe(0);
    expect(out.output()).toContain(`Mission ${mission_id} resumed.`);
    const m = registry.getMission(mission_id);
    expect(m).not.toBeNull();
    expect(m!.status).toBe("active");
  });

  it("resume --json emits valid JSON", async () => {
    const { mission_id } = await createTestMission();
    await handlers.missionPause({
      mission_id,
      idempotency_key: "idem-pause-pre-resume-json",
    });
    const out = capture();
    await runMissionResume(
      handlers,
      { missionId: mission_id, idempotencyKey: "idem-resume-json", json: true },
      out,
    );
    const parsed = JSON.parse(out.output()) as { mission_id: string; status: string };
    expect(parsed.status).toBe("active");
  });
});

describe("mission abort", () => {
  it("aborts an active mission", async () => {
    const { mission_id } = await createTestMission();
    const out = capture();
    const code = await runMissionAbort(
      handlers,
      {
        missionId: mission_id,
        reason: "testing abort",
        idempotencyKey: "idem-abort",
      },
      out,
    );
    expect(code).toBe(0);
    expect(out.output()).toContain(`Mission ${mission_id} aborted.`);
    expect(out.output()).toContain("Arms terminated:");
    const m = registry.getMission(mission_id);
    expect(m).not.toBeNull();
    expect(m!.status).toBe("aborted");
  });

  it("abort --json emits valid JSON", async () => {
    const { mission_id } = await createTestMission();
    const out = capture();
    await runMissionAbort(
      handlers,
      {
        missionId: mission_id,
        reason: "json abort test",
        idempotencyKey: "idem-abort-json",
        json: true,
      },
      out,
    );
    const parsed = JSON.parse(out.output()) as {
      mission_id: string;
      status: string;
      arms_terminated: number;
    };
    expect(parsed.status).toBe("aborted");
    expect(typeof parsed.arms_terminated).toBe("number");
  });
});

describe("format functions", () => {
  it("formatMissionCreate produces expected text", () => {
    const text = formatMissionCreate({ mission_id: "m-1", grip_count: 3 });
    expect(text).toContain("Mission created: m-1");
    expect(text).toContain("Grips: 3");
  });

  it("formatMissionCreateJson produces valid JSON", () => {
    const json = formatMissionCreateJson({ mission_id: "m-1", grip_count: 3 });
    const parsed = JSON.parse(json) as { mission_id: string };
    expect(parsed.mission_id).toBe("m-1");
  });

  it("formatMissionShow includes all fields", () => {
    const text = formatMissionShow({
      mission: {
        mission_id: "m-1",
        title: "t",
        owner: "o",
        status: "active",
        policy_profile_ref: null,
        spec: { spec_version: 1, title: "t", owner: "o", graph: [] },
        metadata: null,
        created_at: 1700000000000,
        updated_at: 1700000000000,
        version: 1,
      },
    });
    expect(text).toContain("Mission: m-1");
    expect(text).toContain("Title:   t");
    expect(text).toContain("Status:  active");
  });

  it("formatMissionShowJson produces valid JSON", () => {
    const json = formatMissionShowJson({
      mission: {
        mission_id: "m-1",
        title: "t",
        owner: "o",
        status: "active",
        policy_profile_ref: null,
        spec: { spec_version: 1, title: "t", owner: "o", graph: [] },
        metadata: null,
        created_at: 1700000000000,
        updated_at: 1700000000000,
        version: 1,
      },
    });
    const parsed = JSON.parse(json) as { mission_id: string };
    expect(parsed.mission_id).toBe("m-1");
  });

  it("formatMissionListJson produces valid JSON array", () => {
    const json = formatMissionListJson({ missions: [] });
    const parsed = JSON.parse(json) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("formatMissionPause produces expected text", () => {
    const text = formatMissionPause({ mission_id: "m-1", status: "paused" });
    expect(text).toBe("Mission m-1 paused.\n");
  });

  it("formatMissionPauseJson produces valid JSON", () => {
    const json = formatMissionPauseJson({ mission_id: "m-1", status: "paused" });
    const parsed = JSON.parse(json) as { status: string };
    expect(parsed.status).toBe("paused");
  });

  it("formatMissionResume produces expected text", () => {
    const text = formatMissionResume({ mission_id: "m-1", status: "active" });
    expect(text).toBe("Mission m-1 resumed.\n");
  });

  it("formatMissionResumeJson produces valid JSON", () => {
    const json = formatMissionResumeJson({ mission_id: "m-1", status: "active" });
    const parsed = JSON.parse(json) as { status: string };
    expect(parsed.status).toBe("active");
  });

  it("formatMissionAbort produces expected text", () => {
    const text = formatMissionAbort({ mission_id: "m-1", status: "aborted", arms_terminated: 2 });
    expect(text).toContain("Mission m-1 aborted.");
    expect(text).toContain("Arms terminated: 2");
  });

  it("formatMissionAbortJson produces valid JSON", () => {
    const json = formatMissionAbortJson({
      mission_id: "m-1",
      status: "aborted",
      arms_terminated: 0,
    });
    const parsed = JSON.parse(json) as { arms_terminated: number };
    expect(parsed.arms_terminated).toBe(0);
  });
});
