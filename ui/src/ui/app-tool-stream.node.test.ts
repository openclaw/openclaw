import { beforeAll, describe, expect, it, vi } from "vitest";
import { handleAgentEvent, type FallbackStatus, type ToolStreamEntry } from "./app-tool-stream.ts";

type ToolStreamHost = Parameters<typeof handleAgentEvent>[0];
type MutableHost = ToolStreamHost & {
  compactionStatus?: unknown;
  compactionClearTimer?: number | null;
  fallbackStatus?: FallbackStatus | null;
  fallbackClearTimer?: number | null;
};

function createHost(overrides?: Partial<MutableHost>): MutableHost {
  return {
    sessionKey: "main",
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    chatStreamSegments: [],
    toolStreamById: new Map<string, ToolStreamEntry>(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
    compactionStatus: null,
    compactionClearTimer: null,
    fallbackStatus: null,
    fallbackClearTimer: null,
    ...overrides,
  };
}

beforeAll(() => {
  const globalWithWindow = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis;
  };
  if (!globalWithWindow.window) {
    globalWithWindow.window = globalThis as unknown as Window & typeof globalThis;
  }
});

describe("app-tool-stream fallback lifecycle handling", () => {
  it("accepts session-scoped fallback lifecycle events when no run is active", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
        reasonSummary: "rate limit",
      },
    });

    expect(host.fallbackStatus?.selected).toBe("fireworks/minimax-m2p5");
    expect(host.fallbackStatus?.active).toBe("deepinfra/moonshotai/Kimi-K2.5");
    expect(host.fallbackStatus?.reason).toBe("rate limit");
    vi.useRealTimers();
  });

  it("rejects idle fallback lifecycle events for other sessions", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "agent:other:main",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });

    expect(host.fallbackStatus).toBeNull();
    vi.useRealTimers();
  });

  it("auto-clears fallback status after toast duration", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });

    expect(host.fallbackStatus).not.toBeNull();
    vi.advanceTimersByTime(7_999);
    expect(host.fallbackStatus).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(host.fallbackStatus).toBeNull();
    vi.useRealTimers();
  });

  it("builds previous fallback label from provider + model on fallback_cleared", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "fallback_cleared",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "fireworks",
        activeModel: "fireworks/minimax-m2p5",
        previousActiveProvider: "deepinfra",
        previousActiveModel: "moonshotai/Kimi-K2.5",
      },
    });

    expect(host.fallbackStatus?.phase).toBe("cleared");
    expect(host.fallbackStatus?.previous).toBe("deepinfra/moonshotai/Kimi-K2.5");
    vi.useRealTimers();
  });
});

describe("app-tool-stream text segmentation", () => {
  it("stores only the incremental suffix when multiple tool starts split one cumulative stream", () => {
    const host = createHost({ chatStream: "我先改规则。" });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "start",
        name: "exec",
        toolCallId: "tool-1",
        args: { command: "npm run build" },
      },
    });

    host.chatStream = "我先改规则。build 已经开始了。";

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 2,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "start",
        name: "exec",
        toolCallId: "tool-2",
        args: { command: "process poll" },
      },
    });

    expect(host.chatStreamSegments).toEqual([
      { text: "我先改规则。", ts: expect.any(Number) },
      { text: "build 已经开始了。", ts: expect.any(Number) },
    ]);
  });

  it("does not add a duplicate stream segment when a later tool sees unchanged cumulative text", () => {
    const host = createHost({
      chatStreamSegments: [{ text: "我先改规则。", ts: Date.now() }],
      chatStream: "我先改规则。",
    });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "start",
        name: "exec",
        toolCallId: "tool-2",
        args: { command: "process poll" },
      },
    });

    expect(host.chatStreamSegments).toEqual([{ text: "我先改规则。", ts: expect.any(Number) }]);
    expect(host.chatStream).toBeNull();
  });
});
