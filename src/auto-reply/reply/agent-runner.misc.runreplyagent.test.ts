import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore, saveSessionStore } from "../../config/sessions.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();
const runCliAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const runtimeErrorMock = vi.fn();

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
}));

vi.mock("../../agents/pi-embedded.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/pi-embedded.js")>(
    "../../agents/pi-embedded.js",
  );
  return {
    ...actual,
    queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
    runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
  };
});

vi.mock("../../agents/cli-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/cli-runner.js")>(
    "../../agents/cli-runner.js",
  );
  return {
    ...actual,
    runCliAgent: (params: unknown) => runCliAgentMock(params),
  };
});

vi.mock("../../runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../runtime.js")>("../../runtime.js");
  return {
    ...actual,
    defaultRuntime: {
      ...actual.defaultRuntime,
      log: vi.fn(),
      error: (...args: unknown[]) => runtimeErrorMock(...args),
      exit: vi.fn(),
    },
  };
});

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
});

import { runReplyAgent } from "./agent-runner.js";

type RunWithModelFallbackParams = {
  provider: string;
  model: string;
  run: (provider: string, model: string) => Promise<unknown>;
};

beforeEach(() => {
  runEmbeddedPiAgentMock.mockClear();
  runCliAgentMock.mockClear();
  runWithModelFallbackMock.mockClear();
  runtimeErrorMock.mockClear();

  // Default: no provider switch; execute the chosen provider+model.
  runWithModelFallbackMock.mockImplementation(
    async ({ provider, model, run }: RunWithModelFallbackParams) => ({
      result: await run(provider, model),
      provider,
      model,
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runReplyAgent onAgentRunStart", () => {
  function createRun(params?: {
    provider?: string;
    model?: string;
    opts?: {
      runId?: string;
      onAgentRunStart?: (runId: string) => void;
    };
  }) {
    const provider = params?.provider ?? "anthropic";
    const model = params?.model ?? "claude";
    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "webchat",
      OriginatingTo: "session:1",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "webchat",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider,
        model,
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

    return runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      opts: params?.opts,
      typing,
      sessionCtx,
      defaultModel: `${provider}/${model}`,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });
  }

  it("does not emit start callback when fallback fails before run start", async () => {
    runWithModelFallbackMock.mockRejectedValueOnce(
      new Error('No API key found for provider "anthropic".'),
    );
    const onAgentRunStart = vi.fn();

    const result = await createRun({
      opts: { runId: "run-no-start", onAgentRunStart },
    });

    expect(onAgentRunStart).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      text: expect.stringContaining('No API key found for provider "anthropic".'),
    });
  });

  it("emits start callback when cli runner starts", async () => {
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          provider: "claude-cli",
          model: "opus-4.5",
        },
      },
    });
    const onAgentRunStart = vi.fn();

    const result = await createRun({
      provider: "claude-cli",
      model: "opus-4.5",
      opts: { runId: "run-started", onAgentRunStart },
    });

    expect(onAgentRunStart).toHaveBeenCalledTimes(1);
    expect(onAgentRunStart).toHaveBeenCalledWith("run-started");
    expect(result).toMatchObject({ text: "ok" });
  });
});

describe("runReplyAgent authProfileId fallback scoping", () => {
  it("drops authProfileId when provider changes during fallback", async () => {
    runWithModelFallbackMock.mockImplementationOnce(
      async ({ run }: RunWithModelFallbackParams) => ({
        result: await run("openai-codex", "gpt-5.2"),
        provider: "openai-codex",
        model: "gpt-5.2",
      }),
    );

    runEmbeddedPiAgentMock.mockResolvedValue({ payloads: [{ text: "ok" }], meta: {} });

    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "telegram",
      OriginatingTo: "chat",
      AccountId: "primary",
      MessageSid: "msg",
      Surface: "telegram",
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
        messageProvider: "telegram",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude-opus",
        authProfileId: "anthropic:openclaw",
        authProfileIdSource: "manual",
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 5_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;

    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 1,
      compactionCount: 0,
    };

    await runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: sessionKey,
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
      storePath: undefined,
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
    const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as {
      authProfileId?: unknown;
      authProfileIdSource?: unknown;
      provider?: unknown;
    };

    expect(call.provider).toBe("openai-codex");
    expect(call.authProfileId).toBeUndefined();
    expect(call.authProfileIdSource).toBeUndefined();
  });
});

