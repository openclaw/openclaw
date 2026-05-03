// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from "vitest";
import { handleAgentEvent, type FallbackStatus, type ToolStreamEntry } from "./app-tool-stream.ts";

type ToolStreamHost = Parameters<typeof handleAgentEvent>[0];
type AgentEvent = NonNullable<Parameters<typeof handleAgentEvent>[1]>;
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
    chatStreamCommittedLen: 0,
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

function agentEvent(
  runId: string,
  seq: number,
  stream: AgentEvent["stream"],
  data: AgentEvent["data"],
  sessionKey = "main",
): AgentEvent {
  return {
    runId,
    seq,
    stream,
    ts: Date.now(),
    sessionKey,
    data,
  };
}

function expectCompactionCompleteAndAutoClears(host: MutableHost) {
  expect(host.compactionStatus).toEqual({
    phase: "complete",
    runId: "run-1",
    startedAt: expect.any(Number),
    completedAt: expect.any(Number),
  });
  expect(host.compactionClearTimer).not.toBeNull();

  vi.advanceTimersByTime(5_000);
  expect(host.compactionStatus).toBeNull();
  expect(host.compactionClearTimer).toBeNull();
}

describe("app-tool-stream fallback lifecycle handling", () => {
  beforeAll(() => {
    const globalWithWindow = globalThis as typeof globalThis & {
      window?: Window & typeof globalThis;
    };
    if (!globalWithWindow.window) {
      globalWithWindow.window = globalThis as unknown as Window & typeof globalThis;
    }
  });

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
        selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
        reasonSummary: "rate limit",
      },
    });

    expect(host.fallbackStatus?.selected).toBe(
      "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
    );
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
        selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
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
        selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
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
        selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
        activeProvider: "fireworks",
        activeModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
        previousActiveProvider: "deepinfra",
        previousActiveModel: "moonshotai/Kimi-K2.5",
      },
    });

    expect(host.fallbackStatus?.phase).toBe("cleared");
    expect(host.fallbackStatus?.previous).toBe("deepinfra/moonshotai/Kimi-K2.5");
    vi.useRealTimers();
  });

  it("keeps compaction in retry-pending state until the matching lifecycle end", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, agentEvent("run-1", 1, "compaction", { phase: "start" }));

    expect(host.compactionStatus).toEqual({
      phase: "active",
      runId: "run-1",
      startedAt: expect.any(Number),
      completedAt: null,
    });

    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "compaction", {
        phase: "end",
        willRetry: true,
        completed: true,
      }),
    );

    expect(host.compactionStatus).toEqual({
      phase: "retrying",
      runId: "run-1",
      startedAt: expect.any(Number),
      completedAt: null,
    });
    expect(host.compactionClearTimer).toBeNull();

    handleAgentEvent(host, agentEvent("run-2", 3, "lifecycle", { phase: "end" }));

    expect(host.compactionStatus).toEqual({
      phase: "retrying",
      runId: "run-1",
      startedAt: expect.any(Number),
      completedAt: null,
    });

    handleAgentEvent(host, agentEvent("run-1", 4, "lifecycle", { phase: "end" }));

    expectCompactionCompleteAndAutoClears(host);

    vi.useRealTimers();
  });

  it("treats lifecycle error as terminal for retry-pending compaction", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, agentEvent("run-1", 1, "compaction", { phase: "start" }));

    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "compaction", {
        phase: "end",
        willRetry: true,
        completed: true,
      }),
    );

    expect(host.compactionStatus).toEqual({
      phase: "retrying",
      runId: "run-1",
      startedAt: expect.any(Number),
      completedAt: null,
    });

    handleAgentEvent(host, agentEvent("run-1", 3, "lifecycle", { phase: "error", error: "boom" }));

    expectCompactionCompleteAndAutoClears(host);

    vi.useRealTimers();
  });

  it("does not surface retrying or complete when retry compaction failed", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, agentEvent("run-1", 1, "compaction", { phase: "start" }));

    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "compaction", {
        phase: "end",
        willRetry: true,
        completed: false,
      }),
    );

    expect(host.compactionStatus).toBeNull();
    expect(host.compactionClearTimer).toBeNull();

    handleAgentEvent(host, agentEvent("run-1", 3, "lifecycle", { phase: "error", error: "boom" }));

    expect(host.compactionStatus).toBeNull();
    expect(host.compactionClearTimer).toBeNull();

    vi.useRealTimers();
  });
});

