import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBaseRun,
  getRunCliAgentMock,
  getRunEmbeddedPiAgentMock,
  seedSessionStore,
  type EmbeddedRunParams,
} from "./agent-runner.memory-flush.test-harness.js";
import { DEFAULT_MEMORY_FLUSH_PROMPT } from "./memory-flush.js";

let runReplyAgent: typeof import("./agent-runner.js").runReplyAgent;

let fixtureRoot = "";
let caseId = 0;

async function withTempStore<T>(fn: (storePath: string) => Promise<T>): Promise<T> {
  const dir = path.join(fixtureRoot, `case-${++caseId}`);
  await fs.mkdir(dir, { recursive: true });
  return await fn(path.join(dir, "sessions.json"));
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-flush-"));
  ({ runReplyAgent } = await import("./agent-runner.js"));
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

describe("runReplyAgent memory flush", () => {
  it("skips memory flush for CLI providers", async () => {
    const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
    const runCliAgentMock = getRunCliAgentMock();
    runEmbeddedPiAgentMock.mockReset();
    runCliAgentMock.mockReset();

    await withTempStore(async (storePath) => {
      const sessionKey = "main";
      const sessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 80_000,
        compactionCount: 1,
      };

      await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

      runEmbeddedPiAgentMock.mockImplementation(async () => ({
        payloads: [{ text: "ok" }],
        meta: { agentMeta: { usage: { input: 1, output: 1 } } },
      }));
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

  it("uses configured prompts for memory flush runs", async () => {
    const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
    runEmbeddedPiAgentMock.mockReset();

    await withTempStore(async (storePath) => {
      const sessionKey = "main";
      const sessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 80_000,
        compactionCount: 1,
      };

      await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

      const calls: Array<EmbeddedRunParams> = [];
      runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
        calls.push(params);
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
        config: {
          agents: {
            defaults: {
              compaction: {
                memoryFlush: {
                  prompt: "Write notes.",
                  systemPrompt: "Flush memory now.",
                },
              },
            },
          },
        },
        runOverrides: { extraSystemPrompt: "extra system" },
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

      const flushCall = calls[0];
      expect(flushCall?.prompt).toContain("Write notes.");
      expect(flushCall?.prompt).toContain("NO_REPLY");
      expect(flushCall?.extraSystemPrompt).toContain("extra system");
      expect(flushCall?.extraSystemPrompt).toContain("Flush memory now.");
      expect(flushCall?.extraSystemPrompt).toContain("NO_REPLY");
      expect(calls[1]?.prompt).toBe("hello");
    });
  });

  it("runs a memory flush turn and updates session metadata", async () => {
    const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
    runEmbeddedPiAgentMock.mockReset();

    await withTempStore(async (storePath) => {
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
  });

  it("skips memory flush when disabled in config", async () => {
    const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
    runEmbeddedPiAgentMock.mockReset();

    await withTempStore(async (storePath) => {
      const sessionKey = "main";
      const sessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 80_000,
        compactionCount: 1,
      };

      await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

      runEmbeddedPiAgentMock.mockImplementation(async () => ({
        payloads: [{ text: "ok" }],
        meta: { agentMeta: { usage: { input: 1, output: 1 } } },
      }));

      const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
        storePath,
        sessionEntry,
        config: { agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } } },
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

  it("skips memory flush after a prior flush in the same compaction cycle", async () => {
    const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
    runEmbeddedPiAgentMock.mockReset();

    await withTempStore(async (storePath) => {
      const sessionKey = "main";
      const sessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 80_000,
        compactionCount: 2,
        memoryFlushCompactionCount: 2,
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

      expect(calls.map((call) => call.prompt)).toEqual(["hello"]);
    });
  });

  it("skips memory flush when the sandbox workspace is read-only", async () => {
    const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
    runEmbeddedPiAgentMock.mockReset();

    await withTempStore(async (storePath) => {
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

      const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
        storePath,
        sessionEntry,
        config: {
          agents: {
            defaults: {
              sandbox: { mode: "all", workspaceAccess: "ro" },
            },
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

      expect(calls.map((call) => call.prompt)).toEqual(["hello"]);

      const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(stored[sessionKey].memoryFlushAt).toBeUndefined();
    });
  });

  it("skips memory flush when the sandbox workspace is none", async () => {
    const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
    runEmbeddedPiAgentMock.mockReset();

    await withTempStore(async (storePath) => {
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

      const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
        storePath,
        sessionEntry,
        config: {
          agents: {
            defaults: {
              sandbox: { mode: "all", workspaceAccess: "none" },
            },
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

      expect(calls.map((call) => call.prompt)).toEqual(["hello"]);
    });
  });

  it("increments compaction count when flush compaction completes", async () => {
    const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
    runEmbeddedPiAgentMock.mockReset();

    await withTempStore(async (storePath) => {
      const sessionKey = "main";
      const sessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 80_000,
        compactionCount: 1,
      };

      await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

      runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
        if (params.prompt === DEFAULT_MEMORY_FLUSH_PROMPT) {
          params.onAgentEvent?.({
            stream: "compaction",
            data: { phase: "end", willRetry: false },
          });
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

      const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(stored[sessionKey].compactionCount).toBe(2);
      expect(stored[sessionKey].memoryFlushCompactionCount).toBe(2);
    });
  });
});