describe("runReplyAgent auto-compaction token update", () => {
  type EmbeddedRunParams = {
    prompt?: string;
    extraSystemPrompt?: string;
    onAgentEvent?: (evt: {
      stream?: string;
      data?: { phase?: string; willRetry?: boolean };
    }) => void;
  };

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
        bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;
    return { typing, sessionCtx, resolvedQueue, followupRun };
  }

  it("updates totalTokens after auto-compaction using lastCallUsage", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-tokens-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 181_000,
      compactionCount: 0,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
      // Simulate auto-compaction during agent run
      params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      params.onAgentEvent?.({ stream: "compaction", data: { phase: "end", willRetry: false } });
      return {
        payloads: [{ text: "done" }],
        meta: {
          agentMeta: {
            // Accumulated usage across pre+post compaction calls — inflated
            usage: { input: 190_000, output: 8_000, total: 198_000 },
            // Last individual API call's usage — actual post-compaction context
            lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
            compactionCount: 1,
          },
        },
      };
    });

    // Disable memory flush so we isolate the auto-compaction path
    const config = {
      agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } },
    };
    const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
      storePath,
      sessionEntry,
      config,
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
      agentCfgContextTokens: 200_000,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    // totalTokens should reflect actual post-compaction context (~10k), not
    // the stale pre-compaction value (181k) or the inflated accumulated (190k)
    expect(stored[sessionKey].totalTokens).toBe(10_000);
    // compactionCount should be incremented
    expect(stored[sessionKey].compactionCount).toBe(1);
  });

  it("updates totalTokens from lastCallUsage even without compaction", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-last-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 50_000,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          // Tool-use loop: accumulated input is higher than last call's input
          usage: { input: 75_000, output: 5_000, total: 80_000 },
          lastCallUsage: { input: 55_000, output: 2_000, total: 57_000 },
        },
      },
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
      agentCfgContextTokens: 200_000,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    // totalTokens should use lastCallUsage (55k), not accumulated (75k)
    expect(stored[sessionKey].totalTokens).toBe(55_000);
  });
});

describe("runReplyAgent block streaming", () => {
  it("coalesces duplicate text_end block replies", async () => {
    const onBlockReply = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(async (params) => {
      const block = params.onBlockReply as ((payload: { text?: string }) => void) | undefined;
      block?.({ text: "Hello" });
      block?.({ text: "Hello" });
      return {
        payloads: [{ text: "Final message" }],
        meta: {},
      };
    });

    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "discord",
      OriginatingTo: "channel:C1",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "discord",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {
          agents: {
            defaults: {
              blockStreamingCoalesce: {
                minChars: 1,
                maxChars: 200,
                idleMs: 0,
              },
            },
          },
        },
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
        blockReplyBreak: "text_end",
      },
    } as unknown as FollowupRun;

    const result = await runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      opts: { onBlockReply },
      typing,
      sessionCtx,
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: true,
      blockReplyChunking: {
        minChars: 1,
        maxChars: 200,
        breakPreference: "paragraph",
      },
      resolvedBlockStreamingBreak: "text_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0][0].text).toBe("Hello");
    expect(result).toBeUndefined();
  });

  it("returns the final payload when onBlockReply times out", async () => {
    vi.useFakeTimers();
    let sawAbort = false;

    const onBlockReply = vi.fn((_payload, context) => {
      return new Promise<void>((resolve) => {
        context?.abortSignal?.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            resolve();
          },
          { once: true },
        );
      });
    });

    runEmbeddedPiAgentMock.mockImplementationOnce(async (params) => {
      const block = params.onBlockReply as ((payload: { text?: string }) => void) | undefined;
      block?.({ text: "Chunk" });
      return {
        payloads: [{ text: "Final message" }],
        meta: {},
      };
    });

    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "discord",
      OriginatingTo: "channel:C1",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "discord",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {
          agents: {
            defaults: {
              blockStreamingCoalesce: {
                minChars: 1,
                maxChars: 200,
                idleMs: 0,
              },
            },
          },
        },
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
        blockReplyBreak: "text_end",
      },
    } as unknown as FollowupRun;

    const resultPromise = runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      opts: { onBlockReply, blockReplyTimeoutMs: 1 },
      typing,
      sessionCtx,
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: true,
      blockReplyChunking: {
        minChars: 1,
        maxChars: 200,
        breakPreference: "paragraph",
      },
      resolvedBlockStreamingBreak: "text_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    await vi.advanceTimersByTimeAsync(5);
    const result = await resultPromise;

    expect(sawAbort).toBe(true);
    expect(result).toMatchObject({ text: "Final message" });
  });
});

