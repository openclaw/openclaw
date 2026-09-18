// Tests queue state storage, dedupe, and cleanup primitives.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { enqueueFollowupRun } from "./enqueue.js";
import { persistFollowupQueues } from "./persist.js";
import {
  clearFollowupQueue,
  clearRemovedQueuedAuthProfiles,
  FOLLOWUP_QUEUES,
  getFollowupQueue,
  hasPendingFollowupQueueWork,
  refreshQueuedFollowupSession,
} from "./state.js";
import type { FollowupRun } from "./types.js";

const QUEUE_KEY = "agent:main:dm:test";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  try {
    await clearFollowupQueue(QUEUE_KEY);
  } catch {
    FOLLOWUP_QUEUES.delete(QUEUE_KEY);
  }
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
    requestedRouteResolution: "resolved",
    authProfileId: "profile-a",
    authProfileIdSource: "user",
    timeoutMs: 30_000,
    blockReplyBreak: "message_end",
  };
}

describe("clearRemovedQueuedAuthProfiles", () => {
  it("releases removed accounts in every queued source without replacing newer choices", async () => {
    const queue = await getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    const lastRun = makeRun();
    const queued = makeRun();
    const summarized = makeRun();
    const elided = makeRun();
    const newer = { ...makeRun(), authProfileId: "profile-b" };
    const otherAgent = { ...makeRun(), agentId: "other" };
    const retainedConfig = otherAgent.config;
    const source = (run: FollowupRun["run"]): FollowupRun => ({
      prompt: "pending message",
      enqueuedAt: 1,
      run,
    });
    queued.autoFallbackPrimaryProbe = {
      provider: "anthropic",
      model: "primary",
      fallbackProvider: "anthropic",
      fallbackModel: queued.model,
      fallbackAuthProfileId: "profile-a",
      fallbackAuthProfileIdSource: "auto",
    };
    newer.autoFallbackPrimaryProbe = {
      ...queued.autoFallbackPrimaryProbe,
      fallbackAuthProfileId: "profile-b",
    };
    queue.lastRun = lastRun;
    queue.items.push(source(queued), source(newer), source(otherAgent));
    queue.summarySources.push(source(summarized));
    queue.summaryElisions.push({
      contextKey: "context",
      count: 1,
      sources: [source(elided)],
      summaryLines: ["pending summary"],
      sourceRefs: new WeakMap(),
    });
    const rewrittenConfig = { agents: { entries: { main: { model: "anthropic/model" } } } };

    clearRemovedQueuedAuthProfiles({
      removedByAgent: new Map([["main", new Set(["profile-a"])]]),
      rewriteConfig: () => rewrittenConfig,
    });

    for (const run of [lastRun, queued, summarized, elided]) {
      expect(run.authProfileId).toBeUndefined();
      expect(run.authProfileIdSource).toBeUndefined();
      expect(run.config).toBe(rewrittenConfig);
      expect(run.model).toBe("claude-opus-4-6");
    }
    expect(queued.autoFallbackPrimaryProbe).toEqual({
      provider: "anthropic",
      model: "primary",
      fallbackProvider: "anthropic",
      fallbackModel: queued.model,
    });
    expect(newer.authProfileId).toBe("profile-b");
    expect(newer.authProfileIdSource).toBe("user");
    expect(newer.autoFallbackPrimaryProbe.fallbackAuthProfileId).toBe("profile-b");
    expect(newer.config).toBe(rewrittenConfig);
    expect(otherAgent.authProfileId).toBe("profile-a");
    expect(otherAgent.config).toBe(retainedConfig);
    expect(queue.items).toHaveLength(3);
  });
});

