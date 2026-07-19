// Tests queue state storage, dedupe, and cleanup primitives.
import { afterEach, describe, expect, it } from "vitest";
import { createOperatorTurnAuthoritySnapshot } from "../../../plugins/turn-authority.js";
import {
  createSteeringAuthorizationAffinity,
  resolveSteeringAuthorizationAffinityKey,
} from "../steering-authorization-affinity.js";
import { enqueueFollowupRun } from "./enqueue.js";
import {
  clearFollowupQueue,
  clearFollowupQueueByAuthorizationAffinity,
  getFollowupQueue,
  refreshQueuedFollowupSession,
} from "./state.js";
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

function makeAuthority(connectionId: string) {
  return createOperatorTurnAuthoritySnapshot({
    scopes: ["operator.write"],
    connectionId,
    agentId: "main",
    sessionKey: QUEUE_KEY,
    conversationId: QUEUE_KEY,
    trigger: "gateway",
    capability: "queue-cleanup-test",
  });
}

function makeQueuedRun(prompt: string, connectionId?: string): FollowupRun {
  return {
    prompt,
    enqueuedAt: Date.now(),
    run: {
      ...makeRun(),
      ...(connectionId ? { turnAuthority: makeAuthority(connectionId) } : {}),
    },
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
      sources: [
        {
          prompt: "elided summary",
          enqueuedAt: Date.now(),
          run: makeRun(),
        },
      ],
      sourceRefs: new WeakMap(),
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
    expect(queue.summaryElisions[0]?.sources[0]?.run).toEqual({
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

  it("clamps queued Sol Ultra work to Codex Luna Max", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.items.push({
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: {
        ...makeRun(),
        provider: "openai",
        model: "gpt-5.6-sol",
        thinkLevel: "ultra",
      },
    });

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "openai",
      nextModel: "gpt-5.6-luna",
      nextThinking: { level: "ultra", agentRuntime: "codex" },
    });

    expect(queue.items[0]?.run).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-luna",
      thinkLevel: "max",
    });
  });

  it("uses the highest supported non-max level when retargeting queued work", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.items.push({
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: { ...makeRun(), thinkLevel: "ultra" },
    });

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "custom",
      nextModel: "reasoner",
      nextThinking: { level: "ultra", agentRuntime: "openclaw" },
    });

    expect(queue.items[0]?.run.thinkLevel).toBe("high");
  });

  it("recomputes the retargeted model default when the session has no thinking override", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.items.push({
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: { ...makeRun(), thinkLevel: "ultra" },
    });

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "openai",
      nextModel: "gpt-5.6-sol",
      nextThinking: { agentRuntime: "codex" },
    });

    // Sol's provider default reasoning level is medium (extensions/openai
    // thinking-policy.ts); retargeting without an override adopts it.
    expect(queue.items[0]?.run.thinkLevel).toBe("medium");
  });
});

describe("getFollowupQueue", () => {
  it("aborts work owned by a cleared queue", () => {
    const queuedRun: FollowupRun = {
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    enqueueFollowupRun(QUEUE_KEY, queuedRun, { mode: "followup" });

    expect(queuedRun.queueAbortSignal?.aborted).toBe(false);
    clearFollowupQueue(QUEUE_KEY);
    expect(queuedRun.queueAbortSignal?.aborted).toBe(true);
  });

  it("selectively clears only pending work from the exact controller authority", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    const sameOwner = makeQueuedRun("same owner", "conn-owner");
    const foreignOwner = makeQueuedRun("foreign owner", "conn-foreign");
    const unattributed = makeQueuedRun("unattributed");
    const sameOwnerInFlight = makeQueuedRun("same owner in flight", "conn-owner");
    queue.items.push(sameOwner, foreignOwner, unattributed, sameOwnerInFlight);
    queue.inFlight.add(sameOwnerInFlight);

    const sameOwnerSummary = makeQueuedRun("same owner summary", "conn-owner");
    const foreignSummary = makeQueuedRun("foreign summary", "conn-foreign");
    const unattributedSummary = makeQueuedRun("unattributed summary");
    queue.summarySources.push(sameOwnerSummary, foreignSummary, unattributedSummary);
    queue.summaryLines.push("same owner", "foreign", "unattributed");
    const sameOwnerElided = makeQueuedRun("same owner elided", "conn-owner");
    const foreignElided = makeQueuedRun("foreign elided", "conn-foreign");
    queue.summaryElisions.push(
      {
        contextKey: "same-owner",
        count: 1,
        sources: [sameOwnerElided],
        sourceRefs: new WeakMap(),
      },
      {
        contextKey: "foreign-owner",
        count: 1,
        sources: [foreignElided],
        sourceRefs: new WeakMap(),
      },
    );
    queue.droppedCount = 5;

    const affinityKey = resolveSteeringAuthorizationAffinityKey(
      createSteeringAuthorizationAffinity({ turnAuthority: makeAuthority("conn-owner") }),
    );
    expect(clearFollowupQueueByAuthorizationAffinity(QUEUE_KEY, affinityKey)).toBe(3);

    expect(queue.items.map((item) => item.prompt)).toEqual([
      "foreign owner",
      "unattributed",
      "same owner in flight",
    ]);
    expect(queue.summarySources.map((item) => item.prompt)).toEqual([
      "foreign summary",
      "unattributed summary",
    ]);
    expect(queue.summaryLines).toEqual(["foreign", "unattributed"]);
    expect(
      queue.summaryElisions.flatMap((entry) => entry.sources).map((item) => item.prompt),
    ).toEqual(["foreign elided"]);
    expect(queue.droppedCount).toBe(3);
    expect(queue.abortController.signal.aborted).toBe(false);
    expect(clearFollowupQueueByAuthorizationAffinity(QUEUE_KEY, undefined)).toBe(0);
  });

  it("clears an authority elision by logical count when retained sources are limited", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.summaryElisions.push(
      {
        contextKey: "same-owner",
        count: 8,
        sources: [
          makeQueuedRun("same owner retained 1", "conn-owner"),
          makeQueuedRun("same owner retained 2", "conn-owner"),
        ],
        sourceRefs: new WeakMap(),
      },
      {
        contextKey: "foreign-owner",
        count: 4,
        sources: [makeQueuedRun("foreign retained", "conn-foreign")],
        sourceRefs: new WeakMap(),
      },
    );
    queue.droppedCount = 12;

    const affinityKey = resolveSteeringAuthorizationAffinityKey(
      createSteeringAuthorizationAffinity({ turnAuthority: makeAuthority("conn-owner") }),
    );
    expect(clearFollowupQueueByAuthorizationAffinity(QUEUE_KEY, affinityKey)).toBe(8);

    expect(queue.summaryElisions).toHaveLength(1);
    expect(queue.summaryElisions[0]).toMatchObject({
      contextKey: "foreign-owner",
      count: 4,
    });
    expect(queue.summaryElisions[0]?.sources.map((source) => source.prompt)).toEqual([
      "foreign retained",
    ]);
    expect(queue.droppedCount).toBe(4);
  });

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
        sources: Array.from({ length: count }, () => ({
          prompt: contextKey,
          enqueuedAt: Date.now(),
          run: makeRun(),
        })),
        sourceRefs: new WeakMap(),
      });
    }
    queue.evictedSummaryCount = 5;

    const updated = getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 1 });

    expect(updated.summaryElisions.map((entry) => entry.contextKey)).toEqual(["newest"]);
    expect(updated.summaryElisions[0]?.sources).toHaveLength(1);
    expect(updated.evictedSummaryCount).toBe(13);
  });
});
