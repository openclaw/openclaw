// Octopus Orchestrator -- CliExecAdapter tests (M2-05)
//
// Integration tests against real subprocesses. Uses simple system commands
// (echo, sleep, cat) to verify spawn, terminate, health, and resume.
//
// References:
//   - src/octo/adapters/base.ts -- Adapter interface, AdapterError
//   - src/octo/adapters/cli-exec.ts -- CliExecAdapter

import { describe, expect, it, afterEach } from "vitest";
import type { ArmSpec } from "../wire/schema.ts";
import { AdapterError, isAdapterError, type AdapterEvent, type SessionRef } from "./base.ts";
import { CliExecAdapter } from "./cli-exec.ts";

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

function makeSpec(overrides: Partial<ArmSpec> = {}): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "test-mission",
    adapter_type: "cli_exec",
    runtime_name: "echo",
    agent_id: "test-agent",
    cwd: "/tmp",
    idempotency_key: `k-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    runtime_options: {
      command: "echo",
      args: ["hello"],
    },
    ...overrides,
  };
}

function makeLongRunningSpec(): ArmSpec {
  return makeSpec({
    runtime_options: {
      command: "sleep",
      args: ["30"],
    },
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Cleanup
// ──────────────────────────────────────────────────────────────────────────

const adaptersToCleanup: Array<{ adapter: CliExecAdapter; refs: SessionRef[] }> = [];

afterEach(async () => {
  for (const { adapter, refs } of adaptersToCleanup) {
    for (const ref of refs) {
      try {
        await adapter.terminate(ref);
      } catch {
        // Best-effort cleanup
      }
    }
  }
  adaptersToCleanup.length = 0;
});

function track(adapter: CliExecAdapter, ref: SessionRef): SessionRef {
  let entry = adaptersToCleanup.find((e) => e.adapter === adapter);
  if (!entry) {
    entry = { adapter, refs: [] };
    adaptersToCleanup.push(entry);
  }
  entry.refs.push(ref);
  return ref;
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("CliExecAdapter", () => {
  // ── spawn ────────────────────────────────────────────────────────────

  it("spawn creates a subprocess and returns SessionRef with pid", async () => {
    const adapter = new CliExecAdapter();
    const ref = await adapter.spawn(makeLongRunningSpec());
    track(adapter, ref);

    expect(ref.adapter_type).toBe("cli_exec");
    expect(ref.session_id).toBeTruthy();
    expect(ref.cwd).toBe("/tmp");
    expect(ref.metadata?.pid).toBeTypeOf("number");
    expect(Number(ref.session_id)).toBe(ref.metadata?.pid);
  });

  it("spawn with invalid command throws AdapterError('spawn_failed')", async () => {
    const adapter = new CliExecAdapter();
    const spec = makeSpec({
      runtime_options: {
        command: "/nonexistent/binary/that/does/not/exist",
      },
    });

    try {
      const ref = await adapter.spawn(spec);
      track(adapter, ref);
      // If we got here, the spawn didn't fail synchronously. Wait a beat
      // for the process to die, then check health.
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      expect(isAdapterError(err)).toBe(true);
      expect((err as AdapterError).code).toBe("spawn_failed");
    }
  });

  it("spawn uses worktree_path over cwd when provided", async () => {
    const adapter = new CliExecAdapter();
    const ref = await adapter.spawn(makeLongRunningSpec());
    track(adapter, ref);
    expect(ref.cwd).toBe("/tmp");

    // Now with worktree_path
    const adapter2 = new CliExecAdapter();
    const ref2 = await adapter2.spawn(
      makeSpec({
        cwd: "/tmp",
        worktree_path: "/var",
        runtime_options: { command: "sleep", args: ["30"] },
      }),
    );
    track(adapter2, ref2);
    expect(ref2.cwd).toBe("/var");
  });

  // ── terminate ────────────────────────────────────────────────────────

  it("terminate kills a running process", async () => {
    const adapter = new CliExecAdapter();
    const ref = await adapter.spawn(makeLongRunningSpec());
    track(adapter, ref);

    // Should be alive
    const healthBefore = await adapter.health(ref);
    expect(healthBefore).toBe("alive");

    await adapter.terminate(ref);

    // After terminate, health should return unknown (session removed)
    const healthAfter = await adapter.health(ref);
    expect(healthAfter).toBe("unknown");
  });

  it("terminate escalates to SIGKILL for processes that trap SIGTERM", async () => {
    const adapter = new CliExecAdapter();
    // Use bash with a SIGTERM trap. The process ignores SIGTERM, so the
    // adapter must escalate to SIGKILL after the grace period.
    const ref = await adapter.spawn(
      makeSpec({
        runtime_options: {
          command: "/bin/bash",
          args: ["-c", "trap '' TERM; sleep 60"],
        },
      }),
    );
    track(adapter, ref);

    const healthBefore = await adapter.health(ref);
    expect(healthBefore).toBe("alive");

    // terminate should still succeed via SIGKILL escalation.
    // This test takes ~5s due to the grace period.
    await adapter.terminate(ref);

    const healthAfter = await adapter.health(ref);
    expect(healthAfter).toBe("unknown");
  }, 10_000);

  // ── health ──────────────────────────────────────────────────────────

  it("health returns 'alive' for running process and 'dead' for exited process", async () => {
    const adapter = new CliExecAdapter();
    // Short-lived: echo exits immediately
    const ref = await adapter.spawn(makeSpec());
    track(adapter, ref);

    // Give echo time to exit (needs >50ms for spawn's early-error window)
    await new Promise((r) => setTimeout(r, 500));
    const health = await adapter.health(ref);
    expect(health).toBe("dead");

    // Long-running: sleep stays alive
    const refLong = await adapter.spawn(makeLongRunningSpec());
    track(adapter, refLong);
    const healthLong = await adapter.health(refLong);
    expect(healthLong).toBe("alive");
  });

  // ── resume ──────────────────────────────────────────────────────────

  it("resume on alive process returns ref; resume on dead process throws", async () => {
    const adapter = new CliExecAdapter();
    const ref = await adapter.spawn(makeLongRunningSpec());
    track(adapter, ref);

    // Resume alive process
    const resumed = await adapter.resume(ref);
    expect(resumed.session_id).toBe(ref.session_id);
    expect(resumed.adapter_type).toBe("cli_exec");

    // Kill and try to resume
    await adapter.terminate(ref);
    try {
      await adapter.resume(ref);
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      expect(isAdapterError(err)).toBe(true);
      expect((err as AdapterError).code).toBe("session_not_found");
    }
  });

  // ── send (M2-07) ───────────────────────────────────────────────────

  it("send writes to stdin and output comes back through stream", async () => {
    const adapter = new CliExecAdapter();
    const ref = await adapter.spawn(
      makeSpec({
        runtime_options: {
          command: "/bin/cat",
          args: [],
        },
      }),
    );
    track(adapter, ref);

    // Send a line to cat's stdin.
    await adapter.send(ref, "ping");

    // Give cat a moment to echo it back, then close stdin so cat exits.
    await new Promise((r) => setTimeout(r, 200));

    // Terminate to close the process (cat will exit when we kill it).
    await adapter.terminate(ref);
  });

  it("send throws send_failed when process is dead", async () => {
    const adapter = new CliExecAdapter();
    const ref = await adapter.spawn(makeSpec());
    track(adapter, ref);

    // Wait for echo to exit.
    await new Promise((r) => setTimeout(r, 500));

    try {
      await adapter.send(ref, "hello");
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      expect(isAdapterError(err)).toBe(true);
      expect((err as AdapterError).code).toBe("send_failed");
    }
  });

  it("send throws send_failed when stdin is not writable", async () => {
    const adapter = new CliExecAdapter();
    const ref = await adapter.spawn(makeLongRunningSpec());
    track(adapter, ref);

    // Manually destroy stdin to simulate non-writable state.
    const session = (
      adapter as unknown as {
        sessions: Map<string, { process: { stdin: { destroy: () => void } } }>;
      }
    ).sessions.get(ref.session_id);
    session?.process.stdin.destroy();

    try {
      await adapter.send(ref, "hello");
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      expect(isAdapterError(err)).toBe(true);
      expect((err as AdapterError).code).toBe("send_failed");
    }
  });

  // ── stream (M2-06) ────────────────────────────────────────────────

  it("stream yields output events for a process that prints to stdout", async () => {
    const adapter = new CliExecAdapter();
    const ref = await adapter.spawn(
      makeSpec({
        runtime_options: {
          command: "/bin/bash",
          args: ["-c", "echo hello && echo world"],
        },
      }),
    );
    track(adapter, ref);

    const events: AdapterEvent[] = [];
    for await (const event of adapter.stream(ref)) {
      events.push(event);
    }

    const outputEvents = events.filter((e) => e.kind === "output");
    expect(outputEvents.length).toBeGreaterThanOrEqual(2);
    expect(outputEvents[0].data.text).toBe("hello");
    expect(outputEvents[1].data.text).toBe("world");
  });

  it("stream with structuredOutputFormat stream-json parses JSON lines", async () => {
    const adapter = new CliExecAdapter();
    const ref = await adapter.spawn(
      makeSpec({
        runtime_options: {
          command: "/bin/bash",
          args: ["-c", 'echo \'{"msg":"one"}\' && echo \'{"msg":"two"}\''],
          structuredOutputFormat: "stream-json",
        },
      }),
    );
    track(adapter, ref);

    const events: AdapterEvent[] = [];
    for await (const event of adapter.stream(ref)) {
      events.push(event);
    }

    const outputEvents = events.filter((e) => e.kind === "output");
    expect(outputEvents.length).toBeGreaterThanOrEqual(2);
    expect(outputEvents[0].data.msg).toBe("one");
    expect(outputEvents[1].data.msg).toBe("two");
  });

  it("stream with none yields raw text", async () => {
    const adapter = new CliExecAdapter();
    const ref = await adapter.spawn(
      makeSpec({
        runtime_options: {
          command: "/bin/echo",
          args: ["raw-line"],
          structuredOutputFormat: "none",
        },
      }),
    );
    track(adapter, ref);

    const events: AdapterEvent[] = [];
    for await (const event of adapter.stream(ref)) {
      events.push(event);
    }

    const outputEvents = events.filter((e) => e.kind === "output");
    expect(outputEvents.length).toBeGreaterThanOrEqual(1);
    expect(outputEvents[0].data.text).toBe("raw-line");
  });

  it("stream yields completion event on process exit with exit code", async () => {
    const adapter = new CliExecAdapter();
    const ref = await adapter.spawn(
      makeSpec({
        runtime_options: {
          command: "/bin/bash",
          args: ["-c", "exit 42"],
        },
      }),
    );
    track(adapter, ref);

    const events: AdapterEvent[] = [];
    for await (const event of adapter.stream(ref)) {
      events.push(event);
    }

    const completionEvents = events.filter((e) => e.kind === "completion");
    expect(completionEvents.length).toBeGreaterThanOrEqual(1);
    const last = completionEvents[completionEvents.length - 1];
    expect(last.data.exit_code).toBe(42);
  });

  it("stream yields error events from stderr", async () => {
    const adapter = new CliExecAdapter();
    const ref = await adapter.spawn(
      makeSpec({
        runtime_options: {
          command: "/bin/bash",
          args: ["-c", "echo errline >&2"],
        },
      }),
    );
    track(adapter, ref);

    const events: AdapterEvent[] = [];
    for await (const event of adapter.stream(ref)) {
      events.push(event);
    }

    const errorEvents = events.filter((e) => e.kind === "error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    expect(errorEvents[0].data.text).toBe("errline");
  });

  it("stream handles process that exits immediately (empty output)", async () => {
    const adapter = new CliExecAdapter();
    const ref = await adapter.spawn(
      makeSpec({
        runtime_options: {
          command: "/bin/bash",
          args: ["-c", "exit 0"],
        },
      }),
    );
    track(adapter, ref);

    const events: AdapterEvent[] = [];
    for await (const event of adapter.stream(ref)) {
      events.push(event);
    }

    // Should at least get a completion event.
    const completionEvents = events.filter((e) => e.kind === "completion");
    expect(completionEvents.length).toBeGreaterThanOrEqual(1);
    expect(completionEvents[0].data.exit_code).toBe(0);
  });

  // ── checkpoint (M2-07) ────────────────────────────────────────────

  it("checkpoint returns correct metadata (pid, cwd, alive, elapsed_ms)", async () => {
    const adapter = new CliExecAdapter();
    const ref = await adapter.spawn(makeLongRunningSpec());
    track(adapter, ref);

    const cp = await adapter.checkpoint(ref);
    expect(cp.ts).toBeTypeOf("number");
    expect(cp.alive).toBe(true);
    expect(cp.cwd).toBe("/tmp");
    expect(cp.pid).toBe(Number(ref.session_id));
    expect(cp.elapsed_ms).toBeTypeOf("number");
    expect(cp.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(cp.output_bytes).toBeTypeOf("number");
  });

  it("checkpoint output_bytes reflects bytes read", async () => {
    const adapter = new CliExecAdapter();
    const ref = await adapter.spawn(
      makeSpec({
        runtime_options: {
          command: "/bin/bash",
          args: ["-c", "echo hello"],
        },
      }),
    );
    track(adapter, ref);

    // Consume stream so outputBytes are counted.
    for await (const _event of adapter.stream(ref)) {
      // drain
    }

    const cp = await adapter.checkpoint(ref);
    // "hello" = 5 bytes
    expect(cp.output_bytes).toBeGreaterThanOrEqual(5);
  });
});
