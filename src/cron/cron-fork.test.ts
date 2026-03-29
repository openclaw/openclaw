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
// §1  sessionTarget 'session' — normalization (fef35b8c4)
// ---------------------------------------------------------------------------
describe("cron fork: sessionTarget 'session' normalization", () => {
  it("normalizes string 'session' as sessionTarget", () => {
    const result = normalizeCronJobInput({
      sessionTarget: "session",
      sessionKey: "agent:main:discord:channel:123",
      schedule: { kind: "at", at: "2026-03-10T00:00:00Z" },
      payload: { kind: "systemEvent", text: "hello" },
    });
    expect(result).not.toBeNull();
    expect(result!.sessionTarget).toBe("session");
    expect(result!.sessionKey).toBe("agent:main:discord:channel:123");
  });

  it("normalizes object form { kind: 'session', key } and extracts key", () => {
    const result = normalizeCronJobInput({
      sessionTarget: { kind: "session", key: "agent:main:discord:channel:456" },
      schedule: { kind: "at", at: "2026-03-10T00:00:00Z" },
      payload: { kind: "systemEvent", text: "reminder" },
    });
    expect(result).not.toBeNull();
    expect(result!.sessionTarget).toBe("session");
    expect(result!.sessionKey).toBe("agent:main:discord:channel:456");
  });

  it("object form key overrides explicit sessionKey", () => {
    const result = normalizeCronJobInput({
      sessionTarget: { kind: "session", key: "from-object" },
      sessionKey: "from-top-level",
      schedule: { kind: "at", at: "2026-03-10T00:00:00Z" },
      payload: { kind: "systemEvent", text: "test" },
    });
    expect(result!.sessionKey).toBe("from-object");
  });

  it("rejects object form with empty key", () => {
    const result = normalizeCronJobInput({
      sessionTarget: { kind: "session", key: "  " },
      schedule: { kind: "at", at: "2026-03-10T00:00:00Z" },
      payload: { kind: "systemEvent", text: "test" },
    });
    // Empty key → normalizeSessionTarget returns undefined → sessionTarget stripped
    expect(result!.sessionTarget).toBeUndefined();
  });

  it("rejects object form with non-session kind", () => {
    const result = normalizeCronJobInput({
      sessionTarget: { kind: "main", key: "some-key" },
      schedule: { kind: "at", at: "2026-03-10T00:00:00Z" },
      payload: { kind: "systemEvent", text: "test" },
    });
    expect(result!.sessionTarget).toBeUndefined();
  });

  it("normalizeCronJobCreate does not auto-infer sessionTarget for 'session'", () => {
    // 'session' must be explicit — auto-inference only covers main/isolated
    const result = normalizeCronJobCreate({
      sessionTarget: "session",
      sessionKey: "agent:main:discord:channel:789",
      schedule: { kind: "at", at: "2026-03-10T00:00:00Z" },
      payload: { kind: "systemEvent", text: "test" },
    });
    expect(result!.sessionTarget).toBe("session");
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
      sessionTarget: "session",
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

  it("skips when sessionKey is missing", async () => {
    const state = makeState();
    const job = makeJob({ sessionKey: undefined });
    const result = await executeJobCore(state, job);

    expect(result.status).toBe("skipped");
    expect(result.error).toContain("sessionKey");
  });

  it("skips when text is empty", async () => {
    const state = makeState();
    const job = makeJob({
      payload: { kind: "systemEvent", text: "" } as unknown as CronJob["payload"],
    });
    const result = await executeJobCore(state, job);

    expect(result.status).toBe("skipped");
    expect(result.error).toContain("non-empty");
  });

  it("skips for agentTurn payload (session requires systemEvent)", async () => {
    const state = makeState();
    const job = makeJob({
      payload: { kind: "agentTurn", message: "do stuff" } as unknown as CronJob["payload"],
    });
    const result = await executeJobCore(state, job);

    expect(result.status).toBe("skipped");
    expect(result.error).toContain("non-empty");
  });
});

// ---------------------------------------------------------------------------
// §3  Routing whitelist — EXTERNAL_CHANNEL_NAMES (4670cde81)
// ---------------------------------------------------------------------------
describe("cron fork: routing whitelist", () => {
  // Import the set directly to verify membership
  it("EXTERNAL_CHANNEL_NAMES includes all deliverable channels", async () => {
    const { EXTERNAL_CHANNEL_NAMES } = await import("../auto-reply/reply/agent-runner-helpers.js");
    const expected = [
      "discord",
      "telegram",
      "whatsapp",
      "signal",
      "slack",
      "irc",
      "googlechat",
      "imessage",
      "bluebubbles",
    ];
    for (const ch of expected) {
      expect(EXTERNAL_CHANNEL_NAMES.has(ch)).toBe(true);
    }
  });

  it("EXTERNAL_CHANNEL_NAMES excludes internal/synthetic providers", async () => {
    const { EXTERNAL_CHANNEL_NAMES } = await import("../auto-reply/reply/agent-runner-helpers.js");
    const internal = ["webchat", "heartbeat", "cron-event", "system", "exec-event", "main"];
    for (const p of internal) {
      expect(EXTERNAL_CHANNEL_NAMES.has(p)).toBe(false);
    }
  });

  it("webchat provider does not corrupt lastTo (integration scenario)", async () => {
    // This is the core regression: inter-session messages set Provider='webchat'.
    // Before the whitelist fix, webchat wasn't in INTERNAL_PROVIDER_NAMES,
    // so it was treated as external and overwrote lastTo with a synthetic value.
    //
    // We test the logic by checking the set membership — the full initSessionState
    // integration test exists in session.test.ts. This verifies the guard holds.
    const { EXTERNAL_CHANNEL_NAMES, INTERNAL_PROVIDER_NAMES } =
      await import("../auto-reply/reply/agent-runner-helpers.js");

    // webchat is NOT in external channels → won't update routing
    expect(EXTERNAL_CHANNEL_NAMES.has("webchat")).toBe(false);

    // But webchat was also NOT in internal providers (the old bug)
    // Verify the old approach would have missed it:
    expect(INTERNAL_PROVIDER_NAMES.has("webchat")).toBe(false);

    // The whitelist approach catches it because it's not in the allowlist
    // This is the fix: we flipped from blacklist to whitelist
  });
});
