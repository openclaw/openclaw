import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  handleAgentEvent,
  hydrateReadToolOutputFromFinalMessage,
  type FallbackStatus,
  type ToolStreamEntry,
} from "./app-tool-stream.ts";

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

  it("hydrates missing read output from final assistant text", () => {
    const host = createHost({ chatRunId: "run-1" });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "start",
        name: "read",
        toolCallId: "read-1",
        args: { path: "C:/mylog.log" },
      },
    });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 2,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "result",
        name: "read",
        toolCallId: "read-1",
      },
    });

    const hydrated = hydrateReadToolOutputFromFinalMessage(host, {
      runId: "run-1",
      text: "读取到了，内容如下：\n```txt\n[InstallShield Silent]\nVersion=v7.00\n```",
    });

    expect(hydrated).toBe(true);
    const entry = host.toolStreamById.get("read-1");
    expect(entry?.output).toContain("[InstallShield Silent]");
    expect(entry?.output).toContain("Version=v7.00");
  });

  it("hydrates latest read output by session when runId does not match", () => {
    const host = createHost({ chatRunId: "run-1" });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "start",
        name: "read",
        toolCallId: "read-1",
        args: { path: "C:/RHDSetup.log" },
      },
    });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 2,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "result",
        name: "read",
        toolCallId: "read-1",
      },
    });

    const hydrated = hydrateReadToolOutputFromFinalMessage(host, {
      runId: "different-run",
      sessionKey: "main",
      text: "ResultCode=0",
    });

    expect(hydrated).toBe(true);
    const entry = host.toolStreamById.get("read-1");
    expect(entry?.output).toContain("ResultCode=0");
  });

  it("accepts active-run tool events when session key uses a different alias", () => {
    const host = createHost({ chatRunId: "run-1", sessionKey: "main" });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "agent:main:main",
      data: {
        phase: "start",
        name: "read",
        toolCallId: "alias-read-1",
        args: { path: "README.md" },
      },
    });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 2,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "agent:main:main",
      data: {
        phase: "result",
        name: "read",
        toolCallId: "alias-read-1",
        result: { text: "alias ok" },
      },
    });

    expect(host.chatToolMessages).toHaveLength(1);
  });

  it("accepts session-scoped tool events when runId differs from active client run id", () => {
    const host = createHost({ chatRunId: "client-run-id", sessionKey: "main" });

    handleAgentEvent(host, {
      runId: "server-run-id",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "start",
        name: "read",
        toolCallId: "run-mismatch-read-1",
        args: { path: "README.md" },
      },
    });

    handleAgentEvent(host, {
      runId: "server-run-id",
      seq: 2,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "result",
        name: "read",
        toolCallId: "run-mismatch-read-1",
        result: { text: "run mismatch ok" },
      },
    });

    expect(host.chatToolMessages).toHaveLength(1);
  });

  it("accepts run-mismatch tool events when session key is the main alias", () => {
    const host = createHost({ chatRunId: "client-run-id", sessionKey: "main" });

    handleAgentEvent(host, {
      runId: "server-run-id",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "agent:main:main",
      data: {
        phase: "start",
        name: "read",
        toolCallId: "run-mismatch-alias-read-1",
        args: { path: "README.md" },
      },
    });

    handleAgentEvent(host, {
      runId: "server-run-id",
      seq: 2,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "agent:main:main",
      data: {
        phase: "result",
        name: "read",
        toolCallId: "run-mismatch-alias-read-1",
        result: { text: "run mismatch alias ok" },
      },
    });

    expect(host.chatToolMessages).toHaveLength(1);
  });
});
