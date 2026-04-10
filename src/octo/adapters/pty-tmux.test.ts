// Octopus Orchestrator -- PtyTmuxAdapter tests (M2-09)
//
// Integration tests against real tmux sessions. Every test creates
// sessions with a unique per-run prefix and cleans them up in afterEach.
//
// Prerequisites: tmux must be installed on the host.
//
// References:
//   - src/octo/adapters/base.ts — Adapter interface
//   - src/octo/node-agent/tmux-manager.ts — TmuxManager API

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TmuxManager } from "../node-agent/tmux-manager.ts";
import type { ArmSpec } from "../wire/schema.ts";
import { AdapterError, isAdapterError, type SessionRef } from "./base.ts";
import { PtyTmuxAdapter } from "./pty-tmux.ts";

// ──────────────────────────────────────────────────────────────────────────
// Skip if tmux is not available
// ──────────────────────────────────────────────────────────────────────────

const TMUX_AVAILABLE = TmuxManager.isAvailable();

// ──────────────────────────────────────────────────────────────────────────
// Per-run prefix for session isolation
// ──────────────────────────────────────────────────────────────────────────

const RUN_ID = `t${Date.now().toString(36)}`;
let sessionCounter = 0;

function uniqueArmId(): string {
  sessionCounter++;
  return `${RUN_ID}-${sessionCounter}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

function makeArmSpec(overrides: Partial<ArmSpec> = {}): ArmSpec {
  const armId = uniqueArmId();
  return {
    spec_version: 1,
    mission_id: "test-mission",
    adapter_type: "pty_tmux",
    runtime_name: "bash",
    agent_id: "test-agent",
    cwd: "/tmp",
    idempotency_key: armId,
    runtime_options: {
      command: "/bin/bash",
    },
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Cleanup tracking
// ──────────────────────────────────────────────────────────────────────────

const createdSessions: string[] = [];
const tmuxManager = new TmuxManager();
const adapter = new PtyTmuxAdapter(tmuxManager, {
  captureIntervalMs: 100,
});

async function cleanupSessions(): Promise<void> {
  for (const name of createdSessions) {
    try {
      await tmuxManager.killSession(name);
    } catch {
      // Already dead — fine
    }
  }
  createdSessions.length = 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe.skipIf(!TMUX_AVAILABLE)("PtyTmuxAdapter", () => {
  beforeAll(() => {
    // Sanity check
    expect(TMUX_AVAILABLE).toBe(true);
  });

  afterEach(async () => {
    await cleanupSessions();
  });

  // ── 1. spawn creates a tmux session and returns SessionRef ────────────

  it("spawn creates a tmux session and returns SessionRef", async () => {
    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);
    createdSessions.push(ref.session_id);

    expect(ref.adapter_type).toBe("pty_tmux");
    expect(ref.session_id).toContain("octo-arm-");
    expect(ref.cwd).toBe("/tmp");
    expect(ref.attach_command).toBe(`tmux attach -t ${ref.session_id}`);

    // Verify session actually exists
    const sessions = await tmuxManager.listSessions();
    expect(sessions).toContain(ref.session_id);
  });

  // ── 2. resume on existing session returns updated ref ─────────────────

  it("resume on existing session returns updated ref", async () => {
    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);
    createdSessions.push(ref.session_id);

    const resumed = await adapter.resume(ref);
    expect(resumed.session_id).toBe(ref.session_id);
    expect(resumed.adapter_type).toBe("pty_tmux");
    expect(resumed.attach_command).toBe(`tmux attach -t ${ref.session_id}`);
    expect(resumed.metadata).toHaveProperty("resumed", true);
  });

  // ── 3. resume on missing session throws session_not_found ─────────────

  it("resume on missing session throws AdapterError", async () => {
    const fakeRef: SessionRef = {
      adapter_type: "pty_tmux",
      session_id: `octo-arm-${uniqueArmId()}-nonexistent`,
      cwd: "/tmp",
    };
    try {
      await adapter.resume(fakeRef);
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect(isAdapterError(err)).toBe(true);
      if (isAdapterError(err)) {
        expect(err.code).toBe("session_not_found");
      }
    }
  });

  // ── 4. send delivers text to the pane ─────────────────────────────────

  it("send delivers text to the pane (verify via capture-pane)", async () => {
    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);
    createdSessions.push(ref.session_id);

    // Wait for shell to initialize
    await sleep(300);

    // Send an echo command
    const marker = `MARKER_${RUN_ID}`;
    await adapter.send(ref, `echo ${marker}`);

    // Wait for the command to execute
    await sleep(500);

    // Capture pane output and verify marker appears
    const { execFile: execFileCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFileCb);
    const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-t", ref.session_id]);
    expect(stdout).toContain(marker);
  });

  // ── 5. stream yields output chunks ────────────────────────────────────

  it("stream yields output chunks as the session produces output", async () => {
    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);
    createdSessions.push(ref.session_id);

    const ac = new AbortController();
    const events: Array<{ kind: string; data: Record<string, unknown> }> = [];

    // Start streaming
    const streamPromise = (async () => {
      for await (const event of adapter.stream(ref, ac.signal)) {
        events.push(event);
        if (events.length >= 2) {
          ac.abort();
        }
      }
    })();

    // Wait for shell init, then send a command
    await sleep(200);
    const marker = `STREAM_${RUN_ID}`;
    await adapter.send(ref, `echo ${marker}`);

    // Wait for stream to collect events then abort
    await sleep(800);
    if (!ac.signal.aborted) {
      ac.abort();
    }
    await streamPromise;

    // At least one output event should exist
    const outputEvents = events.filter((e) => e.kind === "output");
    expect(outputEvents.length).toBeGreaterThanOrEqual(1);
    expect(outputEvents[0].data).toHaveProperty("text");
    expect(outputEvents[0].data).toHaveProperty("bytes");
  });

  // ── 6. checkpoint captures expected metadata ──────────────────────────

  it("checkpoint captures expected metadata", async () => {
    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);
    createdSessions.push(ref.session_id);

    await sleep(200);

    const cp = await adapter.checkpoint(ref);
    expect(cp.alive).toBe(true);
    expect(cp.ts).toBeGreaterThan(0);
    expect(cp.metadata).toHaveProperty("session_name", ref.session_id);
    expect(typeof cp.elapsed_ms).toBe("number");
    expect(cp.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(typeof cp.output_bytes).toBe("number");
  });

  // ── 7. terminate kills the session ────────────────────────────────────

  it("terminate kills the session", async () => {
    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);
    // Do NOT push to createdSessions — terminate does the cleanup

    await adapter.terminate(ref);

    const sessions = await tmuxManager.listSessions();
    expect(sessions).not.toContain(ref.session_id);
  });

  // ── 8. health returns correct status ──────────────────────────────────

  it("health returns 'active' for alive session and 'dead' for dead session", async () => {
    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);
    createdSessions.push(ref.session_id);

    const aliveStatus = await adapter.health(ref);
    expect(aliveStatus).toBe("active");

    // Kill the session and check again
    await tmuxManager.killSession(ref.session_id);
    createdSessions.length = 0; // Already killed

    const deadStatus = await adapter.health(ref);
    expect(deadStatus).toBe("dead");
  });

  // ── 9. send_keys extension sends raw key sequences ────────────────────

  it("send_keys extension sends raw key sequences", async () => {
    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);
    createdSessions.push(ref.session_id);

    await sleep(300);

    // Type "echo HI" via send_keys (character by character is not needed,
    // tmux send-keys accepts a string), then send Enter as a separate key.
    const marker = `SENDKEYS_${RUN_ID}`;
    await adapter.send_keys(ref, [`echo ${marker}`, "Enter"]);

    await sleep(500);

    const { execFile: execFileCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFileCb);
    const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-t", ref.session_id]);
    expect(stdout).toContain(marker);
  });

  // ── 10. spawn with custom tmuxSessionName uses it ─────────────────────

  it("spawn with custom tmuxSessionName uses it", async () => {
    const customName = `custom-${RUN_ID}`;
    const spec = makeArmSpec({
      runtime_options: {
        command: "/bin/bash",
        tmuxSessionName: customName,
      },
    });

    const ref = await adapter.spawn(spec);
    createdSessions.push(ref.session_id);

    expect(ref.session_id).toBe(customName);

    const sessions = await tmuxManager.listSessions();
    expect(sessions).toContain(customName);
  });

  // ── 11. spawn failure throws AdapterError ─────────────────────────────

  it("spawn with invalid cwd throws AdapterError", async () => {
    const spec = makeArmSpec({ cwd: "/nonexistent/path/that/does/not/exist" });
    try {
      await adapter.spawn(spec);
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(AdapterError);
      if (err instanceof AdapterError) {
        expect(err.code).toBe("spawn_failed");
      }
    }
  });

  // ── 12. stream emits completion when session dies ─────────────────────

  it("stream emits completion event when session dies", async () => {
    const spec = makeArmSpec();
    const ref = await adapter.spawn(spec);
    // We kill it during the test, no need to track for cleanup

    const events: Array<{ kind: string }> = [];

    const streamPromise = (async () => {
      for await (const event of adapter.stream(ref)) {
        events.push(event);
        if (event.kind === "completion") {
          break;
        }
      }
    })();

    // Let stream start polling
    await sleep(200);

    // Kill the session
    await tmuxManager.killSession(ref.session_id);

    // Wait for stream to detect death
    await streamPromise;

    const completionEvents = events.filter((e) => e.kind === "completion");
    expect(completionEvents.length).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
