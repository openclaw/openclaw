import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { shouldRunMemoryFlush } from "./memory-flush.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();
const runCliAgentMock = vi.fn();

type EmbeddedRunParams = {
  prompt?: string;
  extraSystemPrompt?: string;
  onAgentEvent?: (evt: { stream?: string; data?: { phase?: string; willRetry?: boolean } }) => void;
};

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: async ({
    provider,
    model,
    run,
  }: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await run(provider, model),
    provider,
    model,
  }),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (params: unknown) => runCliAgentMock(params),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
});

import { runReplyAgent } from "./agent-runner.js";
import { incrementCompactionCount } from "./session-updates.js";

async function seedSessionStore(params: {
  storePath: string;
  sessionKey: string;
  entry: Record<string, unknown>;
}) {
  await fs.mkdir(path.dirname(params.storePath), { recursive: true });
  await fs.writeFile(
    params.storePath,
    JSON.stringify({ [params.sessionKey]: params.entry }, null, 2),
    "utf-8",
  );
}

function createBaseRun(params: {
  storePath: string;
  sessionEntry: Record<string, unknown>;
  config?: Record<string, unknown>;
  runOverrides?: Partial<FollowupRun["run"]>;
}) {
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "whatsapp",
    OriginatingTo: "+15550001111",
    AccountId: "primary",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: params.config ?? {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;
  const run = {
    ...followupRun.run,
    ...params.runOverrides,
    config: params.config ?? followupRun.run.config,
  };

  return {
    typing,
    sessionCtx,
    resolvedQueue,
    followupRun: { ...followupRun, run },
  };
}

describe("stale totalTokens → memory flush → auto-compaction cycle", () => {
  it("incrementCompactionCount with tokensAfter=0 should reset totalTokens", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stale-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 95_000,
      compactionCount: 0,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    const sessionStore: Record<string, typeof sessionEntry> = {
      [sessionKey]: { ...sessionEntry },
    };

    const count = await incrementCompactionCount({
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      tokensAfter: 0,
    });

    expect(count).toBe(1);
    // totalTokens should be reset to 0 after compaction with tokensAfter=0
    expect(sessionStore[sessionKey].totalTokens).toBe(0);

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(0);
  });

  it("after auto-compaction with tokensAfter=0, shouldRunMemoryFlush must return false", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stale-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 95_000,
      compactionCount: 0,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    const sessionStore: Record<string, typeof sessionEntry> = {
      [sessionKey]: { ...sessionEntry },
    };

    await incrementCompactionCount({
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      tokensAfter: 0,
    });

    // After compaction, totalTokens should be 0, so memory flush should NOT trigger
    const result = shouldRunMemoryFlush({
      entry: sessionStore[sessionKey],
      contextWindowTokens: 100_000,
      reserveTokensFloor: 2_000,
      softThresholdTokens: 4_000,
    });

    expect(result).toBe(false);
  });

  it("persistSessionUsageUpdate with accumulated usage overwrites totalTokens to stale value", async () => {
    // This test documents the current (problematic) behavior:
    // After compaction, the accumulated usage from the entire run (pre + post compaction)
    // gets written to totalTokens, overwriting the post-compaction reset.
    const { persistSessionUsageUpdate } = await import("./session-usage.js");

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stale-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";

    // Start with post-compaction state: totalTokens reset to 0
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 0,
      compactionCount: 1,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    // Now persistSessionUsageUpdate is called with large accumulated usage
    // This simulates what happens in agent-runner.ts after a run that included compaction
    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 800_000, output: 5_000, cacheRead: 100_000 },
      modelUsed: "claude",
      providerUsed: "anthropic",
      contextTokensUsed: 1_000_000,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    // The accumulated usage overwrites totalTokens to a very large number
    // This is the root cause of the stale token cycle
    expect(stored[sessionKey].totalTokens).toBeGreaterThan(100_000);
  });

  it("after auto-compaction, next turn should not trigger memory flush (integration)", async () => {
    runEmbeddedPiAgentMock.mockReset();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stale-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 95_000,
      compactionCount: 0,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    const sessionFile = path.join(tmp, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf-8");

    // Simulate a run where auto-compaction completes
    runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
      // Fire compaction end event
      params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", willRetry: false },
      });
      return {
        payloads: [{ text: "ok" }],
        meta: {
          agentMeta: {
            usage: { input: 800_000, output: 5_000, cacheRead: 100_000 },
          },
        },
      };
    });

    const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
      storePath,
      sessionEntry,
      runOverrides: { sessionFile },
    });

    await runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing,
      sessionCtx,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    // Read session store after the run
    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    const entry = stored[sessionKey];

    // After compaction, totalTokens should be 0 (not the stale accumulated value)
    // This means shouldRunMemoryFlush should return false
    const flushNeeded = shouldRunMemoryFlush({
      entry,
      contextWindowTokens: 100_000,
      reserveTokensFloor: 2_000,
      softThresholdTokens: 4_000,
    });

    expect(flushNeeded).toBe(false);
  });
});