describe("runReplyAgent claude-cli routing", () => {
  function createRun() {
    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "webchat",
      OriginatingTo: "session:1",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "webchat",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider: "claude-cli",
        model: "opus-4.5",
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

    return runReplyAgent({
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
      defaultModel: "claude-cli/opus-4.5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });
  }

  it("uses claude-cli runner for claude-cli provider", async () => {
    const runId = "00000000-0000-0000-0000-000000000001";
    const randomSpy = vi.spyOn(crypto, "randomUUID").mockReturnValue(runId);
    const lifecyclePhases: string[] = [];
    const unsubscribe = onAgentEvent((evt) => {
      if (evt.runId !== runId) {
        return;
      }
      if (evt.stream !== "lifecycle") {
        return;
      }
      const phase = evt.data?.phase;
      if (typeof phase === "string") {
        lifecyclePhases.push(phase);
      }
    });
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          provider: "claude-cli",
          model: "opus-4.5",
        },
      },
    });

    const result = await createRun();
    unsubscribe();
    randomSpy.mockRestore();

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(lifecyclePhases).toEqual(["start", "end"]);
    expect(result).toMatchObject({ text: "ok" });
  });
});

describe("runReplyAgent messaging tool suppression", () => {
  function createRun(
    messageProvider = "slack",
    opts: { storePath?: string; sessionKey?: string } = {},
  ) {
    const typing = createMockTypingController();
    const sessionKey = opts.sessionKey ?? "main";
    const sessionCtx = {
      Provider: messageProvider,
      OriginatingTo: "channel:C1",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey,
        messageProvider,
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
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

    return runReplyAgent({
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
      sessionKey,
      storePath: opts.storePath,
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });
  }

  it("drops replies when a messaging tool sent via the same provider + target", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {},
    });

    const result = await createRun("slack");

    expect(result).toBeUndefined();
  });

  it("delivers replies when tool provider does not match", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "discord", provider: "discord", to: "channel:C1" }],
      meta: {},
    });

    const result = await createRun("slack");

    expect(result).toMatchObject({ text: "hello world!" });
  });

  it("keeps final reply when text matches a cross-target messaging send", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentTargets: [{ tool: "discord", provider: "discord", to: "channel:C1" }],
      meta: {},
    });

    const result = await createRun("slack");

    expect(result).toMatchObject({ text: "hello world!" });
  });

  it("delivers replies when account ids do not match", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [
        {
          tool: "slack",
          provider: "slack",
          to: "channel:C1",
          accountId: "alt",
        },
      ],
      meta: {},
    });

    const result = await createRun("slack");

    expect(result).toMatchObject({ text: "hello world!" });
  });

  it("persists usage fields even when replies are suppressed", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const entry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    await saveSessionStore(storePath, { [sessionKey]: entry });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {
        agentMeta: {
          usage: { input: 10, output: 5 },
          model: "claude-opus-4-5",
          provider: "anthropic",
        },
      },
    });

    const result = await createRun("slack", { storePath, sessionKey });

    expect(result).toBeUndefined();
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[sessionKey]?.inputTokens).toBe(10);
    expect(store[sessionKey]?.outputTokens).toBe(5);
    expect(store[sessionKey]?.totalTokens).toBeUndefined();
    expect(store[sessionKey]?.totalTokensFresh).toBe(false);
    expect(store[sessionKey]?.model).toBe("claude-opus-4-5");
  });

  it("persists totalTokens from promptTokens when snapshot is available", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const entry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    await saveSessionStore(storePath, { [sessionKey]: entry });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {
        agentMeta: {
          usage: { input: 10, output: 5 },
          promptTokens: 42_000,
          model: "claude-opus-4-5",
          provider: "anthropic",
        },
      },
    });

    const result = await createRun("slack", { storePath, sessionKey });

    expect(result).toBeUndefined();
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[sessionKey]?.totalTokens).toBe(42_000);
    expect(store[sessionKey]?.totalTokensFresh).toBe(true);
    expect(store[sessionKey]?.model).toBe("claude-opus-4-5");
  });

  it("persists totalTokens from promptTokens when provider omits usage", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      inputTokens: 111,
      outputTokens: 22,
    };
    await saveSessionStore(storePath, { [sessionKey]: entry });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {
        agentMeta: {
          promptTokens: 41_000,
          model: "claude-opus-4-5",
          provider: "anthropic",
        },
      },
    });

    const result = await createRun("slack", { storePath, sessionKey });

    expect(result).toBeUndefined();
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[sessionKey]?.totalTokens).toBe(41_000);
    expect(store[sessionKey]?.totalTokensFresh).toBe(true);
    expect(store[sessionKey]?.inputTokens).toBe(111);
    expect(store[sessionKey]?.outputTokens).toBe(22);
  });
});

