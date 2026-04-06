import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortEmbeddedPiRun,
  getActiveEmbeddedRunCount,
  isEmbeddedPiRunActive,
} from "../../agents/pi-embedded-runner/runs.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore, saveSessionStore } from "../../config/sessions.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import {
  clearMemoryPluginState,
  registerMemoryFlushPlanResolver,
} from "../../plugins/memory-state.js";
import type { TemplateContext } from "../templating.js";
import { __testing as abortTesting, tryFastAbortFromMessage } from "./abort.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { buildTestCtx } from "./test-ctx.js";
import { createMockTypingController } from "./test-helpers.js";

function createCliBackendTestConfig() {
  return {
    agents: {
      defaults: {
        cliBackends: {
          "claude-cli": {},
          "google-gemini-cli": {},
        },
      },
    },
  };
}

const runEmbeddedPiAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const runtimeErrorMock = vi.fn();
const abortEmbeddedPiRunMock = vi.fn();
const clearSessionQueuesMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const compactState = vi.hoisted(() => ({
  compactEmbeddedPiSessionMock: vi.fn(),
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../agents/pi-embedded.js", () => {
  return {
    compactEmbeddedPiSession: (params: unknown) =>
      compactState.compactEmbeddedPiSessionMock(params),
    queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
    runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
    abortEmbeddedPiRun: (...args: unknown[]) => abortEmbeddedPiRunMock(...args),
  };
});

vi.mock("../../runtime.js", () => {
  return {
    defaultRuntime: {
      log: vi.fn(),
      error: (...args: unknown[]) => runtimeErrorMock(...args),
      exit: vi.fn(),
    },
  };
});

vi.mock("./queue.js", () => {
  return {
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
    clearSessionQueues: (...args: unknown[]) => clearSessionQueuesMock(...args),
    refreshQueuedFollowupSession: (...args: unknown[]) => refreshQueuedFollowupSessionMock(...args),
  };
});

const loadCronStoreMock = vi.fn();
vi.mock("../../cron/store.js", () => {
  return {
    loadCronStore: (...args: unknown[]) => loadCronStoreMock(...args),
    resolveCronStorePath: (storePath?: string) => storePath ?? "/tmp/openclaw-cron-store.json",
  };
});

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => ({ kind: "none" }),
    cancelSession: async () => {},
  }),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey: () => null,
  listSubagentRunsForController: () => [],
  markSubagentRunTerminated: () => 0,
}));

import { runReplyAgent } from "./agent-runner.js";

type RunWithModelFallbackParams = {
  provider: string;
  model: string;
  run: (provider: string, model: string) => Promise<unknown>;
};

