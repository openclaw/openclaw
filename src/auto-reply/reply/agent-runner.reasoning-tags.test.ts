import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import { DEFAULT_MEMORY_FLUSH_PROMPT } from "./memory-flush.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("./queue.js", async () => {
  const actual =
    await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
});

import { runReplyAgent } from "./agent-runner.js";

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

describe("runReplyAgent fallback reasoning tags", () => {
  beforeEach(() => {
    runEmbeddedPiAgentMock.mockReset();
    runWithModelFallbackMock.mockReset();
  });

  it("enforces <final> when the fallback provider requires reasoning tags", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });
    runWithModelFallbackMock.mockImplementationOnce(
      async ({
        run,
      }: {
        run: (provider: string, model: string) => Promise<unknown>;
      }) => ({
        result: await run("google-antigravity", "gemini-3"),
        provider: "google-antigravity",
        model: "gemini-3",
      }),
    );

    await createRun();

    const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as
      | EmbeddedPiAgentParams
      | undefined;
    expect(call?.enforceFinalTag).toBe(true);
  });

  it("enforces <final> during memory flush on fallback providers", async () => {
    runEmbeddedPiAgentMock.mockImplementation(
      async (params: EmbeddedPiAgentParams) => {
        if (params.prompt === DEFAULT_MEMORY_FLUSH_PROMPT) {
          return { payloads: [], meta: {} };
        }
        return { payloads: [{ text: "ok" }], meta: {} };
      },
    );
    runWithModelFallbackMock.mockImplementation(
      async ({
        run,
      }: {
        run: (provider: string, model: string) => Promise<unknown>;
      }) => ({
        result: await run("google-antigravity", "gemini-3"),
        provider: "google-antigravity",
        model: "gemini-3",
      }),
    );

    await createRun({
      sessionEntry: {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 1_000_000,
        compactionCount: 0,
      },
    });

    const flushCall = runEmbeddedPiAgentMock.mock.calls.find(
      ([params]) =>
        (params as EmbeddedPiAgentParams | undefined)?.prompt ===
        DEFAULT_MEMORY_FLUSH_PROMPT,
    )?.[0] as EmbeddedPiAgentParams | undefined;

    expect(flushCall?.enforceFinalTag).toBe(true);
  });
});