describe("runReplyAgent reminder commitment guard", () => {
  function createRun() {
    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "telegram",
      OriginatingTo: "chat",
      AccountId: "primary",
      MessageSid: "msg",
      Surface: "telegram",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "telegram",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
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

    return runReplyAgent({
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
      sessionKey: "main",
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });
  }

  it("appends guard note when reminder commitment is not backed by cron.add", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll remind you tomorrow morning." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun();
    expect(result).toMatchObject({
      text: "I'll remind you tomorrow morning.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    });
  });

  it("keeps reminder commitment unchanged when cron.add succeeded", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll remind you tomorrow morning." }],
      meta: {},
      successfulCronAdds: 1,
    });

    const result = await createRun();
    expect(result).toMatchObject({
      text: "I'll remind you tomorrow morning.",
    });
  });
});

describe("runReplyAgent fallback reasoning tags", () => {
  type EmbeddedPiAgentParams = {
    enforceFinalTag?: boolean;
    prompt?: string;
  };

  function createRun(params?: {
    sessionEntry?: SessionEntry;
    sessionKey?: string;
    agentCfgContextTokens?: number;
  }) {
    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "whatsapp",
      OriginatingTo: "+15550001111",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const sessionKey = params?.sessionKey ?? "main";
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: "/tmp/agent",
        sessionId: "session",
        sessionKey,
        messageProvider: "whatsapp",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
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

    return runReplyAgent({
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
      sessionEntry: params?.sessionEntry,
      sessionKey,
      defaultModel: "anthropic/claude-opus-4-5",
      agentCfgContextTokens: params?.agentCfgContextTokens,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });
  }

  it("enforces <final> when the fallback provider requires reasoning tags", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });
    runWithModelFallbackMock.mockImplementationOnce(
      async ({ run }: RunWithModelFallbackParams) => ({
        result: await run("google-gemini-cli", "gemini-3"),
        provider: "google-gemini-cli",
        model: "gemini-3",
      }),
    );

    await createRun();

    const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as EmbeddedPiAgentParams | undefined;
    expect(call?.enforceFinalTag).toBe(true);
  });

  it("enforces <final> during memory flush on fallback providers", async () => {
    runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedPiAgentParams) => {
      if (params.prompt?.includes("Pre-compaction memory flush.")) {
        return { payloads: [], meta: {} };
      }
      return { payloads: [{ text: "ok" }], meta: {} };
    });
    runWithModelFallbackMock.mockImplementation(async ({ run }: RunWithModelFallbackParams) => ({
      result: await run("google-gemini-cli", "gemini-3"),
      provider: "google-gemini-cli",
      model: "gemini-3",
    }));

    await createRun({
      sessionEntry: {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 1_000_000,
        compactionCount: 0,
      },
    });

    const flushCall = runEmbeddedPiAgentMock.mock.calls.find(([params]) =>
      (params as EmbeddedPiAgentParams | undefined)?.prompt?.includes(
        "Pre-compaction memory flush.",
      ),
    )?.[0] as EmbeddedPiAgentParams | undefined;

    expect(flushCall?.enforceFinalTag).toBe(true);
  });
});