beforeEach(() => {
  runEmbeddedPiAgentMock.mockClear();
  runWithModelFallbackMock.mockClear();
  runtimeErrorMock.mockClear();
  abortEmbeddedPiRunMock.mockClear();
  clearSessionQueuesMock.mockReset();
  clearSessionQueuesMock.mockReturnValue({ followupCleared: 0, laneCleared: 0, keys: [] });
  refreshQueuedFollowupSessionMock.mockReset();
  refreshQueuedFollowupSessionMock.mockResolvedValue(undefined);
  loadCronStoreMock.mockClear();
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
  resetSystemEventsForTest();
  clearMemoryPluginState();
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
        config:
          provider === "claude-cli"
            ? { agents: { defaults: { cliBackends: { "claude-cli": {} } } } }
            : createCliBackendTestConfig(),
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

  it("emits start callback when the embedded runner starts", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
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
        result: await run("openai-codex", "gpt-5.4"),
        provider: "openai-codex",
        model: "gpt-5.4",
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
        config: createCliBackendTestConfig(),
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
    const sessionEntry: SessionEntry = {
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
      defaultModel: "anthropic/claude-opus-4-6",
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
    expect(sessionEntry.providerOverride).toBe("openai-codex");
    expect(sessionEntry.modelOverride).toBe("gpt-5.4");
    expect(sessionEntry.authProfileOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
  });

  it("persists same-provider fallback model while keeping the scoped auth profile", async () => {
    runWithModelFallbackMock.mockImplementationOnce(
      async ({ run }: RunWithModelFallbackParams) => ({
        result: await run("anthropic", "claude-sonnet"),
        provider: "anthropic",
        model: "claude-sonnet",
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
        config: createCliBackendTestConfig(),
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude-opus",
        authProfileId: "anthropic:openclaw",
        authProfileIdSource: "user",
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
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 1,
      compactionCount: 0,
      authProfileOverride: "anthropic:openclaw",
      authProfileOverrideSource: "user" as const,
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
      defaultModel: "anthropic/claude-opus-4-6",
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
      model?: unknown;
    };

    expect(call.provider).toBe("anthropic");
    expect(call.model).toBe("claude-sonnet");
    expect(call.authProfileId).toBe("anthropic:openclaw");
    expect(call.authProfileIdSource).toBe("user");
    expect(sessionEntry.providerOverride).toBe("anthropic");
    expect(sessionEntry.modelOverride).toBe("claude-sonnet");
    expect(sessionEntry.authProfileOverride).toBe("anthropic:openclaw");
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
  });
});

describe("runReplyAgent auto-compaction token update", () => {
  type EmbeddedRunParams = {
    prompt?: string;
    extraSystemPrompt?: string;
    abortSignal?: AbortSignal;
    onAgentEvent?: (evt: {
      stream?: string;
      data?: { phase?: string; willRetry?: boolean; completed?: boolean };
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

  async function normalizeComparablePath(filePath: string): Promise<string> {
    const parent = await fs.realpath(path.dirname(filePath)).catch(() => path.dirname(filePath));
    return path.join(parent, path.basename(filePath));
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

  it("lets /stop abort a run that is still in preflight compaction", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-preflight-stop-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionFile = "session-relative.jsonl";
    const workspaceDir = tmp;
    const transcriptPath = path.join(tmp, sessionFile);
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        message: {
          role: "user",
          content: "x".repeat(320_000),
          timestamp: Date.now(),
        },
      })}\n`,
      "utf-8",
    );

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile,
      totalTokens: 10,
      totalTokensFresh: false,
      compactionCount: 1,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    const compactionDeferred = createDeferred<{
      ok: true;
      compacted: true;
      result: {
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        tokensAfter: number;
      };
    }>();

    compactState.compactEmbeddedPiSessionMock.mockImplementationOnce(
      async () => await compactionDeferred.promise,
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    });

    abortTesting.setDepsForTests({
      getAcpSessionManager: (() =>
        ({
          resolveSession: () => ({ kind: "none" }),
          cancelSession: async () => {},
        }) as never) as never,
      getLatestSubagentRunByChildSessionKey: () => null,
      listSubagentRunsForController: () => [],
      markSubagentRunTerminated: () => 0,
    });

    const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
      storePath,
      sessionEntry,
      config: cfg,
      sessionFile,
      workspaceDir,
    });

    const runPromise = runReplyAgent({
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
      storePath,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    try {
      await vi.waitFor(() => {
        expect(compactState.compactEmbeddedPiSessionMock).toHaveBeenCalledOnce();
      });
      expect(getActiveEmbeddedRunCount()).toBe(1);

      const abortResult = await tryFastAbortFromMessage({
        ctx: buildTestCtx({
          Body: "/stop",
          RawBody: "/stop",
          CommandBody: "/stop",
          CommandSource: "text",
          CommandAuthorized: true,
          ChatType: "direct",
          Provider: "whatsapp",
          Surface: "whatsapp",
          From: "whatsapp:+15550001111",
          To: "whatsapp:+15550002222",
          SessionKey: sessionKey,
        }),
        cfg,
      });

      expect(abortResult).toMatchObject({
        handled: true,
        aborted: true,
      });
    } finally {
      compactionDeferred.resolve({
        ok: true,
        compacted: true,
        result: {
          summary: "compacted",
          firstKeptEntryId: "first-kept",
          tokensBefore: 90_000,
          tokensAfter: 8_000,
        },
      });
      await runPromise;
    }

    expect(getActiveEmbeddedRunCount()).toBe(0);
  });

  it("surfaces the restart notice when gateway shutdown aborts preflight compaction", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-preflight-restart-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionFile = "session-relative.jsonl";
    const workspaceDir = tmp;
    const transcriptPath = path.join(tmp, sessionFile);
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        message: {
          role: "user",
          content: "x".repeat(320_000),
          timestamp: Date.now(),
        },
      })}\n`,
      "utf-8",
    );

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile,
      totalTokens: 10,
      totalTokensFresh: false,
      compactionCount: 1,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    compactState.compactEmbeddedPiSessionMock.mockImplementationOnce(
      async (params: { abortSignal?: AbortSignal }) =>
        await new Promise<never>((_, reject) => {
          const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
          const onAbort = () => reject(abortError);
          if (params.abortSignal?.aborted) {
            onAbort();
            return;
          }
          params.abortSignal?.addEventListener("abort", onAbort, { once: true });
        }),
    );

    const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
      storePath,
      sessionEntry,
      config: cfg,
      sessionFile,
      workspaceDir,
    });

    const runPromise = runReplyAgent({
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
      storePath,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    await vi.waitFor(() => {
      expect(compactState.compactEmbeddedPiSessionMock).toHaveBeenCalledOnce();
    });
    expect(getActiveEmbeddedRunCount()).toBe(1);

    expect(abortEmbeddedPiRun(undefined, { mode: "compacting" })).toBe(true);

    await expect(runPromise).resolves.toEqual({
      text: "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
    });
    expect(getActiveEmbeddedRunCount()).toBe(0);
  });

  it("rebinds the active run to the rotated session id after memory flush", async () => {
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 1_000,
      forceFlushTranscriptBytes: Number.MAX_SAFE_INTEGER,
      reserveTokensFloor: 20_000,
      prompt: "Pre-compaction memory flush.",
      systemPrompt: "Flush memory into the configured memory file.",
      relativePath: "memory/active.md",
    }));

    runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
      if (params.prompt?.includes("Pre-compaction memory flush.")) {
        params.onAgentEvent?.({
          stream: "compaction",
          data: { phase: "end", completed: true },
        });
        return {
          payloads: [],
          meta: {
            agentMeta: {
              sessionId: "session-rotated",
            },
          },
        };
      }

      await new Promise<never>((_, reject) => {
        const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
        const onAbort = () => reject(abortError);
        if (params.abortSignal?.aborted) {
          onAbort();
          return;
        }
        params.abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
    });

    const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
      storePath: "/tmp/session-store.json",
      sessionEntry: {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 1_000_000,
        compactionCount: 0,
      },
    });

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
      sessionEntry: {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 1_000_000,
        compactionCount: 0,
      },
      sessionStore: {
        main: {
          sessionId: "session",
          updatedAt: Date.now(),
          totalTokens: 1_000_000,
          compactionCount: 0,
        },
      },
      sessionKey: "main",
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    await vi.waitFor(() => {
      expect(isEmbeddedPiRunActive("session-rotated")).toBe(true);
    });
    expect(isEmbeddedPiRunActive("session")).toBe(false);
    expect(abortEmbeddedPiRun("session-rotated")).toBe(true);

    await runPromise;

    expect(isEmbeddedPiRunActive("session-rotated")).toBe(false);
  });

  it("updates totalTokens after auto-compaction using lastCallUsage", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-tokens-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      sessionFile: path.join(tmp, "session.jsonl"),
      updatedAt: Date.now(),
      totalTokens: 181_000,
      compactionCount: 0,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
      // Simulate auto-compaction during agent run
      params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", willRetry: false, completed: true },
      });
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
      defaultModel: "anthropic/claude-opus-4-6",
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

  it("tracks auto-compaction from embedded result metadata even when no compaction event is emitted", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-meta-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 181_000,
      compactionCount: 0,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: {
        agentMeta: {
          sessionId: "session-rotated",
          usage: { input: 190_000, output: 8_000, total: 198_000 },
          lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
          compactionCount: 2,
        },
      },
    });

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
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 200_000,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(10_000);
    expect(stored[sessionKey].compactionCount).toBe(2);
    expect(stored[sessionKey].sessionId).toBe("session-rotated");
    expect(await normalizeComparablePath(stored[sessionKey].sessionFile)).toBe(
      await normalizeComparablePath(path.join(tmp, "session-rotated.jsonl")),
    );
  });

  it("accumulates compactions across fallback attempts without double-counting a single attempt", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-fallback-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 181_000,
      compactionCount: 0,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    runWithModelFallbackMock.mockImplementationOnce(async ({ run }: RunWithModelFallbackParams) => {
      try {
        await run("anthropic", "claude");
      } catch {
        // Expected first-attempt failure.
      }
      return {
        result: await run("openai", "gpt-5.4"),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [{ provider: "anthropic", model: "claude", error: "attempt failed" }],
      };
    });

    runEmbeddedPiAgentMock
      .mockImplementationOnce(async (params: EmbeddedRunParams) => {
        params.onAgentEvent?.({
          stream: "compaction",
          data: { phase: "end", willRetry: true, completed: true },
        });
        throw new Error("attempt failed");
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "done" }],
        meta: {
          agentMeta: {
            usage: { input: 190_000, output: 8_000, total: 198_000 },
            lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
            compactionCount: 2,
          },
        },
      });

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
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 200_000,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(10_000);
    expect(stored[sessionKey].compactionCount).toBe(3);
  });

  it("does not count failed compaction end events from earlier fallback attempts", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-fallback-failed-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 181_000,
      compactionCount: 0,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    runWithModelFallbackMock.mockImplementationOnce(async ({ run }: RunWithModelFallbackParams) => {
      try {
        await run("anthropic", "claude");
      } catch {
        // Expected first-attempt failure.
      }
      return {
        result: await run("openai", "gpt-5.4"),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [{ provider: "anthropic", model: "claude", error: "attempt failed" }],
      };
    });

    runEmbeddedPiAgentMock
      .mockImplementationOnce(async (params: EmbeddedRunParams) => {
        params.onAgentEvent?.({
          stream: "compaction",
          data: { phase: "end", willRetry: true, completed: false },
        });
        throw new Error("attempt failed");
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "done" }],
        meta: {
          agentMeta: {
            usage: { input: 190_000, output: 8_000, total: 198_000 },
            lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
            compactionCount: 2,
          },
        },
      });

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
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 200_000,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(10_000);
    expect(stored[sessionKey].compactionCount).toBe(2);
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
      defaultModel: "anthropic/claude-opus-4-6",
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
      params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", willRetry: false, completed: true },
      });
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
      defaultModel: "anthropic/claude-opus-4-6",
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
      defaultModel: "anthropic/claude-opus-4-6",
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
      defaultModel: "anthropic/claude-opus-4-6",
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
        config: { agents: { defaults: { cliBackends: { "claude-cli": {} } } } },
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

  it("uses the embedded runner for claude-cli provider", async () => {
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
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
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

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
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
        config: createCliBackendTestConfig(),
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
      defaultModel: "anthropic/claude-opus-4-6",
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
          model: "claude-opus-4-6",
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
    expect(store[sessionKey]?.model).toBe("claude-opus-4-6");
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
          model: "claude-opus-4-6",
          provider: "anthropic",
        },
      },
    });

    const result = await createRun("slack", { storePath, sessionKey });

    expect(result).toBeUndefined();
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[sessionKey]?.totalTokens).toBe(42_000);
    expect(store[sessionKey]?.totalTokensFresh).toBe(true);
    expect(store[sessionKey]?.model).toBe("claude-opus-4-6");
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
          model: "claude-opus-4-6",
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
        config: createCliBackendTestConfig(),
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
      defaultModel: "anthropic/claude-opus-4-6",
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
        config: createCliBackendTestConfig(),
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
      defaultModel: "anthropic/claude-opus-4-6",
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
        result: await run("google", "gemini-2.5-pro"),
        provider: "google",
        model: "gemini-2.5-pro",
      }),
    );

    await createRun();

    const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as EmbeddedPiAgentParams | undefined;
    expect(call?.enforceFinalTag).toBe(true);
  });

  it("enforces <final> during memory flush on fallback providers", async () => {
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 1_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 20_000,
      prompt: "Pre-compaction memory flush.",
      systemPrompt: "Flush memory into the configured memory file.",
      relativePath: "memory/active.md",
    }));
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
        config: createCliBackendTestConfig(),
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
      defaultModel: "anthropic/claude-opus-4-6",
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
        config: createCliBackendTestConfig(),
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
      defaultModel: "anthropic/claude-opus-4-6",
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