describe("refreshQueuedFollowupSession", () => {
  it("retargets queued runs to the persisted selection", async () => {
    const queue = await getFollowupQueue(QUEUE_KEY, { mode: "followup" });
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
      summaryLines: ["elided summary"],
      sourceRefs: new WeakMap(),
    });

    await refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "openai",
      nextModel: "gpt-4o",
      nextRouteResolution: "resolved",
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

  it("retargets queued runs with user model override source", async () => {
    const queue = await getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    const queuedRun: FollowupRun = {
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: { ...makeRun(), hasAutoFallbackProvenance: true },
    };
    queue.items.push(queuedRun);

    await refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "ollama",
      nextModel: "qwen3.5:27b",
      nextRouteResolution: "resolved",
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

  it("clears queued model override strictness when retargeting to the configured default", async () => {
    const queue = await getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.items.push({
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: {
        ...makeRun(),
        hasSessionModelOverride: true,
        modelOverrideSource: "user",
      },
    });

    await refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "anthropic",
      nextModel: "claude-opus-4-6",
      nextRouteResolution: "resolved",
      nextModelOverrideSource: undefined,
    });

    expect(queue.items[0]?.run).toMatchObject({
      hasSessionModelOverride: false,
      modelOverrideSource: undefined,
    });
  });

  it("preserves queued Sol Ultra work when switching to Codex Luna", async () => {
    const queue = await getFollowupQueue(QUEUE_KEY, { mode: "followup" });
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

    await refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "openai",
      nextModel: "gpt-5.6-luna",
      nextRouteResolution: "resolved",
      nextThinking: {
        level: "ultra",
        catalog: [{ provider: "openai", id: "gpt-5.6-luna", name: "Luna", reasoning: true }],
        agentRuntime: "codex",
      },
    });

    expect(queue.items[0]?.run).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-luna",
      thinkLevel: "ultra",
      thinkingCatalog: [{ provider: "openai", id: "gpt-5.6-luna", name: "Luna", reasoning: true }],
    });
  });

  it("preserves harness-only Ultra when retargeting queued work", async () => {
    const queue = await getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.items.push({
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: { ...makeRun(), thinkLevel: "ultra" },
    });

    await refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "custom",
      nextModel: "reasoner",
      nextRouteResolution: "resolved",
      nextThinking: { level: "ultra", agentRuntime: "openclaw" },
    });

    expect(queue.items[0]?.run.thinkLevel).toBe("ultra");
  });

  it.each([
    {
      source: "turn",
      current: "high",
      stored: "off",
      model: "gpt-5.6-sol",
      reasoning: true,
      expected: "high",
    },
    {
      source: "turn",
      current: "off",
      stored: "high",
      model: "gpt-5.6-sol",
      reasoning: true,
      expected: "low",
    },
    {
      source: "default",
      current: "high",
      stored: "high",
      model: "gpt-5.6-sol",
      reasoning: true,
      expected: "medium",
    },
    {
      source: undefined,
      current: "high",
      stored: "low",
      model: "gpt-5.6-sol",
      reasoning: true,
      expected: "low",
    },
    {
      source: "turn",
      current: "ultra",
      stored: "off",
      model: "gpt-5.6-luna",
      reasoning: true,
      expected: "ultra",
    },
    {
      source: "turn",
      current: "high",
      stored: "off",
      model: "non-reasoner",
      reasoning: false,
      expected: "off",
    },
  ] as const)(
    "retargets $source thinking $current with stored $stored to $model as $expected",
    async ({ source, current, stored, model, reasoning, expected }) => {
      const queue = await getFollowupQueue(QUEUE_KEY, { mode: "followup" });
      const runs = Array.from({ length: 4 }, () => ({
        ...makeRun(),
        thinkLevel: current,
        thinkLevelOverride: source === "turn" ? current : source,
      }));
      const wrap = (run: FollowupRun["run"]): FollowupRun => ({
        prompt: "queued",
        enqueuedAt: Date.now(),
        run,
      });
      queue.lastRun = runs[0];
      queue.items.push(wrap(runs[1]!));
      queue.summarySources.push(wrap(runs[2]!));
      queue.summaryElisions.push({
        contextKey: "elided",
        count: 1,
        sources: [wrap(runs[3]!)],
        summaryLines: ["queued"],
        sourceRefs: new WeakMap(),
      });
      await refreshQueuedFollowupSession({
        key: QUEUE_KEY,
        nextProvider: "openai",
        nextModel: model,
        nextThinking: {
          level: stored,
          catalog: [{ provider: "openai", id: model, name: model, reasoning }],
          agentRuntime: "codex",
        },
      });
      expect(runs.map((run) => run.thinkLevel)).toEqual(Array(4).fill(expected));
      expect(runs.map((run) => run.thinkLevelOverride)).toEqual(
        Array(4).fill(source === "turn" ? current : source),
      );
    },
  );

  it.each([
    { requested: "high", stored: "low", expected: ["high", "off", "high"] },
    { requested: "off", stored: "high", expected: ["low", "off", "low"] },
    { requested: "default", stored: "off", expected: ["high", "off", "low"] },
    { requested: undefined, stored: "low", expected: ["low", "off", "low"] },
  ] as const)(
    "retains requested thinking $requested across repeated queued model switches",
    async ({ requested, stored, expected }) => {
      const queue = await getFollowupQueue(QUEUE_KEY, { mode: "followup" });
      const run: FollowupRun["run"] = {
        ...makeRun(),
        config: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.6-sol": { params: { thinking: "high" } },
                "openai/gpt-5.6-luna": { params: { thinking: "low" } },
              },
            },
          },
        },
        thinkLevel: "high",
        thinkLevelOverride: requested,
      };
      queue.items.push({ prompt: "task", enqueuedAt: Date.now(), run });
      for (const [index, model] of ["gpt-5.6-sol", "non-reasoner", "gpt-5.6-luna"].entries()) {
        await refreshQueuedFollowupSession({
          key: QUEUE_KEY,
          nextProvider: "openai",
          nextModel: model,
          nextThinking: {
            level: stored,
            catalog: [{ provider: "openai", id: model, name: model, reasoning: index !== 1 }],
            agentRuntime: "codex",
          },
        });
        expect(run.thinkLevel).toBe(expected[index]);
        expect(run.thinkLevelOverride).toBe(requested);
      }
    },
  );

  describe.each(["default", undefined] as const)("thinking source %s", (source) => {
    it.each<{ name: string; config: FollowupRun["run"]["config"]; expected: string }>([
      {
        name: "agent",
        config: {
          agents: {
            entries: { main: { thinkingDefault: "low" } },
            defaults: {
              thinkingDefault: "off",
              models: { "openai/gpt-5.6-sol": { params: { thinking: "high" } } },
            },
          },
        },
        expected: "low",
      },
      {
        name: "agent model",
        config: {
          agents: {
            entries: {
              main: {
                models: { "openai/gpt-5.6-sol": { params: { thinking: "low" } } },
              },
            },
            defaults: {
              models: { "openai/gpt-5.6-sol": { params: { thinking: "high" } } },
            },
          },
        },
        expected: "low",
      },
      {
        name: "model",
        config: {
          agents: {
            defaults: {
              thinkingDefault: "off",
              models: { "openai/gpt-5.6-sol": { params: { thinking: "high" } } },
            },
          },
        },
        expected: "high",
      },
      {
        name: "global",
        config: { agents: { defaults: { thinkingDefault: "high" } } },
        expected: "high",
      },
    ])("honors the configured $name default when retargeting", async ({ config, expected }) => {
      const queue = await getFollowupQueue(QUEUE_KEY, { mode: "followup" });
      const run: FollowupRun["run"] = {
        ...makeRun(),
        config,
        thinkLevel: "medium",
        thinkLevelOverride: source,
      };
      queue.items.push({ prompt: "task", enqueuedAt: Date.now(), run });
      await refreshQueuedFollowupSession({
        key: QUEUE_KEY,
        nextProvider: "openai",
        nextModel: "gpt-5.6-sol",
        nextThinking: {
          level: source === "default" ? "off" : undefined,
          catalog: [{ provider: "openai", id: "gpt-5.6-sol", name: "Sol", reasoning: true }],
          agentRuntime: "codex",
        },
      });
      expect(run.thinkLevel).toBe(expected);
    });
  });

  it("recomputes the retargeted model default when the session has no thinking override", async () => {
    const queue = await getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.items.push({
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: { ...makeRun(), thinkLevel: "ultra" },
    });

    await refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "openai",
      nextModel: "gpt-5.6-sol",
      nextRouteResolution: "resolved",
      nextThinking: { agentRuntime: "codex" },
    });

    // Sol's provider default reasoning level is medium (extensions/openai
    // thinking-policy.ts); retargeting without an override adopts it.
    expect(queue.items[0]?.run.thinkLevel).toBe("medium");
  });
});

