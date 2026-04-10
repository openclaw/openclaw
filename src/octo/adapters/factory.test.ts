// Octopus Orchestrator -- Adapter factory tests (M2-04)
//
// Tests the createAdapter factory function and the PtyTmuxAdapter's
// spawn method (with sentinel wrapper) via a mock TmuxManager.

import { describe, expect, it } from "vitest";
import { TmuxManager } from "../node-agent/tmux-manager.ts";
import type { ArmSpec } from "../wire/schema.ts";
import { AdapterError } from "./base.ts";
import { createAdapter, type AdapterDeps } from "./factory.ts";

// ──────────────────────────────────────────────────────────────────────────
// Mock TmuxManager
// ──────────────────────────────────────────────────────────────────────────

class MockTmuxManager extends TmuxManager {
  public readonly calls: Array<{ name: string; cmd: string; cwd: string }> = [];

  override async createSession(name: string, cmd: string, cwd: string): Promise<string> {
    this.calls.push({ name, cmd, cwd });
    return name;
  }

  override async killSession(_name: string): Promise<boolean> {
    return true;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<AdapterDeps> = {}): AdapterDeps {
  return {
    tmuxManager: new MockTmuxManager(),
    ...overrides,
  };
}

function makeArmSpec(overrides: Partial<ArmSpec> = {}): ArmSpec & { _arm_id: string } {
  return {
    spec_version: 1,
    mission_id: "mission-factory-test",
    adapter_type: "pty_tmux",
    runtime_name: "bash",
    agent_id: "agent-factory-test",
    cwd: "/tmp",
    idempotency_key: "idem-factory-test",
    runtime_options: {
      command: "sleep",
      args: ["60"],
    },
    _arm_id: "test-arm-001",
    ...overrides,
  } as ArmSpec & { _arm_id: string };
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("createAdapter (M2-04)", () => {
  it("creates a pty_tmux adapter", () => {
    const adapter = createAdapter("pty_tmux", makeDeps());
    expect(adapter).toBeDefined();
    expect(adapter.type).toBe("pty_tmux");
  });

  it("creates a cli_exec adapter", () => {
    const adapter = createAdapter("cli_exec", makeDeps());
    expect(adapter).toBeDefined();
    expect(adapter.type).toBe("cli_exec");
  });

  it("throws AdapterError(not_supported) for structured_subagent", () => {
    expect(() => createAdapter("structured_subagent", makeDeps())).toThrow(AdapterError);
    try {
      createAdapter("structured_subagent", makeDeps());
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe("not_supported");
    }
  });

  it("throws AdapterError(not_supported) for structured_acp", () => {
    expect(() => createAdapter("structured_acp", makeDeps())).toThrow(AdapterError);
    try {
      createAdapter("structured_acp", makeDeps());
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe("not_supported");
    }
  });
});

describe("PtyTmuxAdapter.spawn via factory", () => {
  it("spawn calls TmuxManager.createSession with sentinel-wrapped command", async () => {
    const mockTmux = new MockTmuxManager();
    const adapter = createAdapter("pty_tmux", { tmuxManager: mockTmux });
    const spec = makeArmSpec();

    const ref = await adapter.spawn(spec);

    expect(mockTmux.calls.length).toBe(1);
    expect(mockTmux.calls[0]?.name).toBe("octo-arm-test-arm-001");
    // Command should include sentinel wrapper
    expect(mockTmux.calls[0]?.cmd).toContain("sleep 60");
    expect(mockTmux.calls[0]?.cmd).toContain("echo $?");
    expect(mockTmux.calls[0]?.cmd).toContain("test-arm-001.exit");
    expect(mockTmux.calls[0]?.cwd).toBe("/tmp");

    expect(ref.adapter_type).toBe("pty_tmux");
    expect(ref.session_id).toBe("octo-arm-test-arm-001");
    expect(ref.cwd).toBe("/tmp");
    expect(ref.metadata?.tmux_session_name).toBe("octo-arm-test-arm-001");
  });

  it("spawn without _arm_id falls back to idempotency_key (no sentinel)", async () => {
    const mockTmux = new MockTmuxManager();
    const adapter = createAdapter("pty_tmux", { tmuxManager: mockTmux });
    const spec: ArmSpec = {
      spec_version: 1,
      mission_id: "m",
      adapter_type: "pty_tmux",
      runtime_name: "bash",
      agent_id: "a",
      cwd: "/tmp",
      idempotency_key: "fallback-key",
      runtime_options: { command: "echo" },
    };

    const ref = await adapter.spawn(spec);

    expect(mockTmux.calls.length).toBe(1);
    // Falls back to idempotency_key for session name
    expect(mockTmux.calls[0]?.name).toBe("octo-arm-fallback-key");
    // No sentinel wrapper without _arm_id
    expect(mockTmux.calls[0]?.cmd).toBe("echo");
    expect(ref.session_id).toBe("octo-arm-fallback-key");
  });

  it("spawn propagates TmuxManager errors", async () => {
    class FailingTmux extends TmuxManager {
      override async createSession(): Promise<string> {
        throw new Error("tmux is broken");
      }
    }
    const adapter = createAdapter("pty_tmux", { tmuxManager: new FailingTmux() });
    const spec = makeArmSpec();

    await expect(adapter.spawn(spec)).rejects.toThrow("spawn failed");
  });
});
