import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runReplyAgent } from "./agent-runner.js";
import {
  createBaseRun,
  getRunEmbeddedPiAgentMock,
  seedSessionStore,
  type EmbeddedRunParams,
} from "./agent-runner.memory-flush.test-harness.js";
import { DEFAULT_MEMORY_FLUSH_PROMPT } from "./memory-flush.js";

describe("runReplyAgent memory flush", () => {
  it("runs a memory flush turn and updates session metadata", async () => {
    const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
    runEmbeddedPiAgentMock.mockReset();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    const calls: Array<{ prompt?: string }> = [];
    runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
      calls.push({ prompt: params.prompt });
      if (params.prompt === DEFAULT_MEMORY_FLUSH_PROMPT) {
        return { payloads: [], meta: {} };
      }
      return {
        payloads: [{ text: "ok" }],
        meta: { agentMeta: { usage: { input: 1, output: 1 } } },
      };
    });

    const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
      storePath,
      sessionEntry,
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

    expect(calls.map((call) => call.prompt)).toEqual([DEFAULT_MEMORY_FLUSH_PROMPT, "hello"]);

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].memoryFlushAt).toBeTypeOf("number");
    expect(stored[sessionKey].memoryFlushCompactionCount).toBe(1);
  });
  it("skips memory flush when disabled in config", async () => {
    const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
    runEmbeddedPiAgentMock.mockReset();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    runEmbeddedPiAgentMock.mockImplementation(async (_params: EmbeddedRunParams) => ({
      payloads: [{ text: "ok" }],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    }));

    const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
      storePath,
      sessionEntry,
      config: {
        agents: {
          defaults: { compaction: { memoryFlush: { enabled: false } } },
        },
      },
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

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as { prompt?: string } | undefined;
    expect(call?.prompt).toBe("hello");

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].memoryFlushAt).toBeUndefined();
  });
});
