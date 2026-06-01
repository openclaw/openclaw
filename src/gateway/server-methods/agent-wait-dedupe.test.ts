import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_RUN_ABORTED_ERROR } from "../../agents/run-termination.js";
import type { DedupeEntry } from "../server-shared.js";
import {
  testing,
  readTerminalSnapshotFromGatewayDedupe,
  setGatewayDedupeEntry,
  waitForTerminalGatewayDedupe,
} from "./agent-wait-dedupe.js";

describe("agent wait dedupe helper", () => {
  function setRunEntry(params: {
    dedupe: Map<string, DedupeEntry>;
    kind: "agent" | "chat";
    runId: string;
    ts?: number;
    ok?: boolean;
    payload: Record<string, unknown>;
  }) {
    setGatewayDedupeEntry({
      dedupe: params.dedupe,
      key: `${params.kind}:${params.runId}`,
      entry: {
        ts: params.ts ?? Date.now(),
        ok: params.ok ?? true,
        payload: params.payload,
      },
    });
  }

  beforeEach(() => {
    testing.resetWaiters();
    vi.useFakeTimers();
  });

  afterEach(() => {
    testing.resetWaiters();
    vi.useRealTimers();
  });

  it("unblocks waiters when a terminal chat dedupe entry is written", async () => {
    const dedupe = new Map();
    const runId = "run-chat-terminal";
    const waiter = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 1_000,
    });

    await Promise.resolve();
    expect(testing.getWaiterCount(runId)).toBe(1);

    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      payload: {
        runId,
        status: "ok",
        startedAt: 100,
        endedAt: 200,
      },
    });

    await expect(waiter).resolves.toEqual({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      error: undefined,
    });
    expect(testing.getWaiterCount(runId)).toBe(0);
  });

  it("preserves structured yield metadata from terminal agent results", () => {
    const dedupe = new Map();
    const runId = "run-yielded";

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "ok",
        startedAt: 100,
        endedAt: 200,
        result: {
          meta: {
            stopReason: "end_turn",
            livenessState: "paused",
            yielded: true,
          },
        },
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      error: undefined,
      stopReason: "end_turn",
      livenessState: "paused",
      yielded: true,
    });
  });

  it("preserves timeout attribution from terminal agent result metadata", () => {
    const dedupe = new Map();
    const runId = "run-provider-timeout";

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "timeout",
        startedAt: 100,
        endedAt: 200,
        result: {
          meta: {
            timeoutPhase: "provider",
            providerStarted: true,
          },
        },
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "timeout",
      startedAt: 100,
      endedAt: 200,
      error: undefined,
      timeoutPhase: "provider",
      providerStarted: true,
    });
  });

  it("keeps hard timeout snapshots stronger than blocked liveness", () => {
    const dedupe = new Map();
    const runId = "run-blocked-provider-timeout";

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "error",
        startedAt: 100,
        endedAt: 200,
        error: "model timed out",
        result: {
          meta: {
            livenessState: "blocked",
            timeoutPhase: "provider",
            providerStarted: true,
          },
        },
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "timeout",
      startedAt: 100,
      endedAt: 200,
      error: "model timed out",
      livenessState: "blocked",
      timeoutPhase: "provider",
      providerStarted: true,
    });
  });

  it("normalizes blocked ok agent snapshots to errors", () => {
    const dedupe = new Map();
    const runId = "run-blocked-agent";

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "ok",
        startedAt: 100,
        endedAt: 200,
        error: "Context overflow: prompt too large for the model.",
        result: {
          meta: {
            livenessState: "blocked",
          },
        },
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "error",
      startedAt: 100,
      endedAt: 200,
      error: "Context overflow: prompt too large for the model.",
      livenessState: "blocked",
    });
  });

  it("normalizes aborted ok agent snapshots to errors", () => {
    const dedupe = new Map();
    const runId = "run-aborted-agent";

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "ok",
        startedAt: 100,
        endedAt: 200,
        result: {
          meta: {
            stopReason: "aborted",
          },
        },
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "error",
      startedAt: 100,
      endedAt: 200,
      error: AGENT_RUN_ABORTED_ERROR,
      stopReason: "aborted",
    });
  });

  it("unblocks waiters with normalized aborted snapshots", async () => {
    const dedupe = new Map();
    const runId = "run-wait-aborted";
    const waiter = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 1_000,
    });

    await Promise.resolve();
    expect(testing.getWaiterCount(runId)).toBe(1);

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "ok",
        stopReason: "aborted",
        endedAt: 300,
      },
    });

    await expect(waiter).resolves.toEqual({
      status: "error",
      endedAt: 300,
      error: AGENT_RUN_ABORTED_ERROR,
      stopReason: "aborted",
    });
    expect(testing.getWaiterCount(runId)).toBe(0);
  });

  it("keeps stale chat dedupe blocked while agent dedupe is in-flight", async () => {
    const dedupe = new Map();
    const runId = "run-stale-chat";
    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      payload: {
        runId,
        status: "ok",
      },
    });
    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "accepted",
      },
    });

    const snapshot = readTerminalSnapshotFromGatewayDedupe({
      dedupe,
      runId,
    });
    expect(snapshot).toBeNull();

    const blockedWait = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(30);
    await expect(blockedWait).resolves.toBeNull();
    expect(testing.getWaiterCount(runId)).toBe(0);
  });

  it("uses newer terminal chat snapshot when agent entry is non-terminal", () => {
    const dedupe = new Map();
    const runId = "run-nonterminal-agent-with-newer-chat";
    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 100,
      payload: {
        runId,
        status: "accepted",
      },
    });
    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      ts: 200,
      payload: {
        runId,
        status: "ok",
        startedAt: 1,
        endedAt: 2,
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "ok",
      startedAt: 1,
      endedAt: 2,
      error: undefined,
    });
  });

  it("ignores stale agent snapshots when waiting for an active chat run", async () => {
    const dedupe = new Map();
    const runId = "run-chat-active-ignore-agent";
    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "ok",
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
        ignoreAgentTerminalSnapshot: true,
      }),
    ).toBeNull();

    const wait = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 1_000,
      ignoreAgentTerminalSnapshot: true,
    });
    await Promise.resolve();
    expect(testing.getWaiterCount(runId)).toBe(1);

    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      payload: {
        runId,
        status: "ok",
        startedAt: 123,
        endedAt: 456,
      },
    });

    await expect(wait).resolves.toEqual({
      status: "ok",
      startedAt: 123,
      endedAt: 456,
      error: undefined,
    });
  });

  it("prefers the freshest terminal snapshot when agent/chat dedupe keys collide", () => {
    const runId = "run-collision";
    const dedupe = new Map();

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 100,
      payload: { runId, status: "ok", startedAt: 10, endedAt: 20 },
    });
    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      ts: 200,
      ok: false,
      payload: { runId, status: "error", startedAt: 30, endedAt: 40, error: "chat failed" },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "error",
      startedAt: 30,
      endedAt: 40,
      error: "chat failed",
    });

    const dedupeReverse = new Map();
    setRunEntry({
      dedupe: dedupeReverse,
      kind: "chat",
      runId,
      ts: 100,
      payload: { runId, status: "ok", startedAt: 1, endedAt: 2 },
    });
    setRunEntry({
      dedupe: dedupeReverse,
      kind: "agent",
      runId,
      ts: 200,
      payload: { runId, status: "timeout", startedAt: 3, endedAt: 4, error: "still running" },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe: dedupeReverse,
        runId,
      }),
    ).toEqual({
      status: "timeout",
      startedAt: 3,
      endedAt: 4,
      error: "still running",
    });
  });

  it("preserves an RPC cancel snapshot when late completion writes the same key", () => {
    const dedupe = new Map();
    const runId = "run-cancel-wins";

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 100,
      payload: {
        runId,
        status: "timeout",
        stopReason: "rpc",
        timeoutPhase: "queue",
        providerStarted: false,
        endedAt: 100,
      },
    });
    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 200,
      payload: { runId, status: "ok", endedAt: 200 },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "timeout",
      endedAt: 100,
      error: undefined,
      stopReason: "rpc",
      timeoutPhase: "queue",
      providerStarted: false,
    });
  });

  it("preserves an RPC cancel snapshot when a later accepted write reuses the key", () => {
    const dedupe = new Map();
    const runId = "run-cancel-wins-over-accepted";

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 100,
      payload: {
        runId,
        status: "timeout",
        stopReason: "rpc",
        timeoutPhase: "queue",
        providerStarted: false,
        endedAt: 100,
      },
    });
    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 200,
      payload: { runId, status: "accepted" },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "timeout",
      endedAt: 100,
      error: undefined,
      stopReason: "rpc",
      timeoutPhase: "queue",
      providerStarted: false,
    });
  });

  it("lets an earlier terminal completion correct a provisional timeout snapshot", () => {
    const dedupe = new Map();
    const runId = "run-earlier-completion-wins";

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 200,
      payload: {
        runId,
        status: "timeout",
        timeoutPhase: "provider",
        startedAt: 100,
        endedAt: 200,
      },
    });
    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 250,
      payload: {
        runId,
        status: "ok",
        startedAt: 100,
        endedAt: 190,
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "ok",
      startedAt: 100,
      endedAt: 190,
      error: undefined,
    });
  });

  it("does not make bare queue timeouts sticky", () => {
    const dedupe = new Map();
    const runId = "run-queue-timeout-replaced";

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 100,
      payload: {
        runId,
        status: "timeout",
        timeoutPhase: "queue",
        providerStarted: false,
        endedAt: 100,
      },
    });
    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 200,
      payload: { runId, status: "ok", endedAt: 200 },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "ok",
      endedAt: 200,
      error: undefined,
    });
  });

  it("preserves an RPC cancel snapshot when late rejection writes the same chat key", () => {
    const dedupe = new Map();
    const runId = "run-cancel-chat-error";

    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      ts: 100,
      payload: {
        runId,
        status: "timeout",
        stopReason: "rpc",
        timeoutPhase: "queue",
        providerStarted: false,
        endedAt: 100,
      },
    });
    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      ts: 200,
      ok: false,
      payload: { runId, status: "error", summary: "late failure", endedAt: 200 },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "timeout",
      endedAt: 100,
      error: undefined,
      stopReason: "rpc",
      timeoutPhase: "queue",
      providerStarted: false,
    });
  });

  it("resolves multiple waiters for the same run id", async () => {
    const dedupe = new Map();
    const runId = "run-multi";
    const first = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 1_000,
    });
    const second = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 1_000,
    });

    await Promise.resolve();
    expect(testing.getWaiterCount(runId)).toBe(2);

    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      payload: { runId, status: "ok" },
    });

    const firstResult = await first;
    const secondResult = await second;
    if (!firstResult || !secondResult) {
      throw new Error("expected waiters to resolve");
    }
    expect(firstResult.status).toBe("ok");
    expect(firstResult.error).toBeUndefined();
    expect(secondResult.status).toBe("ok");
    expect(secondResult.error).toBeUndefined();
    expect(testing.getWaiterCount(runId)).toBe(0);
  });

  it("cleans up waiter registration on timeout", async () => {
    const dedupe = new Map();
    const runId = "run-timeout";
    const wait = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 20,
    });

    await Promise.resolve();
    expect(testing.getWaiterCount(runId)).toBe(1);

    await vi.advanceTimersByTimeAsync(25);
    await expect(wait).resolves.toBeNull();
    expect(testing.getWaiterCount(runId)).toBe(0);
  });

  it("extracts full agentMeta from an agent dedupe payload", () => {
    const dedupe = new Map();
    const runId = "run-with-agent-meta";

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "ok",
        startedAt: 100,
        endedAt: 200,
        agentMeta: {
          usage: { inputTokens: 1500, outputTokens: 450, cachedInputTokens: 200 },
          costUsd: 0.012345,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      error: undefined,
      agentMeta: {
        usage: { inputTokens: 1500, outputTokens: 450, cachedInputTokens: 200 },
        costUsd: 0.012345,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    });
  });

  it("does NOT surface agent agentMeta when ignoreAgentTerminalSnapshot selects the chat snapshot", () => {
    // P1 regression: same-runId chat collision must not let agent telemetry
    // leak onto the selected chat response. The agent dedupe entry has
    // agentMeta; the chat dedupe entry does not. ignoreAgentTerminalSnapshot=true
    // means we picked chat — so the returned snapshot must reflect the chat
    // run's (absent) telemetry, NOT the agent run's.
    const dedupe = new Map();
    const runId = "run-chat-active-no-agentmeta-leak";

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "ok",
        startedAt: 100,
        endedAt: 200,
        agentMeta: {
          usage: { inputTokens: 9999, outputTokens: 9999, cachedInputTokens: 9999 },
          costUsd: 0.99,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      },
    });
    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      ts: 300,
      payload: {
        runId,
        status: "ok",
        startedAt: 250,
        endedAt: 280,
      },
    });

    const snapshot = readTerminalSnapshotFromGatewayDedupe({
      dedupe,
      runId,
      ignoreAgentTerminalSnapshot: true,
    });
    expect(snapshot).toEqual({
      status: "ok",
      startedAt: 250,
      endedAt: 280,
      error: undefined,
    });
    expect(snapshot?.agentMeta).toBeUndefined();
  });

  it("does NOT leak agent agentMeta when chat freshness wins via collision", () => {
    // P1 regression: when both entries are terminal and `chat:` is fresher,
    // the chat snapshot wins per the existing freshness rule. The agent's
    // agentMeta MUST NOT bleed onto the returned chat snapshot.
    const dedupe = new Map();
    const runId = "run-collision-chat-fresher-no-meta-leak";

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      ts: 100,
      payload: {
        runId,
        status: "ok",
        startedAt: 1,
        endedAt: 2,
        agentMeta: {
          usage: { inputTokens: 100, outputTokens: 50 },
          costUsd: 0.001,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      },
    });
    setRunEntry({
      dedupe,
      kind: "chat",
      runId,
      ts: 200,
      payload: { runId, status: "ok", startedAt: 30, endedAt: 40 },
    });

    const snapshot = readTerminalSnapshotFromGatewayDedupe({
      dedupe,
      runId,
    });
    expect(snapshot).toEqual({
      status: "ok",
      startedAt: 30,
      endedAt: 40,
      error: undefined,
    });
    expect(snapshot?.agentMeta).toBeUndefined();
  });

  it("returns partial agentMeta when only some fields are present", () => {
    const dedupe = new Map();
    const runId = "run-partial-agent-meta";

    setRunEntry({
      dedupe,
      kind: "agent",
      runId,
      payload: {
        runId,
        status: "ok",
        startedAt: 100,
        endedAt: 200,
        agentMeta: {
          provider: "deepseek",
          model: "deepseek-chat",
        },
      },
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      error: undefined,
      agentMeta: {
        usage: undefined,
        costUsd: undefined,
        provider: "deepseek",
        model: "deepseek-chat",
      },
    });
  });
});
