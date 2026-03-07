import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore, saveSessionStore } from "../../config/sessions.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import {
  consumePendingDelegates,
  consumeStagedPostCompactionDelegates,
  enqueuePendingDelegate,
  stagePostCompactionDelegate,
} from "../continuation-delegate-store.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const { loadConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
}));

const runEmbeddedPiAgentMock = vi.fn();
const runCliAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const runtimeErrorMock = vi.fn();
const enqueueSystemEventMock = vi.fn();
const peekSystemEventEntriesMock = vi.fn().mockReturnValue([]);
const spawnSubagentDirectMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();
let liveConfigOverride: Record<string, unknown> = {};

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

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
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

const loadCronStoreMock = vi.fn();
vi.mock("../../cron/store.js", async () => {
  const actual = await vi.importActual<typeof import("../../cron/store.js")>("../../cron/store.js");
  return {
    ...actual,
    loadCronStore: (...args: unknown[]) => loadCronStoreMock(...args),
  };
});

vi.mock("../../infra/system-events.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/system-events.js")>(
    "../../infra/system-events.js",
  );
  return {
    ...actual,
    enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
    peekSystemEventEntries: (...args: unknown[]) => peekSystemEventEntriesMock(...args),
  };
});

vi.mock("../../agents/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
}));