describe("getFollowupQueue", () => {
  it("aborts work owned by a cleared queue", async () => {
    const queuedRun: FollowupRun = {
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    await enqueueFollowupRun(QUEUE_KEY, queuedRun, { mode: "followup" });

    expect(queuedRun.queueAbortSignal?.aborted).toBe(false);
    await clearFollowupQueue(QUEUE_KEY);
    expect(queuedRun.queueAbortSignal?.aborted).toBe(true);
  });

  it("restores the queue when clear persistence fails", async () => {
    const stateDir = tempDirs.make("openclaw-clear-persist-");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const queuedRun: FollowupRun = {
        prompt: "must survive clear failure",
        enqueuedAt: Date.now(),
        run: makeRun(),
      };
      await enqueueFollowupRun(QUEUE_KEY, queuedRun, { mode: "followup" });
      expect(queuedRun.queueAbortSignal?.aborted).toBe(false);
      const blocker = path.join(stateDir, "not-a-directory");
      fs.writeFileSync(blocker, "file");
      process.env.OPENCLAW_STATE_DIR = path.join(blocker, "child");
      await expect(clearFollowupQueue(QUEUE_KEY)).rejects.toThrow();
      const restored = FOLLOWUP_QUEUES.get(QUEUE_KEY);
      expect(restored?.items.map((item) => item.prompt)).toEqual(["must survive clear failure"]);
      expect(queuedRun.queueAbortSignal?.aborted).toBe(false);
      expect(restored?.items[0]?.queueAbortSignal?.aborted).toBe(false);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("restores run fields when refresh persistence fails", async () => {
    const stateDir = tempDirs.make("openclaw-refresh-persist-");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const queue = await getFollowupQueue(QUEUE_KEY, { mode: "followup" });
      const queuedRun: FollowupRun = {
        prompt: "queued message",
        enqueuedAt: Date.now(),
        run: makeRun(),
      };
      queue.items.push(queuedRun);
      const blocker = path.join(stateDir, "not-a-directory");
      fs.writeFileSync(blocker, "file");
      process.env.OPENCLAW_STATE_DIR = path.join(blocker, "child");
      await expect(
        refreshQueuedFollowupSession({
          key: QUEUE_KEY,
          nextProvider: "openai",
          nextModel: "gpt-4o",
          nextRouteResolution: "resolved",
        }),
      ).rejects.toThrow();
      expect(queue.items[0]?.run.provider).toBe("anthropic");
      expect(queue.items[0]?.run.model).toBe("claude-opus-4-6");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("trims overflow metadata when a live queue cap shrinks", async () => {
    const stateDir = tempDirs.make("openclaw-cap-shrink-");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const queue = await getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 3 });
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
          summaryLines: Array.from({ length: count }, () => contextKey),
          sourceRefs: new WeakMap(),
        });
      }
      queue.droppedCount = 9;
      queue.evictedSummaryCount = 5;
      await persistFollowupQueues();

      const updated = await getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 1 });

      expect(updated.summaryElisions.map((entry) => entry.contextKey)).toEqual(["newest"]);
      expect(updated.summaryElisions[0]?.sources).toHaveLength(1);
      expect(updated.summaryElisions[0]?.summaryLines).toEqual(["newest"]);
      expect(updated.evictedSummaryCount).toBe(13);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("rolls back cap-driven elision trimming when persistence fails", async () => {
    const stateDir = tempDirs.make("openclaw-cap-trim-fail-");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const queue = await getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 3 });
      queue.summaryElisions.push({
        contextKey: "keep",
        count: 2,
        sources: Array.from({ length: 2 }, () => ({
          prompt: "keep",
          enqueuedAt: Date.now(),
          run: makeRun(),
        })),
        summaryLines: ["keep", "keep"],
        sourceRefs: new WeakMap(),
      });
      queue.droppedCount = 2;
      await persistFollowupQueues();

      const blocker = path.join(stateDir, "not-a-directory");
      fs.writeFileSync(blocker, "file");
      process.env.OPENCLAW_STATE_DIR = path.join(blocker, "child");
      await expect(getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 1 })).rejects.toThrow();
      expect(queue.summaryElisions[0]?.sources).toHaveLength(2);
      expect(queue.evictedSummaryCount).toBe(0);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });
});

