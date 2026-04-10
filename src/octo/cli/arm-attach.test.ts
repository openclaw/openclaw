// Octopus Orchestrator -- `openclaw octo arm attach` tests (M1-20)
//
// Covers:
//   - resolveArmSession: arm not found, no session_ref, missing tmux_session_name,
//     empty tmux_session_name, valid session
//   - runArmAttach: error cases (arm not found, no session, tmux failure),
//     success case, stderr output verification

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArmInput, RegistryService } from "../head/registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "../head/storage/migrate.ts";
import type { ArmSpec } from "../wire/schema.ts";
import {
  type ArmAttachDeps,
  type ResolvedSession,
  resolveArmSession,
  runArmAttach,
} from "./arm-attach.ts";

// ──────────────────────────────────────────────────────────────────────────
// Per-test temp DB harness
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;
let db: DatabaseSync;
let registry: RegistryService;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-arm-attach-test-"));
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
// Factory helpers
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

// ──────────────────────────────────────────────────────────────────────────
// Capture helper
// ──────────────────────────────────────────────────────────────────────────

function captureOutput(): { write: (s: string) => void; text: () => string } {
  const chunks: string[] = [];
  return {
    write: (s: string) => chunks.push(s),
    text: () => chunks.join(""),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// resolveArmSession
// ──────────────────────────────────────────────────────────────────────────

describe("resolveArmSession", () => {
  it("returns error string when arm not found", () => {
    const result = resolveArmSession(registry, "nonexistent-arm");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("not found");
  });

  it("returns error string when arm has no session_ref", () => {
    const input = makeArmInput({ arm_id: "arm-no-session", session_ref: null });
    registry.putArm(input);

    const result = resolveArmSession(registry, "arm-no-session");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("no session_ref");
  });

  it("returns error string when session_ref has no tmux_session_name", () => {
    const input = makeArmInput({
      arm_id: "arm-no-tmux",
      session_ref: { some_other_key: "value" },
    });
    registry.putArm(input);

    const result = resolveArmSession(registry, "arm-no-tmux");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("no valid tmux_session_name");
  });

  it("returns error string when tmux_session_name is empty string", () => {
    const input = makeArmInput({
      arm_id: "arm-empty-tmux",
      session_ref: { tmux_session_name: "" },
    });
    registry.putArm(input);

    const result = resolveArmSession(registry, "arm-empty-tmux");
    expect(typeof result).toBe("string");
    expect(result as string).toContain("no valid tmux_session_name");
  });

  it("returns ResolvedSession when arm has valid tmux session", () => {
    const input = makeArmInput({
      arm_id: "arm-valid",
      session_ref: { tmux_session_name: "octo-arm-valid" },
    });
    registry.putArm(input);

    const result = resolveArmSession(registry, "arm-valid");
    expect(typeof result).toBe("object");
    const resolved = result as ResolvedSession;
    expect(resolved.tmux_session_name).toBe("octo-arm-valid");
    expect(resolved.arm.arm_id).toBe("arm-valid");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// runArmAttach
// ──────────────────────────────────────────────────────────────────────────

describe("runArmAttach", () => {
  it("exits 1 and prints error when arm not found", () => {
    const out = captureOutput();
    const deps: ArmAttachDeps = { execAttach: () => ({ status: 0, stderr: "" }) };

    const code = runArmAttach(registry, { arm_id: "missing" }, out, deps);
    expect(code).toBe(1);
    expect(out.text()).toContain("not found");
  });

  it("exits 1 and prints error when arm has no session_ref", () => {
    registry.putArm(makeArmInput({ arm_id: "arm-nosess", session_ref: null }));
    const out = captureOutput();
    const deps: ArmAttachDeps = { execAttach: () => ({ status: 0, stderr: "" }) };

    const code = runArmAttach(registry, { arm_id: "arm-nosess" }, out, deps);
    expect(code).toBe(1);
    expect(out.text()).toContain("no session_ref");
  });

  it("exits 1 and reports stderr when tmux attach fails", () => {
    registry.putArm(
      makeArmInput({
        arm_id: "arm-tmux-fail",
        session_ref: { tmux_session_name: "dead-session" },
      }),
    );
    const out = captureOutput();
    const deps: ArmAttachDeps = {
      execAttach: () => ({ status: 1, stderr: "session not found: dead-session" }),
    };

    const code = runArmAttach(registry, { arm_id: "arm-tmux-fail" }, out, deps);
    expect(code).toBe(1);
    expect(out.text()).toContain("session not found: dead-session");
  });

  it("exits 1 with generic message when tmux fails without stderr", () => {
    registry.putArm(
      makeArmInput({
        arm_id: "arm-tmux-fail2",
        session_ref: { tmux_session_name: "dead2" },
      }),
    );
    const out = captureOutput();
    const deps: ArmAttachDeps = {
      execAttach: () => ({ status: 2, stderr: "" }),
    };

    const code = runArmAttach(registry, { arm_id: "arm-tmux-fail2" }, out, deps);
    expect(code).toBe(1);
    expect(out.text()).toContain("exited with code 2");
  });

  it("exits 0 when tmux attach succeeds", () => {
    registry.putArm(
      makeArmInput({
        arm_id: "arm-ok",
        session_ref: { tmux_session_name: "octo-arm-ok" },
      }),
    );
    const out = captureOutput();
    let attachedTo = "";
    const deps: ArmAttachDeps = {
      execAttach: (name: string) => {
        attachedTo = name;
        return { status: 0, stderr: "" };
      },
    };

    const code = runArmAttach(registry, { arm_id: "arm-ok" }, out, deps);
    expect(code).toBe(0);
    expect(attachedTo).toBe("octo-arm-ok");
    expect(out.text()).toBe("");
  });
});
