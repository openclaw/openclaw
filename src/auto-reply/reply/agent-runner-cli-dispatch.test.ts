// Tests CLI dispatch arguments and runtime selection for agent runner turns.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { clearCliSessionInStore } from "../../agents/cli-session-store.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  resetAgentEventsForTest,
} from "../../infra/agent-events.js";
import {
  createCliToolSummaryTracker,
  keepCliSessionBindingOnlyWhenReused,
  runCliAgentWithLifecycle as runCliAgentWithLifecycleProduction,
} from "./agent-runner-cli-dispatch.js";

type ProductionLifecycleParams = Parameters<typeof runCliAgentWithLifecycleProduction>[0];
type RunCliAgentWithLifecycleParams = Omit<ProductionLifecycleParams, "runParams"> & {
  runParams: Omit<ProductionLifecycleParams["runParams"], "admittedRunContext">;
};
const runCliAgentWithLifecycle = (params: RunCliAgentWithLifecycleParams) =>
  runCliAgentWithLifecycleProduction({
    ...params,
    runParams: withTestAdmittedRunContext(params.runParams),
  });
function createRunParams(
  runId: string,
  overrides: Partial<RunCliAgentWithLifecycleParams["runParams"]> = {},
): RunCliAgentWithLifecycleParams["runParams"] {
  return {
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    provider: "claude-cli",
    model: "claude",
    thinkLevel: "high",
    timeoutMs: 1_000,
    runId,
    ...overrides,
  };
}

type ReasoningTextPayload = Parameters<
  NonNullable<RunCliAgentWithLifecycleParams["onReasoningText"]>
>[0];
type ReasoningProgressPayload = Parameters<
  NonNullable<RunCliAgentWithLifecycleParams["onReasoningProgress"]>
>[0];

const cliDispatchState = vi.hoisted(() => ({ runCliAgentMock: vi.fn() }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type AgentEvent = Parameters<typeof emitAgentEvent>[0];
function mockCliEvents(
  events: Array<[AgentEvent["stream"], AgentEvent["data"]]>,
  payloads: EmbeddedAgentRunResult["payloads"] = [],
) {
  cliDispatchState.runCliAgentMock.mockImplementationOnce(async ({ runId }: { runId: string }) => {
    for (const [stream, data] of events) {
      emitAgentEvent({ runId, stream, data });
    }
    return { payloads, meta: { durationMs: 1 } };
  });
}

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => cliDispatchState.runCliAgentMock(...args),
}));

afterEach(() => {
  vi.useRealTimers();
  resetAgentEventsForTest();
  cliDispatchState.runCliAgentMock.mockReset();
});

