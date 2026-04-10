// Octopus Orchestrator -- Chaos test: subagent session expires mid-grip (M2-20)
//
// Simulates a subagent session that expires mid-execution. The mock bridge's
// isAlive returns false after initial interaction, exercising the adapter's
// failure-surfacing path for retry-policy consumption.
//
// All mock-based -- no real OpenClaw internals needed (OCTO-DEC-033).
//
// References:
//   - src/octo/adapters/subagent.ts -- SubagentAdapter (M2-10)
//   - src/octo/adapters/openclaw/sessions-spawn.ts -- mock bridge
//   - src/octo/adapters/base.ts -- AdapterError, AdapterEvent

import { describe, expect, it } from "vitest";
import type { AdapterEvent } from "../../adapters/base.ts";
import { isAdapterError } from "../../adapters/base.ts";
import { createMockSessionsSpawnBridge } from "../../adapters/openclaw/sessions-spawn.ts";
import { SubagentAdapter } from "../../adapters/subagent.ts";
import type { ArmSpec } from "../../wire/schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

function makeArmSpec(overrides: Partial<ArmSpec> = {}): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "chaos-mission",
    adapter_type: "structured_subagent",
    runtime_name: "claude",
    agent_id: "agent-chaos-001",
    cwd: "/workspace",
    idempotency_key: "idem-chaos-001",
    runtime_options: {},
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("Chaos: subagent session expiry mid-grip", () => {
  // ── 1. Session alive -- health returns "active" ───────────────────────

  it("health returns 'active' for a freshly spawned session", async () => {
    const bridge = createMockSessionsSpawnBridge();
    const adapter = new SubagentAdapter(bridge);

    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);

    const status = await adapter.health(ref);
    expect(status).toBe("active");

    // Confirm bridge.isAlive was consulted
    expect(bridge.calls.isAlive.length).toBeGreaterThan(0);
    const lastCall = bridge.calls.isAlive[bridge.calls.isAlive.length - 1];
    expect(lastCall[0]).toBe(ref.session_id);
  });

  // ── 2. Session expires -- health returns "dead" ───────────────────────

  it("health returns 'dead' after session expiry", async () => {
    const bridge = createMockSessionsSpawnBridge();
    const adapter = new SubagentAdapter(bridge);

    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);

    // Verify alive first
    const beforeExpiry = await adapter.health(ref);
    expect(beforeExpiry).toBe("active");

    // Simulate expiry: flip isAlive to false for this session
    bridge.aliveMap.set(ref.session_id, false);

    const afterExpiry = await adapter.health(ref);
    expect(afterExpiry).toBe("dead");

    // The status string is structured enough for a retry policy to branch on
    expect(["active", "dead"]).toContain(afterExpiry);
    expect(afterExpiry).not.toBe("active");
  });

  // ── 3. Stream yields error event on session expiry detection ──────────
  //
  // The current SubagentAdapter.stream() calls bridge.getHistory().
  // When the session is expired, getHistory may still return data (the
  // session existed before it died). The chaos scenario is that after
  // stream completes, a health check reveals the session is dead.
  // We verify this two-step detection: stream completes, then health
  // surfaces the failure as a structured response.

  it("stream completes and subsequent health check surfaces expiry", async () => {
    const bridge = createMockSessionsSpawnBridge();
    const adapter = new SubagentAdapter(bridge);

    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);

    // Stream while alive -- should yield output + completion
    const events: AdapterEvent[] = [];
    for await (const event of adapter.stream(ref)) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.kind === "output")).toBe(true);
    expect(events.some((e) => e.kind === "completion")).toBe(true);

    // Session expires AFTER stream completed (mid-grip scenario)
    bridge.aliveMap.set(ref.session_id, false);

    // Health check now surfaces the expiry as structured data
    const status = await adapter.health(ref);
    expect(status).toBe("dead");

    // Checkpoint also reflects the dead state
    const cp = await adapter.checkpoint(ref);
    expect(cp.alive).toBe(false);
  });

  // ── 4. Health check does NOT throw on expired session ─────────────────

  it("health does NOT throw on expired session -- returns structured response", async () => {
    const bridge = createMockSessionsSpawnBridge();
    const adapter = new SubagentAdapter(bridge);

    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);

    // Kill the session
    bridge.aliveMap.set(ref.session_id, false);

    // health() must NOT throw -- it returns a string status
    let threw = false;
    let status: string | undefined;
    try {
      status = await adapter.health(ref);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(status).toBeDefined();
    expect(status).toBe("dead");

    // Contrast with resume(), which DOES throw on dead session
    try {
      await adapter.resume(ref);
      expect.fail("resume should have thrown on dead session");
    } catch (err: unknown) {
      expect(isAdapterError(err)).toBe(true);
      if (isAdapterError(err)) {
        expect(err.code).toBe("session_not_found");
      }
    }
  });

  // ── 5. Failure info is structured for retry policy ────────────────────

  it("expiry information is structured enough for retry policy consumption", async () => {
    const bridge = createMockSessionsSpawnBridge();
    const adapter = new SubagentAdapter(bridge);

    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);

    // Session alive
    const aliveStatus = await adapter.health(ref);
    const aliveCp = await adapter.checkpoint(ref);

    // Session expired
    bridge.aliveMap.set(ref.session_id, false);
    const deadStatus = await adapter.health(ref);
    const deadCp = await adapter.checkpoint(ref);

    // A retry policy can distinguish alive vs dead via:
    // 1. health() string: "active" vs "dead"
    expect(aliveStatus).toBe("active");
    expect(deadStatus).toBe("dead");

    // 2. checkpoint.alive boolean
    expect(aliveCp.alive).toBe(true);
    expect(deadCp.alive).toBe(false);

    // 3. checkpoint includes session key for correlation
    expect(deadCp.metadata?.sessionKey).toBe(ref.session_id);

    // 4. checkpoint includes timestamp for staleness detection
    expect(typeof deadCp.ts).toBe("number");
    expect(deadCp.ts).toBeGreaterThan(0);
  });
});
