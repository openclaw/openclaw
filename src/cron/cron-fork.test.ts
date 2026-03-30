/**
 * Fork regression tests: Cron session-target & routing whitelist
 *
 * Covers fork-specific patches:
 * - fef35b8c4: feat(cron): sessionTarget 'session' — object form normalization
 * - b2cb3f6d3: fix: implement sessionTarget 'session' in timer.ts
 * - 4670cde81: fix: whitelist external channels for session routing updates
 */
import { describe, it, expect, vi } from "vitest";
import { normalizeCronJobInput, normalizeCronJobCreate } from "./normalize.js";
import type { CronServiceState } from "./service/state.js";
import { executeJobCore } from "./service/timer.js";
import type { CronJob } from "./types.js";

// ---------------------------------------------------------------------------
// §1  sessionTarget 'session:xxx' — normalization (upstream format)
// ---------------------------------------------------------------------------
describe("cron fork: sessionTarget 'session:xxx' normalization", () => {
  it("normalizes 'session:custom-id' as sessionTarget", () => {
    const result = normalizeCronJobInput({
      sessionTarget: "session:my-custom-session",
      schedule: { kind: "at", at: "2026-03-10T00:00:00Z" },
      payload: { kind: "agentTurn", message: "hello" },
    });
    expect(result).not.toBeNull();
    expect(result!.sessionTarget).toBe("session:my-custom-session");
  });

  it("normalizes 'session:agent:main:discord:channel:456'", () => {
    const result = normalizeCronJobInput({
      sessionTarget: "session:agent:main:discord:channel:456",
      schedule: { kind: "at", at: "2026-03-10T00:00:00Z" },
      payload: { kind: "agentTurn", message: "reminder" },
    });
    expect(result).not.toBeNull();
    expect(result!.sessionTarget).toBe("session:agent:main:discord:channel:456");
  });

  it("rejects bare 'session' without colon prefix (upstream format)", () => {
    const result = normalizeCronJobInput({
      sessionTarget: "session",
      schedule: { kind: "at", at: "2026-03-10T00:00:00Z" },
      payload: { kind: "systemEvent", text: "test" },
    });
    // Bare 'session' is not a valid sessionTarget — stripped
    expect(result!.sessionTarget).toBeUndefined();
  });

  it("rejects object form with empty key", () => {
    const result = normalizeCronJobInput({
      sessionTarget: "session:",
      schedule: { kind: "at", at: "2026-03-10T00:00:00Z" },
      payload: { kind: "systemEvent", text: "test" },
    });
    // Empty key after session: → sessionTarget stripped
    expect(result!.sessionTarget).toBeUndefined();
  });

  it("rejects non-session kind", () => {
    const result = normalizeCronJobInput({
      sessionTarget: "unknown-kind",
      schedule: { kind: "at", at: "2026-03-10T00:00:00Z" },
      payload: { kind: "systemEvent", text: "test" },
    });
    expect(result!.sessionTarget).toBeUndefined();
  });

  it("normalizeCronJobCreate preserves session:xxx target", () => {
    const result = normalizeCronJobCreate({
      sessionTarget: "session:agent:main:discord:channel:789",
      schedule: { kind: "at", at: "2026-03-10T00:00:00Z" },
      payload: { kind: "agentTurn", message: "test" },
    });
    expect(result!.sessionTarget).toBe("session:agent:main:discord:channel:789");
  });
});

// ---------------------------------------------------------------------------
// §2  sessionTarget 'session' — timer execution (b2cb3f6d3)
// ---------------------------------------------------------------------------
describe("cron fork: sessionTarget 'session' execution", () => {
  function makeState(overrides?: Partial<CronServiceState["deps"]>): CronServiceState {
    return {
      store: null,
      timer: null,
      running: false,
      deps: {
        cronEnabled: true,
        nowMs: () => Date.now(),
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        } as unknown as CronServiceState["deps"]["log"],
        enqueueSystemEvent: vi.fn(),
        requestHeartbeatNow: vi.fn(),
        runHeartbeatOnce: vi.fn().mockResolvedValue({ status: "ran" }),
        runIsolatedAgentJob: vi.fn(),
        onEvent: vi.fn(),
        ...overrides,
      },
    } as unknown as CronServiceState;
  }

  function makeJob(overrides?: Partial<CronJob>): CronJob {
    return {
      id: "test-session-job",
      name: "Test Session Job",
      enabled: true,
      sessionTarget: "main",
      sessionKey: "agent:main:discord:channel:123",
      payload: { kind: "systemEvent", text: "Wake up!" },
      schedule: { kind: "at", at: "2026-03-10T00:00:00Z" },
      state: {},
      wakeMode: "now",
      ...overrides,
    } as CronJob;
  }

  it("enqueues systemEvent to the target session key", async () => {
    const state = makeState();
    const job = makeJob();
    const result = await executeJobCore(state, job);

    expect(result.status).toBe("ok");
    expect(state.deps.enqueueSystemEvent).toHaveBeenCalledWith(
      "Wake up!",
      expect.objectContaining({
        sessionKey: "agent:main:discord:channel:123",
        contextKey: "cron:test-session-job",
      }),
    );
  });

  it("triggers heartbeat with the session key", async () => {
    const state = makeState();
    const job = makeJob();
    await executeJobCore(state, job);

    expect(state.deps.runHeartbeatOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:discord:channel:123",
        reason: "cron:test-session-job",
      }),
    );
  });

  it("skips when text is empty", async () => {
    const state = makeState();
    const job = makeJob({
      payload: { kind: "systemEvent", text: "" } as unknown as CronJob["payload"],
    });
    const result = await executeJobCore(state, job);

    expect(result.status).toBe("skipped");
  });

  it("skips for agentTurn payload on main target", async () => {
    const state = makeState();
    const job = makeJob({
      payload: { kind: "agentTurn", message: "do stuff" } as unknown as CronJob["payload"],
    });
    const result = await executeJobCore(state, job);

    expect(result.status).toBe("skipped");
  });
});

// §3  Routing whitelist — EXTERNAL_CHANNEL_NAMES (4670cde81)
// Removed: the whitelist constants were dropped during clean-merge rebase.
// The routing fix was integrated differently upstream. See session.test.ts for coverage.