describe("runCliAgentWithLifecycle", () => {
  it("settles workspace attribution before launching a CLI backend", async () => {
    const entered = createDeferred();
    const baseline = createDeferred();
    cliDispatchState.runCliAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
    const pending = runCliAgentWithLifecycle({
      runId: "cli-attribution",
      runParams: createRunParams("cli-attribution", {
        awaitSessionDiffBaseline: async () => {
          entered.resolve();
          await baseline.promise;
        },
      }),
    });
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "CLI launched before attribution");
      expect(cliDispatchState.runCliAgentMock).not.toHaveBeenCalled();
      baseline.resolve();
      await pending;
      expect(cliDispatchState.runCliAgentMock).toHaveBeenCalledOnce();
    } finally {
      baseline.resolve();
    }
  });

  it("bridges completed CLI compaction lifecycles to reply callbacks", async () => {
    mockCliEvents([
      ["compaction", { phase: "start", backend: "claude-cli" }],
      ["compaction", { phase: "end", backend: "claude-cli", completed: false }],
      ["compaction", { phase: "start", backend: "claude-cli" }],
      ["compaction", { phase: "end", backend: "claude-cli", completed: true }],
    ]);
    const callbacks: string[] = [];

    await runCliAgentWithLifecycle({
      runId: "run-compaction-bridge",
      onCompactionStart: async () => {
        callbacks.push("start");
      },
      onCompactionEnd: async (payload) => {
        callbacks.push(payload?.completed === false ? "incomplete" : "end");
      },
      runParams: createRunParams("run-compaction-bridge", { model: "claude-opus-4-8" }),
    });

    expect(callbacks).toEqual(["start", "incomplete", "start", "end"]);
  });

  it("normalizes shipped string-step plan events to pending typed steps", async () => {
    mockCliEvents([
      [
        "plan",
        {
          phase: "update",
          title: "Plan updated",
          source: "codex-exec",
          steps: ["Inspect", "  ", "Patch"],
        },
      ],
    ]);
    const onPlanUpdate = vi.fn(async () => undefined);

    await runCliAgentWithLifecycle({
      runId: "run-plan-legacy",
      onPlanUpdate,
      runParams: createRunParams("run-plan-legacy", { provider: "codex-cli", model: "codex" }),
    });

    expect(onPlanUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          { step: "Inspect", status: "pending" },
          { step: "Patch", status: "pending" },
        ],
      }),
    );
  });

  it("bridges thinking events to reasoning text and dedupes identical snapshots", async () => {
    mockCliEvents(
      [
        ["thinking", { text: "Thinking", delta: "Thinking", isReasoningSnapshot: true }],
        ["thinking", { text: "Thinking", delta: "", isReasoningSnapshot: true }],
        ["thinking", { text: "Thinking more", delta: " more", isReasoningSnapshot: true }],
        ["assistant", { text: "Visible answer", delta: "Visible answer" }],
      ],
      [{ text: "Visible answer" }],
    );
    const onReasoningText = vi.fn<(payload: ReasoningTextPayload) => Promise<void>>(
      async () => undefined,
    );

    const result = await runCliAgentWithLifecycle({
      runId: "run-thinking-bridge",
      onReasoningText,
      runParams: createRunParams("run-thinking-bridge"),
    });

    expect(onReasoningText).toHaveBeenCalledTimes(2);
    expect(onReasoningText.mock.calls.map((call) => call[0])).toEqual([
      { text: "Thinking", isReasoningSnapshot: true },
      { text: "Thinking more", isReasoningSnapshot: true },
    ]);
    expect(result.payloads).toEqual([
      { text: "Thinking more", isReasoning: true },
      { text: "Visible answer" },
    ]);
  });

  it("stamps onActivity for every delivered bridge event, including reasoning-only progress", async () => {
    mockCliEvents([
      ["thinking", { progressTokens: 50 }],
      ["thinking", { progressTokens: 50 }],
      ["thinking", { progressTokens: 200 }],
    ]);
    const onActivity = vi.fn();
    const onReasoningProgress = vi.fn<(payload: ReasoningProgressPayload) => Promise<void>>(
      async () => undefined,
    );

    await runCliAgentWithLifecycle({
      runId: "run-activity-reasoning-progress",
      onActivity,
      onReasoningProgress,
      runParams: createRunParams("run-activity-reasoning-progress"),
    });

    // A run in a long pure-reasoning stretch must keep stamping activity, or
    // stale-takeover reclaims it while it is visibly thinking. Stamps are
    // per-event (delivery-independent), so dedupe downstream does not matter.
    expect(onReasoningProgress).toHaveBeenCalledTimes(2);
    expect(onActivity).toHaveBeenCalledTimes(3);
  });

  it("keeps stamping onActivity when bridges are suppressed for silent runs", async () => {
    mockCliEvents([
      ["thinking", { progressTokens: 50 }],
      ["assistant", { text: "Silent answer", delta: "Silent answer" }],
      ["assistant", { completedText: "Silent answer", assistantMessageIndex: 0 }],
    ]);
    const onActivity = vi.fn();
    const onCompletedReply = vi.fn(async (_text: string) => {});
    const onAssistantText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    const onReasoningProgress = vi.fn<(payload: ReasoningProgressPayload) => Promise<void>>(
      async () => undefined,
    );

    await runCliAgentWithLifecycle({
      runId: "run-activity-suppressed",
      suppressAssistantBridge: true,
      onActivity,
      onAssistantText,
      onCompletedReply,
      onReasoningProgress,
      runParams: createRunParams("run-activity-suppressed"),
    });

    // silentExpected runs suppress deliveries, but their events are still real
    // liveness evidence — without these stamps a healthy silent run would be
    // reclaimed as run_stalled at the takeover window.
    expect(onAssistantText).not.toHaveBeenCalled();
    expect(onCompletedReply).not.toHaveBeenCalled();
    expect(onReasoningProgress).not.toHaveBeenCalled();
    expect(onActivity).toHaveBeenCalledTimes(3);
  });

  it("stamps onActivity for assistant text without caller callbacks for that stream", async () => {
    mockCliEvents(
      [
        ["thinking", { text: "Deep thought", delta: "Deep thought", isReasoningSnapshot: true }],
        ["assistant", { text: "Visible answer", delta: "Visible answer" }],
      ],
      [{ text: "Visible answer" }],
    );
    const onActivity = vi.fn();
    const onAssistantText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    const assistantEvents: Record<string, unknown>[] = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === "run-activity-assistant" && event.stream === "assistant") {
        assistantEvents.push(event.data);
      }
    });

    try {
      await runCliAgentWithLifecycle({
        runId: "run-activity-assistant",
        onActivity,
        onAssistantText,
        runParams: createRunParams("run-activity-assistant"),
      });
    } finally {
      stop();
    }

    // Every real event stamps, independent of which callbacks are registered.
    expect(onAssistantText).toHaveBeenCalledTimes(1);
    expect(onActivity).toHaveBeenCalledTimes(2);
    expect(assistantEvents).toEqual([
      { text: "Visible answer", delta: "Visible answer" },
      { itemId: "cli-assistant:run-activity-assistant", text: "Visible answer" },
    ]);
  });

  it("keeps the captured lifecycle generation on the start event", async () => {
    const events: Array<{
      stream?: string;
      lifecycleGeneration?: string;
      agentId?: string;
      data?: Record<string, unknown>;
    }> = [];
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const stop = onAgentEvent((event) => {
      if (event.runId === "run-before-restart") {
        events.push(event);
      }
    });
    cliDispatchState.runCliAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    try {
      await runCliAgentWithLifecycle({
        runId: "run-before-restart",
        lifecycleGeneration,
        startedAt: 1_000,
        runParams: createRunParams("run-before-restart", { agentId: "support", thinkLevel: "off" }),
      });
    } finally {
      stop();
    }

    const lifecycleEvents = events.filter((event) => event.stream === "lifecycle");
    expect(lifecycleEvents).toEqual([
      expect.objectContaining({
        lifecycleGeneration,
        agentId: "support",
        data: expect.objectContaining({ phase: "start", startedAt: 1_000 }),
      }),
    ]);
  });

  it("preserves restart ownership when the CLI resolves after cancellation", async () => {
    const events: Array<{ stream?: string; data?: Record<string, unknown> }> = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === "run-restart") {
        events.push(event);
      }
    });
    const controller = new AbortController();
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async () => {
      controller.abort(createAgentRunRestartAbortError());
      return {
        payloads: [{ text: "stale result" }],
        meta: { durationMs: 1 },
      } satisfies EmbeddedAgentRunResult;
    });

    await expect(
      runCliAgentWithLifecycle({
        runId: "run-restart",
        runParams: createRunParams("run-restart", {
          thinkLevel: "off",
          abortSignal: controller.signal,
        }),
      }),
    ).rejects.toThrow("agent run aborted for restart");
    stop();

    expect(events.some((event) => event.stream === "assistant")).toBe(false);
  });
});

