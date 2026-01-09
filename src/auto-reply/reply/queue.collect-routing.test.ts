import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";

function createRun(params: {
  prompt: string;
  originatingChannel?: FollowupRun["originatingChannel"];
  originatingTo?: string;
}): FollowupRun {
  return {
    prompt: params.prompt,
    enqueuedAt: Date.now(),
    originatingChannel: params.originatingChannel,
    originatingTo: params.originatingTo,
    run: {
      agentId: "agent",
      agentDir: "/tmp",
      sessionId: "sess",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp",
      config: {} as ClawdbotConfig,
      provider: "openai",
      model: "gpt-test",
      timeoutMs: 10_000,
      blockReplyBreak: "text_end",
    },
  };
}

describe("followup queue deduplication", () => {
  it("deduplicates messages with same Discord message_id", async () => {
    const key = `test-dedup-message-id-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    // First enqueue should succeed
    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "[Discord Guild #test channel id:123] Hello",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      settings,
    );
    expect(first).toBe(true);

    // Second enqueue with same prompt should be deduplicated
    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "[Discord Guild #test channel id:123] Hello",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      settings,
    );
    expect(second).toBe(false);

    // Third enqueue with different prompt should succeed
    const third = enqueueFollowupRun(
      key,
      createRun({
        prompt: "[Discord Guild #test channel id:123] World",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      settings,
    );
    expect(third).toBe(true);

    scheduleFollowupDrain(key, runFollowup);
    await expect.poll(() => calls.length).toBe(1);
    // Should collect both unique messages
    expect(calls[0]?.prompt).toContain(
      "[Queued messages while agent was busy]",
    );
  });

  it("deduplicates across different providers using exact prompt match", async () => {
    const key = `test-dedup-whatsapp-${Date.now()}`;
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    // First enqueue should succeed
    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      settings,
    );
    expect(first).toBe(true);

    // Second enqueue with same prompt should be deduplicated
    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      settings,
    );
    expect(second).toBe(false);

    // Third enqueue with different prompt should succeed
    const third = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world 2",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      settings,
    );
    expect(third).toBe(true);
  });
});

describe("followup queue collect routing", () => {
  it("does not collect when destinations differ", async () => {
    const key = `test-collect-diff-to-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:B",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[0]?.prompt).toBe("one");
    expect(calls[1]?.prompt).toBe("two");
  });

  it("collects when channel+destination match", async () => {
    const key = `test-collect-same-to-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]?.prompt).toContain(
      "[Queued messages while agent was busy]",
    );
    expect(calls[0]?.originatingChannel).toBe("slack");
    expect(calls[0]?.originatingTo).toBe("channel:A");
  });
});