describe("runReplyAgent response usage footer", () => {
  function createRun(params: { responseUsage: "tokens" | "full"; sessionKey: string }) {
    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "whatsapp",
      OriginatingTo: "+15550001111",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      responseUsage: params.responseUsage,
    };

    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: "/tmp/agent",
        sessionId: "session",
        sessionKey: params.sessionKey,
        messageProvider: "whatsapp",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
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

    return runReplyAgent({
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
      sessionKey: params.sessionKey,
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });
  }

  it("appends session key when responseUsage=full", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          provider: "anthropic",
          model: "claude",
          usage: { input: 12, output: 3 },
        },
      },
    });

    const sessionKey = "agent:main:whatsapp:dm:+1000";
    const res = await createRun({ responseUsage: "full", sessionKey });
    const payload = Array.isArray(res) ? res[0] : res;
    expect(String(payload?.text ?? "")).toContain("Usage:");
    expect(String(payload?.text ?? "")).toContain(`· session ${sessionKey}`);
  });

  it("does not append session key when responseUsage=tokens", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          provider: "anthropic",
          model: "claude",
          usage: { input: 12, output: 3 },
        },
      },
    });

    const sessionKey = "agent:main:whatsapp:dm:+1000";
    const res = await createRun({ responseUsage: "tokens", sessionKey });
    const payload = Array.isArray(res) ? res[0] : res;
    expect(String(payload?.text ?? "")).toContain("Usage:");
    expect(String(payload?.text ?? "")).not.toContain("· session ");
  });
});

describe("runReplyAgent transient HTTP retry", () => {
  it("retries once after transient 521 HTML failure and then succeeds", async () => {
    vi.useFakeTimers();
    runEmbeddedPiAgentMock
      .mockRejectedValueOnce(
        new Error(
          `521 <!DOCTYPE html><html lang="en-US"><head><title>Web server is down</title></head><body>Cloudflare</body></html>`,
        ),
      )
      .mockResolvedValueOnce({
        payloads: [{ text: "Recovered response" }],
        meta: {},
      });

    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "telegram",
      MessageSid: "msg",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "telegram",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
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

    const runPromise = runReplyAgent({
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
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    await vi.advanceTimersByTimeAsync(2_500);
    const result = await runPromise;

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(runtimeErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Transient HTTP provider error before reply"),
    );

    const payload = Array.isArray(result) ? result[0] : result;
    expect(payload?.text).toContain("Recovered response");
  });
});
