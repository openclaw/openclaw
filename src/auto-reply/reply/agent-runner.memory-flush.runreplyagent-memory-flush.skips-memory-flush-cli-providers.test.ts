import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createBaseRun,
  getRunCliAgentMock,
  getRunEmbeddedPiAgentMock,
  seedSessionStore,
  type EmbeddedRunParams,
} from "./agent-runner.memory-flush.test-harness.js";

describe("runReplyAgent memory flush", () => {
  it("skips memory flush for CLI providers", async () => {
    const { runReplyAgent } = await import("./agent-runner.js");
    const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
    const runCliAgentMock = getRunCliAgentMock();
    runEmbeddedPiAgentMock.mockReset();
    runCliAgentMock.mockReset();
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
      return {
        payloads: [{ text: "ok" }],
        meta: { agentMeta: { usage: { input: 1, output: 1 } } },
      };
    });
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    });

    const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
      storePath,
      sessionEntry,
      runOverrides: { provider: "codex-cli" },
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

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    const call = runCliAgentMock.mock.calls[0]?.[0] as { prompt?: string } | undefined;
    expect(call?.prompt).toBe("hello");
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });
});