vi.mock("../../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

import { runReplyAgent } from "./agent-runner.js";
import { bumpContinuationGeneration } from "./agent-runner.js";

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
  enqueueSystemEventMock.mockClear();
  peekSystemEventEntriesMock.mockClear();
  peekSystemEventEntriesMock.mockReturnValue([]);
  spawnSubagentDirectMock.mockClear();
  requestHeartbeatNowMock.mockClear();
  loadCronStoreMock.mockClear();
  loadConfigMock.mockClear();
  liveConfigOverride = {};
  loadConfigMock.mockImplementation(() => liveConfigOverride);
  consumePendingDelegates("main");
  consumePendingDelegates("test-session");
  consumeStagedPostCompactionDelegates("main");
  consumeStagedPostCompactionDelegates("test-session");
  // Default: no cron jobs in store.
  loadCronStoreMock.mockResolvedValue({ version: 1, jobs: [] });
  resetSystemEventsForTest();

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
  consumePendingDelegates("main");
  consumePendingDelegates("test-session");
  consumeStagedPostCompactionDelegates("main");
  consumeStagedPostCompactionDelegates("test-session");
  resetSystemEventsForTest();
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
      isContinuationWake: true,
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
    sessionFile?: string;
    workspaceDir?: string;
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
        sessionFile: params.sessionFile ?? "/tmp/session.jsonl",
        workspaceDir: params.workspaceDir ?? "/tmp",
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
      isContinuationWake: true,
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
      isContinuationWake: true,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    // totalTokens should use lastCallUsage (55k), not accumulated (75k)
    expect(stored[sessionKey].totalTokens).toBe(55_000);
  });

  it("persists staged post-compaction delegates when compaction does not happen", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-persist-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 10_000,
      compactionCount: 0,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });
    stagePostCompactionDelegate(sessionKey, {
      task: "carry working state forward",
      createdAt: 123,
    });

    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: {
        agentMeta: {
          usage: { input: 1_000, output: 500, total: 1_500 },
        },
      },
    });

    const config = {
      agents: { defaults: { continuation: { enabled: true } } },
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
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].pendingPostCompactionDelegates).toEqual([
      {
        task: "carry working state forward",
        createdAt: 123,
      },
    ]);
  });

  it("releases persisted and current-turn post-compaction delegates on compaction", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-release-"));
    const workspaceDir = path.join(tmp, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const sessionFile = path.join(tmp, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ type: "message", message: { role: "assistant", content: [] } })}\n`,
      "utf-8",
    );

    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 10_000,
      compactionCount: 0,
      pendingPostCompactionDelegates: [{ task: "persisted shard", createdAt: 1 }],
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });
    stagePostCompactionDelegate(sessionKey, {
      task: "current shard",
      createdAt: 2,
    });
    spawnSubagentDirectMock.mockResolvedValue({ status: "accepted" });

    runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
      params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      params.onAgentEvent?.({ stream: "compaction", data: { phase: "end", willRetry: false } });
      return {
        payloads: [{ text: "done" }],
        meta: {
          agentMeta: {
            usage: { input: 11_000, output: 500, total: 11_500 },
            lastCallUsage: { input: 10_500, output: 500, total: 11_000 },
            compactionCount: 1,
          },
        },
      };
    });

    const config = {
      agents: {
        defaults: {
          continuation: { enabled: true, maxDelegatesPerTurn: 5 },
          compaction: { memoryFlush: { enabled: false } },
        },
      },
    };
    const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
      storePath,
      sessionEntry,
      config,
      sessionFile,
      workspaceDir,
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

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(2);
    const spawnedTasks = spawnSubagentDirectMock.mock.calls.map((call) => String(call[0]?.task));
    expect(spawnedTasks).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[continuation:post-compaction]"),
        expect.stringContaining("[continuation:chain-hop:1]"),
        expect.stringContaining("[continuation:chain-hop:2]"),
        expect.stringContaining("persisted shard"),
        expect.stringContaining("current shard"),
      ]),
    );

    const lifecycleEvent = enqueueSystemEventMock.mock.calls.find((call) =>
      String(call[0]).includes("[system:post-compaction]"),
    );
    expect(lifecycleEvent?.[0]).toContain("Released 2 post-compaction delegate(s)");

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].pendingPostCompactionDelegates).toBeUndefined();
    expect(stored[sessionKey].continuationChainCount).toBe(2);
  });

  it("blocks post-compaction delegates when maxChainLength is already reached", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-chain-cap-"));
    const workspaceDir = path.join(tmp, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const sessionFile = path.join(tmp, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ type: "message", message: { role: "assistant", content: [] } })}\n`,
      "utf-8",
    );

    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 10_000,
      compactionCount: 0,
      continuationChainCount: 1,
      pendingPostCompactionDelegates: [{ task: "blocked shard", createdAt: 1 }],
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });
    runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
      params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      params.onAgentEvent?.({ stream: "compaction", data: { phase: "end", willRetry: false } });
      return {
        payloads: [{ text: "done" }],
        meta: {
          agentMeta: {
            usage: { input: 11_000, output: 500, total: 11_500 },
            lastCallUsage: { input: 10_500, output: 500, total: 11_000 },
            compactionCount: 1,
          },
        },
      };
    });

    const config = {
      agents: {
        defaults: {
          continuation: { enabled: true, maxDelegatesPerTurn: 5, maxChainLength: 1 },
          compaction: { memoryFlush: { enabled: false } },
        },
      },
    };
    const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
      storePath,
      sessionEntry,
      config,
      sessionFile,
      workspaceDir,
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
      isContinuationWake: true,
    });

    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("Post-compaction delegate rejected: chain length 1 reached"),
      expect.objectContaining({ sessionKey }),
    );
    const lifecycleEvent = enqueueSystemEventMock.mock.calls.find((call) =>
      String(call[0]).includes("[system:post-compaction]"),
    );
    expect(lifecycleEvent?.[0]).toContain("Released 0 post-compaction delegate(s)");
    expect(lifecycleEvent?.[0]).toContain("1 delegate(s) were not released");

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].continuationChainCount).toBe(1);
    expect(stored[sessionKey].pendingPostCompactionDelegates).toBeUndefined();
  });

  it("blocks post-compaction delegates when costCapTokens is already exceeded", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-cost-cap-"));
    const workspaceDir = path.join(tmp, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const sessionFile = path.join(tmp, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ type: "message", message: { role: "assistant", content: [] } })}\n`,
      "utf-8",
    );

    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 10_000,
      compactionCount: 0,
      continuationChainTokens: 11,
      pendingPostCompactionDelegates: [{ task: "budget shard", createdAt: 1 }],
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });
    runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
      params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      params.onAgentEvent?.({ stream: "compaction", data: { phase: "end", willRetry: false } });
      return {
        payloads: [{ text: "done" }],
        meta: {
          agentMeta: {
            usage: { input: 11_000, output: 500, total: 11_500 },
            lastCallUsage: { input: 10_500, output: 500, total: 11_000 },
            compactionCount: 1,
          },
        },
      };
    });

    const config = {
      agents: {
        defaults: {
          continuation: { enabled: true, maxDelegatesPerTurn: 5, costCapTokens: 10 },
          compaction: { memoryFlush: { enabled: false } },
        },
      },
    };
    const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
      storePath,
      sessionEntry,
      config,
      sessionFile,
      workspaceDir,
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

    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("Post-compaction delegate rejected: cost cap exceeded (11 > 10)"),
      expect.objectContaining({ sessionKey }),
    );
  });

  it("does not enqueue legacy post-compaction audit warnings", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-no-audit-warning-"));
    const workspaceDir = path.join(tmp, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const sessionFile = path.join(tmp, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ type: "message", message: { role: "assistant", content: [] } })}\n`,
      "utf-8",
    );

    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 10_000,
      compactionCount: 0,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
      params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      params.onAgentEvent?.({ stream: "compaction", data: { phase: "end", willRetry: false } });
      return {
        payloads: [{ text: "done" }],
        meta: {
          agentMeta: {
            usage: { input: 11_000, output: 500, total: 11_500 },
            lastCallUsage: { input: 10_500, output: 500, total: 11_000 },
            compactionCount: 1,
          },
        },
      };
    });

    const config = {
      agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } },
    };
    const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
      storePath,
      sessionEntry,
      config,
      sessionFile,
      workspaceDir,
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

    const queuedSystemEvents = peekSystemEvents(sessionKey);
    expect(queuedSystemEvents.some((event) => event.includes("Post-Compaction Audit"))).toBe(false);
    expect(queuedSystemEvents.some((event) => event.includes("WORKFLOW_AUTO.md"))).toBe(false);
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
      isContinuationWake: true,
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
  function createRun(params?: { sessionKey?: string; omitSessionKey?: boolean }) {
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
      ...(params?.omitSessionKey ? {} : { sessionKey: params?.sessionKey ?? "main" }),
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

  it("suppresses guard note when session already has an active cron job", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      version: 1,
      jobs: [
        {
          id: "existing-job",
          name: "monitor-task",
          enabled: true,
          sessionKey: "main",
          createdAtMs: Date.now() - 60_000,
          updatedAtMs: Date.now() - 60_000,
        },
      ],
    });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll ping you when it's done." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun();
    expect(result).toMatchObject({
      text: "I'll ping you when it's done.",
    });
  });

  it("still appends guard note when cron jobs exist but not for the current session", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      version: 1,
      jobs: [
        {
          id: "unrelated-job",
          name: "daily-news",
          enabled: true,
          sessionKey: "other-session",
          createdAtMs: Date.now() - 60_000,
          updatedAtMs: Date.now() - 60_000,
        },
      ],
    });

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

  it("still appends guard note when cron jobs for session exist but are disabled", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      version: 1,
      jobs: [
        {
          id: "disabled-job",
          name: "old-monitor",
          enabled: false,
          sessionKey: "main",
          createdAtMs: Date.now() - 60_000,
          updatedAtMs: Date.now() - 60_000,
        },
      ],
    });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll check back in an hour." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun();
    expect(result).toMatchObject({
      text: "I'll check back in an hour.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    });
  });

  it("still appends guard note when sessionKey is missing", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      version: 1,
      jobs: [
        {
          id: "existing-job",
          name: "monitor-task",
          enabled: true,
          sessionKey: "main",
          createdAtMs: Date.now() - 60_000,
          updatedAtMs: Date.now() - 60_000,
        },
      ],
    });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll ping you later." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun({ omitSessionKey: true });
    expect(result).toMatchObject({
      text: "I'll ping you later.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    });
  });

  it("still appends guard note when cron store read fails", async () => {
    loadCronStoreMock.mockRejectedValueOnce(new Error("store read failed"));

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll remind you after lunch." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun({ sessionKey: "main" });
    expect(result).toMatchObject({
      text: "I'll remind you after lunch.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
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
    expect(String(payload?.text ?? "")).toContain(`· session \`${sessionKey}\``);
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
describe("runReplyAgent continuation signal handling", () => {
  function buildFollowupRun(params?: {
    sessionKey?: string;
    continuation?: {
      enabled?: boolean;
      minDelayMs?: number;
      maxDelayMs?: number;
      defaultDelayMs?: number;
      maxChainLength?: number;
      costCapTokens?: number;
      maxDelegatesPerTurn?: number;
      generationGuardTolerance?: number;
    };
  }): FollowupRun {
    const sessionKey = params?.sessionKey ?? "main";
    return {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey,
        messageProvider: "telegram",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {
          agents: {
            defaults: {
              continuation: params?.continuation,
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
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;
  }

  async function runTurn(params: {
    commandBody: string;
    followupRun: FollowupRun;
    sessionKey: string;
    sessionEntry: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    isHeartbeat?: boolean;
    isContinuationWake?: boolean;
  }) {
    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "telegram",
      MessageSid: "msg",
      OriginatingTo: "chat",
      AccountId: "primary",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const store = params.sessionStore ?? { [params.sessionKey]: params.sessionEntry };

    return runReplyAgent({
      commandBody: params.commandBody,
      followupRun: params.followupRun,
      queueKey: params.sessionKey,
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing,
      sessionCtx,
      sessionKey: params.sessionKey,
      sessionEntry: params.sessionEntry,
      sessionStore: store,
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
      opts: params.isHeartbeat ? { isHeartbeat: true } : undefined,
      isContinuationWake: params.isContinuationWake,
    });
  }

  function hasContinuationEnqueueCall(): boolean {
    return enqueueSystemEventMock.mock.calls.some((call) =>
      String(call[0] ?? "").includes("[continuation:wake] Turn"),
    );
  }

  it("does not schedule continuation when feature is not explicitly enabled", async () => {
    vi.useFakeTimers();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Done for now. CONTINUE_WORK" }],
      meta: {},
    });

    const sessionKey = "agent:main:telegram:dm:123";
    const sessionEntry = { sessionId: "session", updatedAt: Date.now() } as SessionEntry;

    await runTurn({
      commandBody: "hello",
      followupRun: buildFollowupRun({ sessionKey }),
      sessionKey,
      sessionEntry,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(hasContinuationEnqueueCall()).toBe(false);
  });

  it("does not false-trigger continuation from partial streaming text", async () => {
    vi.useFakeTimers();
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: {
        onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void>;
      }) => {
        await params.onPartialReply?.({
          text: "```ts\nconst token = 'CONTINUE_WORK'",
          mediaUrls: [],
        });
        return {
          payloads: [{ text: "That token was just an example in code." }],
          meta: {},
        };
      },
    );

    const sessionKey = "agent:main:telegram:dm:456";
    const sessionEntry = { sessionId: "session", updatedAt: Date.now() } as SessionEntry;

    await runTurn({
      commandBody: "hello",
      followupRun: buildFollowupRun({
        sessionKey,
        continuation: {
          enabled: true,
          minDelayMs: 0,
          maxDelayMs: 10_000,
        },
      }),
      sessionKey,
      sessionEntry,
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(hasContinuationEnqueueCall()).toBe(false);
  });

  it("cancels pending continuation timer when an external message arrives", async () => {
    vi.useFakeTimers();
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [{ text: "Continuing shortly. CONTINUE_WORK:1" }],
        meta: {},
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "External message received." }],
        meta: {},
      });

    const sessionKey = "agent:main:telegram:dm:789";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      continuationChainCount: 0,
    } as SessionEntry;

    const followupRun = buildFollowupRun({
      sessionKey,
      continuation: {
        enabled: true,
        minDelayMs: 0,
        maxDelayMs: 10_000,
      },
    });

    // First turn: continuation wake that schedules a WORK timer
    await runTurn({
      commandBody: "heartbeat",
      followupRun,
      sessionKey,
      sessionEntry,
      isHeartbeat: true,
      isContinuationWake: true,
    });

    // Second turn: external message — should cancel the timer
    await runTurn({
      commandBody: "Actually, new input from user",
      followupRun,
      sessionKey,
      sessionEntry,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(hasContinuationEnqueueCall()).toBe(false);
  });

  it("WORK: delayed continuation reads generationGuardTolerance at fire time", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:telegram:dm:work-live-tolerance";
    const sessionEntry = { sessionId: "session", updatedAt: Date.now() } as SessionEntry;

    liveConfigOverride = {
      agents: { defaults: { continuation: { enabled: true, generationGuardTolerance: 0 } } },
    };

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Will continue. CONTINUE_WORK:1" }],
      meta: {},
    });

    await runTurn({
      commandBody: "hello",
      followupRun: buildFollowupRun({
        sessionKey,
        continuation: {
          enabled: true,
          minDelayMs: 0,
          maxDelayMs: 10_000,
          generationGuardTolerance: 0,
        },
      }),
      sessionKey,
      sessionEntry,
    });

    bumpContinuationGeneration(sessionKey);
    bumpContinuationGeneration(sessionKey);
    bumpContinuationGeneration(sessionKey);
    liveConfigOverride = {
      agents: { defaults: { continuation: { enabled: true, generationGuardTolerance: 3 } } },
    };

    await vi.advanceTimersByTimeAsync(1_000);
    expect(hasContinuationEnqueueCall()).toBe(true);
  });

  it("caps requested continuation delay to maxDelayMs", async () => {
    vi.useFakeTimers();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Will continue. CONTINUE_WORK:30" }],
      meta: {},
    });

    const sessionKey = "agent:main:telegram:dm:999";
    const sessionEntry = { sessionId: "session", updatedAt: Date.now() } as SessionEntry;

    await runTurn({
      commandBody: "hello",
      followupRun: buildFollowupRun({
        sessionKey,
        continuation: {
          enabled: true,
          minDelayMs: 0,
          maxDelayMs: 100,
        },
      }),
      sessionKey,
      sessionEntry,
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(hasContinuationEnqueueCall()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(hasContinuationEnqueueCall()).toBe(true);
  });

  it("uses default 500k cost cap when continuation.costCapTokens is omitted", async () => {
    vi.useFakeTimers();

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Will continue. CONTINUE_WORK:1" }],
      meta: {
        agentMeta: {
          usage: {
            input: 400_000,
            output: 150_000,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      },
    });

    const sessionKey = "agent:main:telegram:dm:cost-cap-default";
    const sessionEntry = { sessionId: "session", updatedAt: Date.now() } as SessionEntry;

    await runTurn({
      commandBody: "hello",
      followupRun: buildFollowupRun({
        sessionKey,
        continuation: {
          enabled: true,
          minDelayMs: 0,
          maxDelayMs: 10_000,
          // no costCapTokens => should default to 500_000
        },
      }),
      sessionKey,
      sessionEntry,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    // Over-default-cap continuation should NOT schedule a wake
    expect(hasContinuationEnqueueCall()).toBe(false);
  });

  it("DELEGATE: spawns sub-agent with correct task (multiline bracket body)", async () => {
    const delegateTask = "Build the flux capacitor\nThe capacitor needs 1.21 gigawatts of power.";

    spawnSubagentDirectMock.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: "agent:main:subagent:delegate-1",
      runId: "run-delegate-1",
    });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [
        {
          text: `Starting delegation.\n[[CONTINUE_DELEGATE: ${delegateTask}]]`,
        },
      ],
      meta: {},
    });

    const sessionKey = "agent:main:telegram:dm:delegate-1";
    const sessionEntry = { sessionId: "session", updatedAt: Date.now() } as SessionEntry;

    await runTurn({
      commandBody: "hello",
      followupRun: buildFollowupRun({
        sessionKey,
        continuation: {
          enabled: true,
          minDelayMs: 0,
          maxDelayMs: 10_000,
        },
      }),
      sessionKey,
      sessionEntry,
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);

    // Verify the spawn params contain the full multiline task
    const spawnParams = spawnSubagentDirectMock.mock.calls[0][0];
    const spawnCtx = spawnSubagentDirectMock.mock.calls[0][1];
    expect(spawnParams.task).toContain("[continuation:chain-hop:1]");
    expect(spawnParams.task).toContain("Build the flux capacitor");
    expect(spawnParams.task).toContain("1.21 gigawatts");
    expect(spawnCtx.agentSessionKey).toBe(sessionKey);

    // Should NOT enqueue a continuation system event (no timer-based continuation)
    expect(hasContinuationEnqueueCall()).toBe(false);
  });

  it("DELEGATE: falls back to system event on spawn failure", async () => {
    const delegateTask = "Fix the broken thing";

    spawnSubagentDirectMock.mockRejectedValueOnce(new Error("Agent not available"));

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: `Delegating now.\n[[CONTINUE_DELEGATE: ${delegateTask}]]` }],
      meta: {},
    });

    const sessionKey = "agent:main:telegram:dm:delegate-2";
    const sessionEntry = { sessionId: "session", updatedAt: Date.now() } as SessionEntry;

    await runTurn({
      commandBody: "hello",
      followupRun: buildFollowupRun({
        sessionKey,
        continuation: {
          enabled: true,
          minDelayMs: 0,
          maxDelayMs: 10_000,
        },
      }),
      sessionKey,
      sessionEntry,
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);

    // Verify fallback system event was enqueued with error message
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("[continuation] DELEGATE spawn failed"),
      expect.objectContaining({ sessionKey }),
    );
    // Verify the original task is included in the fallback message
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining(delegateTask),
      expect.objectContaining({ sessionKey }),
    );
  });

  it("DELEGATE: no continuation timer scheduled", async () => {
    vi.useFakeTimers();
    const delegateTask = "Autonomous background work";

    spawnSubagentDirectMock.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: "agent:main:subagent:delegate-3",
      runId: "run-delegate-3",
    });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: `Handing off.\n[[CONTINUE_DELEGATE: ${delegateTask}]]` }],
      meta: {},
    });

    const sessionKey = "agent:main:telegram:dm:delegate-3";
    const sessionEntry = { sessionId: "session", updatedAt: Date.now() } as SessionEntry;

    await runTurn({
      commandBody: "hello",
      followupRun: buildFollowupRun({
        sessionKey,
        continuation: {
          enabled: true,
          minDelayMs: 0,
          maxDelayMs: 10_000,
        },
      }),
      sessionKey,
      sessionEntry,
    });

    // Advance timers well past any possible continuation delay
    await vi.advanceTimersByTimeAsync(60_000);

    // No continuation timer should have fired — DELEGATE does not schedule timers
    expect(hasContinuationEnqueueCall()).toBe(false);

    // The spawn should have been called instead
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
  });

  it("DELEGATE: consumes tool-only delegates even when the agent emits no visible text", async () => {
    const sessionKey = "agent:main:telegram:dm:tool-only-delegate";
    const sessionEntry = { sessionId: "session", updatedAt: Date.now() } as SessionEntry;

    enqueuePendingDelegate(sessionKey, {
      task: "read shard without visible reply",
    });
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });
    spawnSubagentDirectMock.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: "agent:main:subagent:tool-only-delegate",
      runId: "run-tool-only-delegate",
    });

    const result = await runTurn({
      commandBody: "hello",
      followupRun: buildFollowupRun({
        sessionKey,
        continuation: {
          enabled: true,
          minDelayMs: 0,
          maxDelayMs: 10_000,
        },
      }),
      sessionKey,
      sessionEntry,
    });

    expect(result).toEqual([]);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    expect(String(spawnSubagentDirectMock.mock.calls[0]?.[0]?.task)).toContain(
      "read shard without visible reply",
    );
  });

  it("DELEGATE: delayed bracket spawn reads generationGuardTolerance at fire time", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:telegram:dm:delegate-live-tolerance";
    const sessionEntry = { sessionId: "session", updatedAt: Date.now() } as SessionEntry;

    liveConfigOverride = {
      agents: { defaults: { continuation: { enabled: true, generationGuardTolerance: 0 } } },
    };

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Queue delegate.\n[[CONTINUE_DELEGATE: inspect logs +1s]]" }],
      meta: {},
    });
    spawnSubagentDirectMock.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: "agent:main:subagent:delegate-live-tolerance",
      runId: "run-live-tolerance",
    });

    await runTurn({
      commandBody: "hello",
      followupRun: buildFollowupRun({
        sessionKey,
        continuation: {
          enabled: true,
          minDelayMs: 0,
          maxDelayMs: 10_000,
          generationGuardTolerance: 0,
        },
      }),
      sessionKey,
      sessionEntry,
    });

    bumpContinuationGeneration(sessionKey);
    bumpContinuationGeneration(sessionKey);
    bumpContinuationGeneration(sessionKey);
    liveConfigOverride = {
      agents: { defaults: { continuation: { enabled: true, generationGuardTolerance: 3 } } },
    };

    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
  });

  it("DELEGATE: delayed tool spawn reads generationGuardTolerance at fire time", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:telegram:dm:tool-live-tolerance";
    const sessionEntry = { sessionId: "session", updatedAt: Date.now() } as SessionEntry;

    liveConfigOverride = {
      agents: { defaults: { continuation: { enabled: true, generationGuardTolerance: 0 } } },
    };

    enqueuePendingDelegate(sessionKey, {
      task: "inspect shard health",
      delayMs: 1_000,
    });
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done" }],
      meta: {},
    });
    spawnSubagentDirectMock.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: "agent:main:subagent:tool-live-tolerance",
      runId: "run-tool-live-tolerance",
    });

    await runTurn({
      commandBody: "hello",
      followupRun: buildFollowupRun({
        sessionKey,
        continuation: {
          enabled: true,
          minDelayMs: 0,
          maxDelayMs: 10_000,
          generationGuardTolerance: 0,
        },
      }),
      sessionKey,
      sessionEntry,
    });

    bumpContinuationGeneration(sessionKey);
    bumpContinuationGeneration(sessionKey);
    bumpContinuationGeneration(sessionKey);
    liveConfigOverride = {
      agents: { defaults: { continuation: { enabled: true, generationGuardTolerance: 3 } } },
    };

    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
  });

  it("DELEGATE: persists chain count so maxChainLength is enforced", async () => {
    const maxChainLength = 2;

    spawnSubagentDirectMock.mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:delegate-chain",
      runId: "run-delegate-chain",
    });

    const sessionKey = "agent:main:telegram:dm:delegate-chain";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      continuationChainCount: 0,
    } as SessionEntry;
    const sessionStore = { [sessionKey]: sessionEntry };

    const followupRun = buildFollowupRun({
      sessionKey,
      continuation: {
        enabled: true,
        maxChainLength,
        minDelayMs: 0,
        maxDelayMs: 10_000,
      },
    });

    // First DELEGATE — continuation wake
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Delegating step 1.\n[[CONTINUE_DELEGATE: do step 1]]" }],
      meta: {},
    });

    await runTurn({
      commandBody: "heartbeat",
      followupRun,
      sessionKey,
      sessionEntry,
      sessionStore,
      isHeartbeat: true,
      isContinuationWake: true,
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    // Chain count should now be 1
    expect(sessionEntry.continuationChainCount).toBe(1);

    // Second DELEGATE — count goes to 2 = maxChainLength
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Delegating step 2.\n[[CONTINUE_DELEGATE: do step 2]]" }],
      meta: {},
    });

    await runTurn({
      commandBody: "heartbeat",
      followupRun,
      sessionKey,
      sessionEntry,
      sessionStore,
      isHeartbeat: true,
      isContinuationWake: true,
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(2);
    expect(sessionEntry.continuationChainCount).toBe(2);

    // Third DELEGATE — should be CAPPED (count >= maxChainLength)
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Trying step 3.\n[[CONTINUE_DELEGATE: do step 3]]" }],
      meta: {},
    });

    await runTurn({
      commandBody: "heartbeat",
      followupRun,
      sessionKey,
      sessionEntry,
      sessionStore,
      isHeartbeat: true,
      isContinuationWake: true,
    });

    // Spawn should NOT have been called a third time — capped
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(2);
  });

  it("DELEGATE bracket-origin spawn includes canonical [continuation:chain-hop:N] prefix", async () => {
    // Workstream B (WORKORDER6): bracket-origin and tool-origin spawns must
    // share the same hop-metadata contract so the announce-side guard can
    // enforce maxChainLength identically for both paths.
    spawnSubagentDirectMock.mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:delegate-hop-test",
      runId: "run-hop-test",
    });

    const sessionKey = "agent:main:telegram:dm:hop-prefix-test";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      continuationChainCount: 0,
    } as SessionEntry;
    const sessionStore = { [sessionKey]: sessionEntry };

    const followupRun = buildFollowupRun({
      sessionKey,
      continuation: {
        enabled: true,
        maxChainLength: 10,
        minDelayMs: 0,
        maxDelayMs: 10_000,
      },
    });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Research needed.\n[[CONTINUE_DELEGATE: look up the RFC]]" }],
      meta: {},
    });

    await runTurn({
      commandBody: "heartbeat",
      followupRun,
      sessionKey,
      sessionEntry,
      sessionStore,
      isHeartbeat: true,
      isContinuationWake: true,
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    const spawnParams = spawnSubagentDirectMock.mock.calls[0][0];
    // The task must contain the canonical chain-hop prefix that the announce-side
    // guard parses at subagent-announce.ts:1346
    expect(spawnParams.task).toMatch(/\[continuation:chain-hop:\d+\]/);
  });

  it("does not treat user message starting with [continuation] as continuation event", async () => {
    vi.useFakeTimers();

    // Set up a session with an active continuation chain
    const sessionKey = "agent:main:telegram:dm:spoof";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      continuationChainCount: 3,
      continuationChainStartedAt: Date.now(),
      continuationChainTokens: 5000,
    } as SessionEntry;

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Got your message." }],
      meta: {},
    });

    const followupRun = buildFollowupRun({
      sessionKey,
      continuation: {
        enabled: true,
        minDelayMs: 0,
        maxDelayMs: 10_000,
      },
    });

    // User sends a message that starts with "[continuation]" — should still reset chain
    await runTurn({
      commandBody: "[continuation] hey I'm just a user typing this",
      followupRun,
      sessionKey,
      sessionEntry,
    });

    // Chain state should be reset because this is NOT a heartbeat with system events
    expect(sessionEntry.continuationChainCount).toBe(0);
    expect(sessionEntry.continuationChainStartedAt).toBeUndefined();
    expect(sessionEntry.continuationChainTokens).toBeUndefined();
  });
});