describe("runReplyAgent billing error classification", () => {
  // Regression guard for the runner-level catch block in runAgentTurnWithFallback.
  // Billing errors from providers like OpenRouter can contain token/size wording that
  // matches context overflow heuristics. This test verifies the final user-visible
  // message is the billing-specific one, not the "Context overflow" fallback.
  it("returns billing message for mixed-signal error (billing text + overflow patterns)", async () => {
    runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error("402 Payment Required: request token limit exceeded for this billing plan"),
    );

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
        config: createCliBackendTestConfig(),
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

    const result = await runReplyAgent({
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
      defaultModel: "anthropic/claude",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    const payload = Array.isArray(result) ? result[0] : result;
    expect(payload?.text).toContain("billing error");
    expect(payload?.text).not.toContain("Context overflow");
  });
});

describe("runReplyAgent mid-turn rate-limit fallback", () => {
  function createRun() {
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
        config: createCliBackendTestConfig(),
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
      defaultModel: "anthropic/claude",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });
  }

  it("surfaces a final error when only reasoning preceded a mid-turn rate limit", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "reasoning", isReasoning: true }],
      meta: {
        error: {
          kind: "retry_limit",
          message: "429 Too Many Requests: rate limit exceeded",
        },
      },
    });

    const result = await createRun();
    const payload = Array.isArray(result) ? result[0] : result;

    expect(payload?.text).toContain("API rate limit reached");
  });

  it("preserves successful media-only replies that use legacy mediaUrl", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ mediaUrl: "https://example.test/image.png" }],
      meta: {
        error: {
          kind: "retry_limit",
          message: "429 Too Many Requests: rate limit exceeded",
        },
      },
    });

    const result = await createRun();
    const payload = Array.isArray(result) ? result[0] : result;

    expect(payload).toMatchObject({
      mediaUrl: "https://example.test/image.png",
    });
    expect(payload?.text).toBeUndefined();
  });
});
