/**
 * Tests for compaction start notification (notifyOnStart / notifyOnStartText config).
 *
 * Verifies the full config → schema → callback → delivery chain.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TypingMode } from "../../config/types.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

type AgentRunParams = {
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
};

const state = vi.hoisted(() => ({
  runEmbeddedPiAgentMock: vi.fn(),
}));

let runReplyAgentPromise:
  | Promise<(typeof import("./agent-runner.js"))["runReplyAgent"]>
  | undefined;

async function getRunReplyAgent() {
  if (!runReplyAgentPromise) {
    runReplyAgentPromise = import("./agent-runner.js").then((m) => m.runReplyAgent);
  }
  return await runReplyAgentPromise;
}

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
    attempts: [],
  }),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => state.runEmbeddedPiAgentMock(params),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: vi.fn(),
}));

vi.mock("./queue.js", () => ({
  enqueueFollowupRun: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
}));

beforeEach(() => {
  state.runEmbeddedPiAgentMock.mockReset();
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
});

function createCompactionRun(params?: {
  opts?: GetReplyOptions;
  config?: Record<string, unknown>;
  typingMode?: TypingMode;
}) {
  const typing = createMockTypingController();
  const opts = params?.opts;
  const sessionCtx = {
    Provider: "whatsapp",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const sessionKey = "main";
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session",
      sessionKey,
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: params?.config ?? {},
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

  return {
    typing,
    opts,
    run: async () => {
      const runReplyAgent = await getRunReplyAgent();
      return runReplyAgent({
        commandBody: "hello",
        followupRun,
        queueKey: "main",
        resolvedQueue,
        shouldSteer: false,
        shouldFollowup: false,
        isActive: false,
        isStreaming: false,
        opts,
        typing,
        sessionCtx,
        defaultModel: "anthropic/claude-opus-4-5",
        resolvedVerboseLevel: "off",
        isNewSession: false,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: params?.typingMode ?? "instant",
      });
    },
  };
}

describe("compaction start notification", () => {
  it("calls onBlockReply with default text when notifyOnStart is true and compaction starts", async () => {
    const onBlockReply = vi.fn();

    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "start" },
      });
      return { payloads: [{ text: "done" }], meta: {} };
    });

    const { run } = createCompactionRun({
      config: {
        agents: {
          defaults: {
            compaction: {
              notifyOnStart: true,
              memoryFlush: { enabled: false },
            },
          },
        },
      },
      opts: { onBlockReply },
    });

    await run();

    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "🧹 Context compacting, back in a moment…" }),
    );
  });

  it("calls onBlockReply with custom text when notifyOnStartText is set", async () => {
    const onBlockReply = vi.fn();

    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "start" },
      });
      return { payloads: [{ text: "done" }], meta: {} };
    });

    const { run } = createCompactionRun({
      config: {
        agents: {
          defaults: {
            compaction: {
              notifyOnStart: true,
              notifyOnStartText: "⏳ Compressing history…",
              memoryFlush: { enabled: false },
            },
          },
        },
      },
      opts: { onBlockReply },
    });

    await run();

    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "⏳ Compressing history…" }),
    );
  });

  it("does NOT call onBlockReply when notifyOnStart is false", async () => {
    const onBlockReply = vi.fn();

    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "start" },
      });
      return { payloads: [{ text: "done" }], meta: {} };
    });

    const { run } = createCompactionRun({
      config: {
        agents: {
          defaults: {
            compaction: {
              notifyOnStart: false,
              memoryFlush: { enabled: false },
            },
          },
        },
      },
      opts: { onBlockReply },
    });

    await run();

    // onBlockReply should not have been called for the compaction notification
    const compactionCalls = onBlockReply.mock.calls.filter((call) => {
      const payload = call[0] as { text?: string };
      return payload?.text?.includes("compacting") || payload?.text?.includes("Compressing");
    });
    expect(compactionCalls).toHaveLength(0);
  });

  it("does NOT call onBlockReply when notifyOnStart is undefined (default off)", async () => {
    const onBlockReply = vi.fn();

    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "start" },
      });
      return { payloads: [{ text: "done" }], meta: {} };
    });

    const { run } = createCompactionRun({
      config: {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: { enabled: false },
            },
          },
        },
      },
      opts: { onBlockReply },
    });

    await run();

    const compactionCalls = onBlockReply.mock.calls.filter((call) => {
      const payload = call[0] as { text?: string };
      return payload?.text?.includes("compacting") || payload?.text?.includes("Compressing");
    });
    expect(compactionCalls).toHaveLength(0);
  });

  it("does NOT call onBlockReply for compaction end events even when notifyOnStart is true", async () => {
    const onBlockReply = vi.fn();

    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      // Only fire end, not start
      params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", willRetry: false },
      });
      return { payloads: [{ text: "done" }], meta: {} };
    });

    const { run } = createCompactionRun({
      config: {
        agents: {
          defaults: {
            compaction: {
              notifyOnStart: true,
              memoryFlush: { enabled: false },
            },
          },
        },
      },
      opts: { onBlockReply },
    });

    await run();

    const compactionCalls = onBlockReply.mock.calls.filter((call) => {
      const payload = call[0] as { text?: string };
      return payload?.text?.includes("compacting") || payload?.text?.includes("Compressing");
    });
    expect(compactionCalls).toHaveLength(0);
  });
});
