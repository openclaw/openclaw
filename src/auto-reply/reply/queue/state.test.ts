// Tests queue state storage, dedupe, and cleanup primitives.
import { afterEach, describe, expect, it } from "vitest";
import { clearFollowupQueue, getFollowupQueue, refreshQueuedFollowupSession } from "./state.js";
import type { FollowupRun } from "./types.js";

const QUEUE_KEY = "agent:main:dm:test";

afterEach(() => {
  clearFollowupQueue(QUEUE_KEY);
});

function makeRun(): FollowupRun["run"] {
  return {
    agentId: "main",
    agentDir: "/tmp/agent",
    sessionId: "session-1",
    sessionKey: QUEUE_KEY,
    sessionFile: "/tmp/session-1.jsonl",
    workspaceDir: "/tmp/workspace",
    config: {} as FollowupRun["run"]["config"],
    provider: "anthropic",
    model: "claude-opus-4-6",
    authProfileId: "profile-a",
    authProfileIdSource: "user",
    timeoutMs: 30_000,
    blockReplyBreak: "message_end",
  };
}

describe("refreshQueuedFollowupSession", () => {
  it("retargets queued runs to the persisted selection", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    const lastRun = makeRun();
    const queuedRun: FollowupRun = {
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    const summarizedRun: FollowupRun = {
      prompt: "summarized message",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    queue.lastRun = lastRun;
    queue.items.push(queuedRun);
    queue.summarySources.push(summarizedRun);
    queue.summaryElisions.push({
      contextKey: "context",
      count: 2,
      source: {
        prompt: "elided summary",
        enqueuedAt: Date.now(),
        run: makeRun(),
      },
      sourceRefs: new WeakSet(),
      allRoomEvents: false,
    });

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "openai",
      nextModel: "gpt-4o",
      nextAuthProfileId: undefined,
      nextAuthProfileIdSource: undefined,
    });

    expect(queue.lastRun).toEqual({
      ...makeRun(),
      provider: "openai",
      model: "gpt-4o",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(queue.items[0]?.run).toEqual({
      ...makeRun(),
      provider: "openai",
      model: "gpt-4o",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(queue.summarySources[0]?.run).toEqual({
      ...makeRun(),
      provider: "openai",
      model: "gpt-4o",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(queue.summaryElisions[0]?.source.run).toEqual({
      ...makeRun(),
      provider: "openai",
      model: "gpt-4o",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("retargets queued runs with user model override source", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    const queuedRun: FollowupRun = {
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: { ...makeRun(), hasAutoFallbackProvenance: true },
    };
    queue.items.push(queuedRun);

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "ollama",
      nextModel: "qwen3.5:27b",
      nextModelOverrideSource: "user",
    });

    expect(queue.items[0]?.run).toEqual({
      ...makeRun(),
      provider: "ollama",
      model: "qwen3.5:27b",
      hasSessionModelOverride: true,
      modelOverrideSource: "user",
    });
  });

  it("retargets queued runs when explicitly refreshing a session file without an id change", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.lastRun = makeRun();
    queue.items.push({
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: makeRun(),
    });
    queue.summarySources.push({
      prompt: "summarized message",
      enqueuedAt: Date.now(),
      run: makeRun(),
    });
    queue.summaryElisions.push({
      contextKey: "context",
      count: 2,
      source: {
        prompt: "elided summary",
        enqueuedAt: Date.now(),
        run: makeRun(),
      },
      sourceRefs: new WeakSet(),
    });

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      previousSessionId: "session-1",
      nextSessionId: "session-1",
      nextSessionFile: "/tmp/session-1-explicit-only.jsonl",
      nextChatType: "group",
    });

    for (const run of [
      queue.lastRun,
      queue.items[0]?.run,
      queue.summarySources[0]?.run,
      queue.summaryElisions[0]?.source.run,
    ]) {
      expect(run).toMatchObject({
        sessionId: "session-1",
        sessionFile: "/tmp/session-1-explicit-only.jsonl",
        chatType: "group",
      });
    }
  });
});

describe("getFollowupQueue", () => {
  it("trims overflow metadata when a live queue cap shrinks", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 3 });
    for (const [contextKey, count] of [
      ["oldest", 2],
      ["middle", 3],
      ["newest", 4],
    ] as const) {
      queue.summaryElisions.push({
        contextKey,
        count,
        source: {
          prompt: contextKey,
          enqueuedAt: Date.now(),
          run: makeRun(),
        },
        sourceRefs: new WeakSet(),
        allRoomEvents: false,
      });
    }
    queue.evictedSummaryCount = 5;

    const updated = getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 1 });

    expect(updated.summaryElisions.map((entry) => entry.contextKey)).toEqual(["newest"]);
    expect(updated.evictedSummaryCount).toBe(10);
  });
});