describe("keepCliSessionBindingOnlyWhenReused", () => {
  it("keeps the first room-event CLI binding when no binding exists yet", () => {
    const result = {
      payloads: [],
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "new-cli-session",
          provider: "claude-cli",
          model: "claude-opus-4-8",
          cliSessionBinding: {
            sessionId: "new-cli-session",
            authProfileId: "profile",
          },
        },
      },
    } satisfies EmbeddedAgentRunResult;

    expect(keepCliSessionBindingOnlyWhenReused({ result })).toBe(result);
  });

  it("drops a replacement room-event CLI binding when an existing binding was reused", () => {
    const onDroppedReplacement = vi.fn();
    const result = keepCliSessionBindingOnlyWhenReused({
      existingSessionId: "existing-cli-session",
      onDroppedReplacement,
      result: {
        payloads: [],
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "replacement-cli-session",
            provider: "claude-cli",
            model: "claude-opus-4-8",
            cliSessionBinding: {
              sessionId: "replacement-cli-session",
              authProfileId: "profile",
            },
          },
        },
      } satisfies EmbeddedAgentRunResult,
    });

    expect(onDroppedReplacement).toHaveBeenCalledOnce();
    expect(result.meta.agentMeta?.sessionId).toBe("");
    expect(result.meta.agentMeta?.cliSessionBinding).toBeUndefined();
  });
});

