// Octopus Orchestrator -- SubagentAdapter tests (M2-10)
//
// All tests use the mock bridge (no real OpenClaw internals needed).
//
// References:
//   - src/octo/adapters/subagent.ts — SubagentAdapter
//   - src/octo/adapters/openclaw/sessions-spawn.ts — SessionsSpawnBridge + mock factory

import { describe, expect, it } from "vitest";
import type { ArmSpec } from "../wire/schema.ts";
import { AdapterError, isAdapterError, type SessionRef } from "./base.ts";
import { createMockSessionsSpawnBridge } from "./openclaw/sessions-spawn.ts";
import { SubagentAdapter } from "./subagent.ts";

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

function makeArmSpec(overrides: Partial<ArmSpec> = {}): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "test-mission",
    adapter_type: "structured_subagent",
    runtime_name: "claude",
    agent_id: "agent-001",
    cwd: "/workspace",
    idempotency_key: "idem-001",
    runtime_options: {},
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("SubagentAdapter", () => {
  // ── 1. spawn calls bridge.spawn with correct params ────────────────────

  it("spawn calls bridge.spawn with correct params and returns SessionRef", async () => {
    const bridge = createMockSessionsSpawnBridge();
    const adapter = new SubagentAdapter(bridge);

    const spec = makeArmSpec({
      agent_id: "agent-alpha",
      runtime_name: "claude-runtime",
      runtime_options: { model: "opus-4" },
    });

    const ref = await adapter.spawn(spec);

    // Verify bridge was called with correct params
    expect(bridge.calls.spawn).toHaveLength(1);
    const spawnArgs = bridge.calls.spawn[0][0] as Record<string, unknown>;
    expect(spawnArgs.agentId).toBe("agent-alpha");
    expect(spawnArgs.runtime).toBe("claude-runtime");
    expect(spawnArgs.model).toBe("opus-4");
    expect(spawnArgs.deliver).toBe(false);

    // Verify returned SessionRef
    expect(ref.adapter_type).toBe("structured_subagent");
    expect(ref.session_id).toBe("sk-1");
    expect(ref.cwd).toBe("/workspace");
    expect(ref.metadata).toBeDefined();
    expect(ref.metadata?.sessionKey).toBe("sk-1");
    expect(ref.metadata?.runId).toBe("run-1");
  });

  // ── 2. resume on alive session returns ref ─────────────────────────────

  it("resume on alive session returns updated ref", async () => {
    const bridge = createMockSessionsSpawnBridge();
    const adapter = new SubagentAdapter(bridge);

    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);

    const resumed = await adapter.resume(ref);
    expect(resumed.session_id).toBe(ref.session_id);
    expect(resumed.adapter_type).toBe("structured_subagent");
    expect(resumed.metadata?.resumed).toBe(true);

    // Verify bridge.isAlive was called
    expect(bridge.calls.isAlive).toHaveLength(1);
  });

  // ── 3. resume on dead session throws session_not_found ─────────────────

  it("resume on dead session throws AdapterError session_not_found", async () => {
    const bridge = createMockSessionsSpawnBridge();
    const adapter = new SubagentAdapter(bridge);

    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);

    // Kill the session
    bridge.aliveMap.set(ref.session_id, false);

    try {
      await adapter.resume(ref);
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect(isAdapterError(err)).toBe(true);
      if (isAdapterError(err)) {
        expect(err.code).toBe("session_not_found");
      }
    }
  });

  // ── 4. terminate calls bridge.cancel ───────────────────────────────────

  it("terminate calls bridge.cancel with sessionKey", async () => {
    const bridge = createMockSessionsSpawnBridge();
    const adapter = new SubagentAdapter(bridge);

    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);

    await adapter.terminate(ref);

    expect(bridge.calls.cancel).toHaveLength(1);
    expect(bridge.calls.cancel[0][0]).toBe(ref.session_id);
  });

  // ── 5. health returns correct status via bridge.isAlive ────────────────

  it("health returns 'active' for alive and 'dead' for dead session", async () => {
    const bridge = createMockSessionsSpawnBridge();
    const adapter = new SubagentAdapter(bridge);

    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);

    const alive = await adapter.health(ref);
    expect(alive).toBe("active");

    bridge.aliveMap.set(ref.session_id, false);
    const dead = await adapter.health(ref);
    expect(dead).toBe("dead");
  });

  // ── 6. send throws not_supported ───────────────────────────────────────

  it("send throws AdapterError with code not_supported", async () => {
    const bridge = createMockSessionsSpawnBridge();
    const adapter = new SubagentAdapter(bridge);

    const ref: SessionRef = {
      adapter_type: "structured_subagent",
      session_id: "sk-test",
      cwd: "/workspace",
    };

    try {
      await adapter.send(ref, "hello");
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(AdapterError);
      if (err instanceof AdapterError) {
        expect(err.code).toBe("not_supported");
      }
    }
  });

  // ── 7. task_ref populated on SessionRef metadata ───────────────────────

  it("task_ref is populated from idempotency_key on SessionRef metadata", async () => {
    const bridge = createMockSessionsSpawnBridge();
    const adapter = new SubagentAdapter(bridge);

    const spec = makeArmSpec({ idempotency_key: "task-ref-42" });
    const ref = await adapter.spawn(spec);

    expect(ref.metadata?.task_ref).toBe("task-ref-42");
  });

  // ── 8. mock bridge tracks calls correctly ──────────────────────────────

  it("mock bridge tracks all call types correctly", async () => {
    const bridge = createMockSessionsSpawnBridge();
    const adapter = new SubagentAdapter(bridge);

    // spawn
    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);

    // health (calls isAlive)
    await adapter.health(ref);

    // checkpoint (calls isAlive + getHistory)
    await adapter.checkpoint(ref);

    // terminate (calls cancel)
    await adapter.terminate(ref);

    expect(bridge.calls.spawn).toHaveLength(1);
    expect(bridge.calls.isAlive).toHaveLength(2); // health + checkpoint
    expect(bridge.calls.getHistory).toHaveLength(1); // checkpoint
    expect(bridge.calls.cancel).toHaveLength(1); // terminate
  });

  // ── 9. stream yields output and completion events ──────────────────────

  it("stream yields output and completion events from bridge history", async () => {
    const bridge = createMockSessionsSpawnBridge();
    const adapter = new SubagentAdapter(bridge);

    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);

    const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
    for await (const event of adapter.stream(ref)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("output");
    expect(events[0].data.source).toBe("history");
    expect(events[1].kind).toBe("completion");
    expect(events[1].data.reason).toBe("history_snapshot");
  });

  // ── 10. checkpoint captures session state ──────────────────────────────

  it("checkpoint returns metadata with sessionKey and historyCursor", async () => {
    const bridge = createMockSessionsSpawnBridge();
    const adapter = new SubagentAdapter(bridge);

    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);

    const cp = await adapter.checkpoint(ref);

    expect(cp.ts).toBeGreaterThan(0);
    expect(cp.alive).toBe(true);
    expect(cp.cwd).toBe("/workspace");
    expect(cp.metadata?.sessionKey).toBe(ref.session_id);
    expect(cp.metadata?.historyCursor).toBe(0); // empty mock history
  });
});
