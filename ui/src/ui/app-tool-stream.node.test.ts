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

function findToolEntry(
  host: MutableHost,
  params: { toolCallId: string; runId?: string },
): ToolStreamEntry | undefined {
  for (const entry of host.toolStreamById.values()) {
    if (entry.toolCallId !== params.toolCallId) {
      continue;
    }
    if (params.runId && entry.runId !== params.runId) {
      continue;
    }
    return entry;
  }
  return undefined;
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
    const entry = findToolEntry(host, { toolCallId: "read-1", runId: "run-1" });
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
    const entry = findToolEntry(host, { toolCallId: "read-1", runId: "run-1" });
    expect(entry?.output).toContain("ResultCode=0");
  });

  it("hydrates by alias-equivalent session key when runId does not match", () => {
    const host = createHost({ chatRunId: "run-1", sessionKey: "main" });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "start",
        name: "read",
        toolCallId: "read-alias-1",
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
        toolCallId: "read-alias-1",
      },
    });

    const hydrated = hydrateReadToolOutputFromFinalMessage(host, {
      runId: "different-run",
      sessionKey: "agent:main:main",
      text: "AliasResult=ok",
    });

    expect(hydrated).toBe(true);
    const entry = findToolEntry(host, { toolCallId: "read-alias-1", runId: "run-1" });
    expect(entry?.output).toContain("AliasResult=ok");
  });

  it("hydrates earlier empty read card for the same run when latest card already has output", () => {
    const host = createHost({ chatRunId: "run-1", sessionKey: "main" });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "start",
        name: "read",
        toolCallId: "read-empty",
        args: { path: "C:/older.log" },
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
        toolCallId: "read-empty",
      },
    });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 3,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "start",
        name: "read",
        toolCallId: "read-filled",
        args: { path: "C:/newer.log" },
      },
    });
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 4,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "result",
        name: "read",
        toolCallId: "read-filled",
        result: { text: "already populated" },
      },
    });

    const hydrated = hydrateReadToolOutputFromFinalMessage(host, {
      runId: "run-1",
      text: "Recovered=ok",
    });

    expect(hydrated).toBe(true);
    expect(findToolEntry(host, { toolCallId: "read-empty", runId: "run-1" })?.output).toContain(
      "Recovered=ok",
    );
    expect(findToolEntry(host, { toolCallId: "read-filled", runId: "run-1" })?.output).toBe(
      "already populated",
    );
  });

  it("does not overwrite prior run cards when toolCallId is reused in another run", () => {
    const host = createHost({ chatRunId: "client-run-id", sessionKey: "main" });

    handleAgentEvent(host, {
      runId: "server-run-1",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "start",
        name: "read",
        toolCallId: "read-shared",
        args: { path: "README.md" },
      },
    });
    handleAgentEvent(host, {
      runId: "server-run-1",
      seq: 2,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "result",
        name: "read",
        toolCallId: "read-shared",
        result: { text: "run1 output" },
      },
    });

    handleAgentEvent(host, {
      runId: "server-run-2",
      seq: 3,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "start",
        name: "read",
        toolCallId: "read-shared",
        args: { path: "CHANGELOG.md" },
      },
    });
    handleAgentEvent(host, {
      runId: "server-run-2",
      seq: 4,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "result",
        name: "read",
        toolCallId: "read-shared",
        result: { text: "run2 output" },
      },
    });

    expect(host.chatToolMessages).toHaveLength(2);
    expect(findToolEntry(host, { toolCallId: "read-shared", runId: "server-run-1" })?.output).toBe(
      "run1 output",
    );
    expect(findToolEntry(host, { toolCallId: "read-shared", runId: "server-run-2" })?.output).toBe(
      "run2 output",
    );
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
