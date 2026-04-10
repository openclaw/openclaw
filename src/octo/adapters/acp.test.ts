// Octopus Orchestrator -- AcpAdapter tests (M2-11)
//
// All tests use the mock bridge from acpx-bridge.ts. No upstream
// dependencies, no network, no ACP runtime needed.
//
// References:
//   - src/octo/adapters/acp.ts — AcpAdapter
//   - src/octo/adapters/openclaw/acpx-bridge.ts — AcpxBridge, createMockAcpxBridge
//   - src/octo/adapters/base.ts — Adapter interface, AdapterError

import { describe, expect, it } from "vitest";
import type { ArmSpec } from "../wire/schema.ts";
import { AcpAdapter, type AcpAdapterLogger } from "./acp.ts";
import { AdapterError, isAdapterError } from "./base.ts";
import { createMockAcpxBridge } from "./openclaw/acpx-bridge.ts";

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

function makeArmSpec(overrides: Partial<ArmSpec> = {}): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "test-mission",
    adapter_type: "structured_acp",
    runtime_name: "acp",
    agent_id: "test-agent",
    cwd: "/tmp",
    idempotency_key: `idem-${Date.now()}`,
    runtime_options: {
      acpxHarness: "claude-code",
      model: "claude-sonnet-4-20250514",
    },
    ...overrides,
  };
}

function makeSilentLogger(): AcpAdapterLogger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    warn(message: string): void {
      warnings.push(message);
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("AcpAdapter", () => {
  // ── spawn ────────────────────────────────────────────────────────────

  it("spawn calls bridge.spawn with correct params", async () => {
    const bridge = createMockAcpxBridge();
    const logger = makeSilentLogger();
    const adapter = new AcpAdapter(bridge, logger);
    const spec = makeArmSpec({
      agent_id: "my-agent",
      runtime_options: {
        acpxHarness: "gemini-cli",
        model: "gemini-2.5-pro",
        mode: "session",
        permissions: "full",
      },
    });

    const ref = await adapter.spawn(spec);

    expect(bridge.calls.spawn).toHaveLength(1);
    const spawnArgs = bridge.calls.spawn[0]?.[0];
    expect(spawnArgs).toEqual({
      agentId: "my-agent",
      harness: "gemini-cli",
      model: "gemini-2.5-pro",
      mode: "session",
      permissions: "full",
    });

    expect(ref.adapter_type).toBe("structured_acp");
    expect(ref.session_id).toBe("acp-session-1");
    expect(ref.cwd).toBe("/tmp");
    expect(ref.metadata?.harness).toBe("gemini-cli");
  });

  it("spawn throws AdapterError on bridge failure", async () => {
    const bridge = createMockAcpxBridge();
    bridge.spawn = async () => {
      throw new Error("harness not found");
    };
    const adapter = new AcpAdapter(bridge, makeSilentLogger());

    try {
      await adapter.spawn(makeArmSpec());
      expect.fail("should have thrown");
    } catch (err) {
      expect(isAdapterError(err)).toBe(true);
      expect((err as AdapterError).code).toBe("spawn_failed");
    }
  });

  // ── send ─────────────────────────────────────────────────────────────

  it("send calls bridge.steer with session key and message", async () => {
    const bridge = createMockAcpxBridge();
    const adapter = new AcpAdapter(bridge, makeSilentLogger());
    const ref = await adapter.spawn(makeArmSpec());

    await adapter.send(ref, "hello world");

    expect(bridge.calls.steer).toHaveLength(1);
    expect(bridge.calls.steer[0]).toEqual([ref.session_id, "hello world"]);
  });

  // ── terminate ────────────────────────────────────────────────────────

  it("terminate calls bridge.close", async () => {
    const bridge = createMockAcpxBridge();
    const adapter = new AcpAdapter(bridge, makeSilentLogger());
    const ref = await adapter.spawn(makeArmSpec());

    await adapter.terminate(ref);

    expect(bridge.calls.close).toHaveLength(1);
    expect(bridge.calls.close[0]).toEqual([ref.session_id]);
  });

  // ── health ───────────────────────────────────────────────────────────

  it("health returns active/dead via bridge.isAlive", async () => {
    const bridge = createMockAcpxBridge();
    const adapter = new AcpAdapter(bridge, makeSilentLogger());
    const ref = await adapter.spawn(makeArmSpec());

    const healthBefore = await adapter.health(ref);
    expect(healthBefore).toBe("active");

    // Terminate makes isAlive return false
    await adapter.terminate(ref);
    const healthAfter = await adapter.health(ref);
    expect(healthAfter).toBe("dead");

    expect(bridge.calls.isAlive.length).toBeGreaterThanOrEqual(2);
  });

  // ── resume ───────────────────────────────────────────────────────────

  it("resume on alive session returns updated ref", async () => {
    const bridge = createMockAcpxBridge();
    const adapter = new AcpAdapter(bridge, makeSilentLogger());
    const ref = await adapter.spawn(makeArmSpec());

    const resumed = await adapter.resume(ref);

    expect(resumed.adapter_type).toBe("structured_acp");
    expect(resumed.session_id).toBe(ref.session_id);
    expect(resumed.metadata?.resumed).toBe(true);
  });

  it("resume on dead session throws AdapterError", async () => {
    const bridge = createMockAcpxBridge();
    const adapter = new AcpAdapter(bridge, makeSilentLogger());
    const ref = await adapter.spawn(makeArmSpec());

    // Kill the session
    await adapter.terminate(ref);

    try {
      await adapter.resume(ref);
      expect.fail("should have thrown");
    } catch (err) {
      expect(isAdapterError(err)).toBe(true);
      expect((err as AdapterError).code).toBe("session_not_found");
    }
  });

  // ── opt-in warning ───────────────────────────────────────────────────

  it("spawn logs OCTO-DEC-036 opt-in warning", async () => {
    const bridge = createMockAcpxBridge();
    const logger = makeSilentLogger();
    const adapter = new AcpAdapter(bridge, logger);

    await adapter.spawn(makeArmSpec({ agent_id: "special-agent" }));

    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain("OCTO-DEC-036");
    expect(logger.warnings[0]).toContain("special-agent");
    expect(logger.warnings[0]).toContain("opt-in only");
  });

  // ── mock bridge tracks calls ─────────────────────────────────────────

  it("mock bridge tracks all call categories", async () => {
    const bridge = createMockAcpxBridge();
    const adapter = new AcpAdapter(bridge, makeSilentLogger());

    const ref = await adapter.spawn(makeArmSpec());
    await adapter.send(ref, "msg");
    await adapter.health(ref);
    await adapter.terminate(ref);

    expect(bridge.calls.spawn).toHaveLength(1);
    expect(bridge.calls.steer).toHaveLength(1);
    expect(bridge.calls.isAlive).toHaveLength(1); // health check
    expect(bridge.calls.close).toHaveLength(1);
  });

  // ── checkpoint ───────────────────────────────────────────────────────

  it("checkpoint returns session metadata", async () => {
    const bridge = createMockAcpxBridge();
    const adapter = new AcpAdapter(bridge, makeSilentLogger());
    const ref = await adapter.spawn(makeArmSpec({ agent_id: "cp-agent" }));

    const cp = await adapter.checkpoint(ref);

    expect(cp.alive).toBe(true);
    expect(cp.cwd).toBe("/tmp");
    expect(cp.ts).toBeGreaterThan(0);
    expect(cp.elapsed_ms).toBeDefined();
    expect(cp.metadata?.agent_id).toBe("cp-agent");
  });
});