describe("clearCliSessionInStore", () => {
  it.each(["current", "closed"])(
    "clears active and stored entries only for a %s owner",
    async (owner) => {
      const activeEntry = {
        sessionId: "openclaw-active",
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: "stale-session" } },
        cliSessionIds: { "claude-cli": "stale-session" },
        claudeCliSessionId: "stale-session",
      };
      const storedEntry = structuredClone(activeEntry);
      const storePath = path.join(tempDirs.make("cli-session-cleanup-"), "sessions.json");
      await replaceSessionEntry({ storePath, sessionKey: "main" }, structuredClone(activeEntry));

      let open = true;
      const clear = clearCliSessionInStore({
        agentId: "main",
        provider: "claude-cli",
        expectedCliSessionId: "stale-session",
        expectedSessionId: activeEntry.sessionId,
        sessionKey: "main",
        sessionStore: { main: storedEntry },
        storePath,
        activeSessionEntry: activeEntry,
        assertCommitAllowed: () => {
          if (!open) {
            throw new Error("owner closed");
          }
        },
      });
      if (owner === "closed") {
        open = false;
        await expect(clear).rejects.toThrow("owner closed");
        for (const entry of [
          activeEntry,
          storedEntry,
          loadSessionEntry({ storePath, sessionKey: "main" }),
        ]) {
          expect(entry?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe("stale-session");
        }
        return;
      }
      await clear;

      for (const entry of [activeEntry, storedEntry]) {
        expect(entry.cliSessionBindings?.["claude-cli"]).toBeUndefined();
        expect(entry.cliSessionIds?.["claude-cli"]).toBeUndefined();
        expect(entry.claudeCliSessionId).toBeUndefined();
        expect(entry.updatedAt).toBeGreaterThan(1);
      }
      const persisted = loadSessionEntry({ storePath, sessionKey: "main" });
      expect(persisted?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
      expect(persisted?.cliSessionIds?.["claude-cli"]).toBeUndefined();
      expect(persisted?.claudeCliSessionId).toBeUndefined();
    },
  );

  it("does not clear a replacement binding adopted by another turn", async () => {
    const entry = {
      sessionId: "openclaw-active",
      updatedAt: 1,
      cliSessionBindings: { "claude-cli": { sessionId: "replacement-session" } },
      cliSessionIds: { "claude-cli": "replacement-session" },
      claudeCliSessionId: "replacement-session",
    };

    await clearCliSessionInStore({
      agentId: "main",
      provider: "claude-cli",
      expectedCliSessionId: "stale-session",
      activeSessionEntry: entry,
    });

    expect(entry.cliSessionBindings["claude-cli"].sessionId).toBe("replacement-session");
    expect(entry.cliSessionIds["claude-cli"]).toBe("replacement-session");
    expect(entry.claudeCliSessionId).toBe("replacement-session");
    expect(entry.updatedAt).toBe(1);
  });
});

