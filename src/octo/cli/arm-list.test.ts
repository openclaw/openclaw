// Octopus Orchestrator -- `openclaw octo arm list` tests (M1-18)
//
// Covers:
//   - gatherArmList: empty registry, populated, filter by mission/node/state
//   - formatArmList: human-readable table, empty state message
//   - formatArmListJson: valid JSON round-trip
//   - runArmList: exit code 0 (empty + populated), json mode, output stream mock

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ArmInput, RegistryService } from "../head/registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "../head/storage/migrate.ts";
import type { ArmSpec } from "../wire/schema.ts";
import { formatArmList, formatArmListJson, gatherArmList, runArmList } from "./arm-list.ts";

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp DB harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;
let db: DatabaseSync;
let registry: RegistryService;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-arm-list-test-"));
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

function makeArmSpec(overrides: Partial<ArmSpec> = {}): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "mission-1",
    adapter_type: "cli_exec",
    runtime_name: "claude-cli",
    agent_id: "agent-1",
    cwd: "/tmp",
    idempotency_key: "idem-1",
    runtime_options: { command: "echo" },
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
    state: "active",
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

// ════════════════════════════════════════════════════════════════════════
// gatherArmList
// ════════════════════════════════════════════════════════════════════════

describe("gatherArmList", () => {
  it("returns empty array on empty registry", () => {
    const arms = gatherArmList(registry, {});
    expect(arms).toEqual([]);
  });

  it("returns all arms when no filters are applied", () => {
    registry.putArm(makeArmInput({ state: "active" }));
    registry.putArm(makeArmInput({ state: "idle" }));
    registry.putArm(makeArmInput({ state: "blocked" }));

    const arms = gatherArmList(registry, {});
    expect(arms).toHaveLength(3);
  });

  it("filters by mission", () => {
    registry.putArm(
      makeArmInput({ mission_id: "m-alpha", spec: makeArmSpec({ mission_id: "m-alpha" }) }),
    );
    registry.putArm(
      makeArmInput({ mission_id: "m-beta", spec: makeArmSpec({ mission_id: "m-beta" }) }),
    );

    const arms = gatherArmList(registry, { mission: "m-alpha" });
    expect(arms).toHaveLength(1);
    expect(arms[0].mission_id).toBe("m-alpha");
  });

  it("filters by node", () => {
    registry.putArm(makeArmInput({ node_id: "node-a" }));
    registry.putArm(makeArmInput({ node_id: "node-b" }));

    const arms = gatherArmList(registry, { node: "node-a" });
    expect(arms).toHaveLength(1);
    expect(arms[0].node_id).toBe("node-a");
  });

  it("filters by state", () => {
    registry.putArm(makeArmInput({ state: "active" }));
    registry.putArm(makeArmInput({ state: "idle" }));
    registry.putArm(makeArmInput({ state: "failed" }));

    const arms = gatherArmList(registry, { state: "idle" });
    expect(arms).toHaveLength(1);
    expect(arms[0].state).toBe("idle");
  });

  it("combines multiple filters", () => {
    registry.putArm(
      makeArmInput({
        mission_id: "m-1",
        node_id: "n-1",
        state: "active",
        spec: makeArmSpec({ mission_id: "m-1" }),
      }),
    );
    registry.putArm(
      makeArmInput({
        mission_id: "m-1",
        node_id: "n-2",
        state: "active",
        spec: makeArmSpec({ mission_id: "m-1" }),
      }),
    );
    registry.putArm(
      makeArmInput({
        mission_id: "m-2",
        node_id: "n-1",
        state: "active",
        spec: makeArmSpec({ mission_id: "m-2" }),
      }),
    );

    const arms = gatherArmList(registry, { mission: "m-1", node: "n-1" });
    expect(arms).toHaveLength(1);
    expect(arms[0].mission_id).toBe("m-1");
    expect(arms[0].node_id).toBe("n-1");
  });
});

// ════════════════════════════════════════════════════════════════════════
// formatArmList
// ════════════════════════════════════════════════════════════════════════

describe("formatArmList", () => {
  it("shows empty message when no arms", () => {
    const output = formatArmList([]);
    expect(output).toContain("No arms found.");
  });

  it("renders table with header and arm rows", () => {
    const arm = {
      arm_id: "arm-001",
      mission_id: "mission-x",
      node_id: "node-a",
      adapter_type: "cli_exec",
      runtime_name: "claude-cli",
      agent_id: "agent-z",
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
      spec: makeArmSpec(),
      created_at: Date.now(),
      updated_at: Date.now(),
      version: 1,
    };

    const output = formatArmList([arm]);
    expect(output).toContain("ARM_ID");
    expect(output).toContain("MISSION");
    expect(output).toContain("NODE");
    expect(output).toContain("STATE");
    expect(output).toContain("RUNTIME");
    expect(output).toContain("AGENT");
    expect(output).toContain("arm-001");
    expect(output).toContain("mission-x");
    expect(output).toContain("node-a");
    expect(output).toContain("active");
    expect(output).toContain("claude-cli");
    expect(output).toContain("agent-z");
    expect(output).toContain("1 arm(s) total");
  });
});

// ════════════════════════════════════════════════════════════════════════
// formatArmListJson
// ════════════════════════════════════════════════════════════════════════

describe("formatArmListJson", () => {
  it("produces valid JSON that round-trips to the input", () => {
    const arm = {
      arm_id: "arm-j1",
      mission_id: "mission-j",
      node_id: "node-j",
      adapter_type: "cli_exec",
      runtime_name: "claude-cli",
      agent_id: "agent-j",
      task_ref: null,
      state: "idle",
      current_grip_id: null,
      lease_owner: null,
      lease_expiry_ts: null,
      session_ref: null,
      checkpoint_ref: null,
      health_status: null,
      restart_count: 0,
      policy_profile: null,
      spec: makeArmSpec(),
      created_at: 1000,
      updated_at: 2000,
      version: 1,
    };

    const json = formatArmListJson([arm]);
    const parsed = JSON.parse(json) as unknown[];
    expect(parsed).toHaveLength(1);
    expect((parsed[0] as Record<string, unknown>).arm_id).toBe("arm-j1");
  });
});

// ════════════════════════════════════════════════════════════════════════
// runArmList
// ════════════════════════════════════════════════════════════════════════

describe("runArmList", () => {
  it("returns 0 on empty state", () => {
    const out = { write: vi.fn() };
    const code = runArmList(registry, {}, out);

    expect(code).toBe(0);
    expect(out.write).toHaveBeenCalled();
  });

  it("returns 0 on populated state", () => {
    registry.putArm(makeArmInput({ state: "active" }));

    const out = { write: vi.fn() };
    const code = runArmList(registry, {}, out);

    expect(code).toBe(0);
  });

  it("with json: true produces JSON output", () => {
    registry.putArm(makeArmInput({ state: "idle" }));

    const out = { write: vi.fn() };
    const code = runArmList(registry, { json: true }, out);

    expect(code).toBe(0);
    const written = (out.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written.trimStart().startsWith("[")).toBe(true);

    const parsed = JSON.parse(written) as unknown[];
    expect(parsed).toHaveLength(1);
    expect((parsed[0] as Record<string, unknown>).state).toBe("idle");
  });

  it("writes to the provided output stream", () => {
    const out = { write: vi.fn() };
    runArmList(registry, {}, out);

    expect(out.write).toHaveBeenCalledTimes(1);
    expect(typeof out.write.mock.calls[0][0]).toBe("string");
  });
});