describe("hasPendingFollowupQueueWork", () => {
  it("detects each actionable queued-work representation", async () => {
    const cases = [
      (queue: Awaited<ReturnType<typeof getFollowupQueue>>) => {
        queue.items.push({
          prompt: "queued message",
          enqueuedAt: Date.now(),
          run: makeRun(),
        });
      },
      (queue: Awaited<ReturnType<typeof getFollowupQueue>>) => {
        queue.inFlight.add({
          prompt: "in-flight collected message",
          enqueuedAt: Date.now(),
          run: makeRun(),
        });
      },
      (queue: Awaited<ReturnType<typeof getFollowupQueue>>) => {
        queue.droppedCount = 1;
      },
    ];

    for (const populate of cases) {
      const queue = await getFollowupQueue(QUEUE_KEY, { mode: "followup" });
      populate(queue);
      expect(hasPendingFollowupQueueWork(["", ` ${QUEUE_KEY} `, QUEUE_KEY])).toBe(true);
      await clearFollowupQueue(QUEUE_KEY);
    }
  });

  it("ignores empty queues and historical eviction accounting", async () => {
    const queue = await getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.evictedSummaryCount = 3;

    expect(hasPendingFollowupQueueWork([undefined, "", QUEUE_KEY])).toBe(false);
  });
});