describe("createCliToolSummaryTracker", () => {
  function createTracker(
    overrides: Partial<Parameters<typeof createCliToolSummaryTracker>[0]> = {},
  ) {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      commandDetailsVisible: false,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      ...overrides,
      deliver,
    });
    return { deliver, tracker };
  }
  const startEvent = {
    name: "exec",
    phase: "start" as const,
    args: { command: "date -u" },
    toolCallId: "tool-1",
  };
  const resultEvent = {
    name: "exec",
    phase: "result" as const,
    args: undefined,
    toolCallId: "tool-1",
    isError: false,
    result: { content: [{ type: "text", text: "Wed Jun 10 2026" }] },
  };

  it("delivers a safe exec summary using metadata captured at start", async () => {
    const { deliver, tracker } = createTracker();
    await tracker.noteToolEvent(startEvent);
    const commandBearing = await tracker.noteToolEvent(resultEvent);
    expect(commandBearing).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
    const payload = deliver.mock.calls[0]?.[0] as { text: string; isError?: boolean };
    expect(payload.text).toBe("Exec");
    expect(payload.text).not.toContain("date -u");
    expect(payload.text).not.toContain("Wed Jun 10 2026");
    expect(payload.isError).toBeUndefined();
  });

  it("renders top-level structured CLI results in full verbose output", async () => {
    const { deliver, tracker } = createTracker({
      commandDetailsVisible: true,
      shouldEmitToolOutput: () => true,
    });
    await tracker.noteToolEvent(startEvent);
    await tracker.noteToolEvent({
      ...resultEvent,
      result: [{ type: "web_search_result", title: "OpenClaw", url: "https://example.com" }],
    });

    const payload = deliver.mock.calls[0]?.[0] as { text: string };
    expect(payload.text).toContain('"type":"web_search_result"');
    expect(payload.text).toContain('"title":"OpenClaw"');
  });

  it("emits nothing while tool summaries are disabled", async () => {
    const { deliver, tracker } = createTracker({ shouldEmitToolResult: () => false });
    await tracker.noteToolEvent(startEvent);
    await tracker.noteToolEvent(resultEvent);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("leaves update_plan to the authoritative plan event instead of summarizing arguments", async () => {
    const { deliver, tracker } = createTracker({
      commandDetailsVisible: true,
      shouldEmitToolOutput: () => true,
    });
    await tracker.noteToolEvent({
      name: "update_plan",
      phase: "start",
      args: { markdown: '<progress aria-label="CI · 2/3" value="2" max="3"></progress>' },
      toolCallId: "plan-1",
    });
    await tracker.noteToolEvent({
      name: "update_plan",
      phase: "result",
      args: undefined,
      toolCallId: "plan-1",
      isError: false,
      result: { content: [{ type: "text", text: "Progress card updated" }] },
    });

    expect(deliver).not.toHaveBeenCalled();
  });

  it("keeps card errors visible without arguments in full output", async () => {
    const { deliver, tracker } = createTracker({ shouldEmitToolOutput: () => true });
    await tracker.noteToolEvent({
      name: "progress_card",
      phase: "start",
      args: { markdown: '<progress aria-label="private" value="1" max="2"></progress>' },
      toolCallId: "plan-error",
    });
    await tracker.noteToolEvent({
      name: undefined,
      phase: "result",
      args: undefined,
      toolCallId: "plan-error",
      isError: true,
      result: { content: [{ type: "text", text: "write failed" }] },
    });

    expect(deliver).toHaveBeenCalledWith({
      text: "Progress Card\n```txt\nwrite failed\n```",
      isError: true,
    });
  });
});

describe("runCliAgentWithLifecycle fast auto progress", () => {
  it("emits auto-off after the first CLI tool boundary past the threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId === "run-fast-cli") {
        events.push({ stream: evt.stream, data: evt.data });
      }
    });
    const progressPayloads: string[] = [];
    cliDispatchState.runCliAgentMock.mockImplementation(async () => {
      emitAgentEvent({
        runId: "run-fast-cli",
        stream: "tool",
        data: { phase: "start", name: "bash", toolCallId: "call-1" },
      });
      vi.setSystemTime(7_100);
      emitAgentEvent({
        runId: "run-fast-cli",
        stream: "tool",
        data: { phase: "result", name: "bash", toolCallId: "call-1" },
      });
      return {
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 7_100,
          agentMeta: { sessionId: "session-1", provider: "codex-cli", model: "gpt-5.5" },
        },
      } satisfies EmbeddedAgentRunResult;
    });

    await runCliAgentWithLifecycle({
      runId: "run-fast-cli",
      runParams: createRunParams("run-fast-cli", {
        sessionKey: "agent:main:cli-fast",
        prompt: "run one tool",
        provider: "codex-cli",
        model: "gpt-5.5",
        thinkLevel: undefined,
        timeoutMs: 60_000,
        fastMode: "auto",
        fastModeStartedAtMs: 1_000,
        fastModeAutoOnSeconds: 5,
      }),
      onFastModeAutoProgress: async (payload) => {
        if (payload.text) {
          progressPayloads.push(payload.text);
        }
      },
    });
    stop();

    const summaries = events
      .filter((event) => event.stream === "item")
      .map((event) => event.data.summary);
    expect(summaries).toContain("💨Fast: auto-off(6s>=5s)");
    expect(summaries).toContain("💨Fast: auto-on");
    expect(progressPayloads).toEqual(["💨Fast: auto-off(6s>=5s)", "💨Fast: auto-on"]);
  });
});
