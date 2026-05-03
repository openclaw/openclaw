import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetDiscordStuckSessionCircuitBreakerForTest,
  scheduleDiscordStuckSessionCircuitBreaker,
} from "./circuit-breaker.js";
import { enqueueFollowupRun } from "./enqueue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./state.js";
import type { FollowupRun, QueueSettings } from "./types.js";

const settings: QueueSettings = {
  mode: "followup",
  debounceMs: 0,
  cap: 20,
  dropPolicy: "summarize",
};

function makeRun(overrides: Partial<FollowupRun> = {}): FollowupRun {
  return {
    prompt: "queued user message",
    enqueuedAt: Date.now(),
    originatingChannel: "discord",
    originatingTo: "channel:123",
    run: {
      agentId: "rex",
      agentDir: "/tmp/agent",
      sessionId: "session-1",
      sessionKey: "agent:rex:discord:channel:123",
      messageProvider: "discord",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      provider: "openai-codex",
      model: "gpt-5.4",
      timeoutMs: 1000,
      blockReplyBreak: "message_end",
    },
    ...overrides,
  };
}

describe("scheduleDiscordStuckSessionCircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetDiscordStuckSessionCircuitBreakerForTest();
    clearFollowupQueue("agent:rex:discord:channel:123");
    clearFollowupQueue("agent:rex:telegram:channel:123");
    vi.useRealTimers();
  });

  it("aborts a non-streaming stuck Discord run and drains a recovery notice before queued messages", async () => {
    const queueKey = "agent:rex:discord:channel:123";
    const run = makeRun({ enqueuedAt: Date.now() - 10_000 });
    const calls: string[] = [];
    const runFollowup = vi.fn(async (item: FollowupRun) => {
      calls.push(item.prompt);
      clearFollowupQueue(queueKey);
    });
    const abortActiveRun = vi.fn(() => true);

    expect(enqueueFollowupRun(queueKey, run, settings, "none", runFollowup, false)).toBe(true);
    scheduleDiscordStuckSessionCircuitBreaker({
      queueKey,
      followupRun: run,
      runFollowup,
      resolveActiveRunSessionId: () => "active-session",
      isRunActive: () => true,
      isRunStreaming: () => false,
      abortActiveRun,
      scheduleDrain: (key, cb) => cb(getExistingFollowupQueue(key)!.items.shift()!),
      thresholdMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(abortActiveRun).toHaveBeenCalledWith("active-session");
    expect(calls[0]).toContain("previous Discord turn appears stuck");
  });

  it("does not abort active streaming Discord runs", async () => {
    const queueKey = "agent:rex:discord:channel:123";
    const run = makeRun({ enqueuedAt: Date.now() - 10_000 });
    const abortActiveRun = vi.fn(() => true);

    enqueueFollowupRun(queueKey, run, settings, "none", async () => undefined, false);
    scheduleDiscordStuckSessionCircuitBreaker({
      queueKey,
      followupRun: run,
      runFollowup: async () => undefined,
      resolveActiveRunSessionId: () => "active-session",
      isRunActive: () => true,
      isRunStreaming: () => true,
      abortActiveRun,
      scheduleDrain: vi.fn(),
      thresholdMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(abortActiveRun).not.toHaveBeenCalled();
  });

  it("ignores non-Discord queues", async () => {
    const queueKey = "agent:rex:telegram:channel:123";
    const run = makeRun({
      originatingChannel: "telegram",
      run: { ...makeRun().run, messageProvider: "telegram" },
    });
    const abortActiveRun = vi.fn(() => true);

    enqueueFollowupRun(queueKey, run, settings, "none", async () => undefined, false);
    scheduleDiscordStuckSessionCircuitBreaker({
      queueKey,
      followupRun: run,
      runFollowup: async () => undefined,
      resolveActiveRunSessionId: () => "active-session",
      isRunActive: () => true,
      isRunStreaming: () => false,
      abortActiveRun,
      scheduleDrain: vi.fn(),
      thresholdMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(abortActiveRun).not.toHaveBeenCalled();
  });
});