// Verifies the gateway-broadcast contract bridge: gateway sends chat deltas as
// monotonic full snapshots (pre-tool + post-tool concatenated). When a tool
// starts mid-run, handleAgentEvent must commit the active stream into
// chatStreamSegments AND record the snapshot length so handleChatEvent can
// slice the next delta into post-tool-only text. Without the length bump, the
// pre-tool prefix renders twice (once committed above the tool card, once in
// the active stream below it). See PR #54374 review history.
describe("app-tool-stream tool boundary segment offset bookkeeping", () => {
  it("bumps chatStreamCommittedLen when committing a stream segment on tool start", () => {
    const host = createHost({
      chatRunId: "run-1",
      chatStream: "Before tool",
      chatStreamStartedAt: 100,
      chatStreamCommittedLen: 0,
    });

    handleAgentEvent(
      host,
      agentEvent("run-1", 1, "tool", {
        phase: "start",
        name: "read",
        toolCallId: "tool-1",
      }),
    );

    expect(host.chatStreamSegments).toHaveLength(1);
    expect(host.chatStreamSegments[0]?.text).toBe("Before tool");
    expect(host.chatStream).toBe(null);
    expect(host.chatStreamStartedAt).toBe(null);
    expect(host.chatStreamCommittedLen).toBe("Before tool".length);
  });

  it("accumulates committed length across multiple tool boundaries in one run", () => {
    const host = createHost({
      chatRunId: "run-1",
      chatStream: "Before tool",
      chatStreamStartedAt: 100,
      chatStreamCommittedLen: 0,
    });

    // First tool boundary commits "Before tool" (length 11).
    handleAgentEvent(
      host,
      agentEvent("run-1", 1, "tool", {
        phase: "start",
        name: "read",
        toolCallId: "tool-1",
      }),
    );
    expect(host.chatStreamCommittedLen).toBe(11);

    // Simulate handleChatEvent placing the next post-tool slice into chatStream
    // (the slice handleChatEvent computes from the gateway's full snapshot).
    host.chatStream = "After first";
    host.chatStreamStartedAt = 200;

    // Second tool boundary commits another "After first" (length 11). Total
    // committed prefix in upstream snapshot = 11 + 11 = 22 characters.
    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "tool", {
        phase: "start",
        name: "edit",
        toolCallId: "tool-2",
      }),
    );

    expect(host.chatStreamSegments).toHaveLength(2);
    expect(host.chatStreamSegments[0]?.text).toBe("Before tool");
    expect(host.chatStreamSegments[1]?.text).toBe("After first");
    expect(host.chatStreamCommittedLen).toBe(22);
  });

  it("does not bump chatStreamCommittedLen when there is no active stream text to commit", () => {
    const host = createHost({
      chatRunId: "run-1",
      chatStream: null,
      chatStreamCommittedLen: 0,
    });

    handleAgentEvent(
      host,
      agentEvent("run-1", 1, "tool", {
        phase: "start",
        name: "read",
        toolCallId: "tool-1",
      }),
    );

    expect(host.chatStreamSegments).toHaveLength(0);
    expect(host.chatStreamCommittedLen).toBe(0);
  });

  it("does not commit or bump for whitespace-only stream text", () => {
    const host = createHost({
      chatRunId: "run-1",
      chatStream: "   ",
      chatStreamCommittedLen: 0,
    });

    handleAgentEvent(
      host,
      agentEvent("run-1", 1, "tool", {
        phase: "start",
        name: "read",
        toolCallId: "tool-1",
      }),
    );

    expect(host.chatStreamSegments).toHaveLength(0);
    expect(host.chatStreamCommittedLen).toBe(0);
  });
});
