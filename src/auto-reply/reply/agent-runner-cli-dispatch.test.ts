// Tests CLI dispatch arguments and runtime selection for agent runner turns.
import { describe, expect, it, vi } from "vitest";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";

const cliDispatchMocks = vi.hoisted(() => ({
  emitAgentEvent: vi.fn(),
  runCliAgent: vi.fn(),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => cliDispatchMocks.runCliAgent(...args),
}));

vi.mock("../../infra/agent-events.js", () => ({
  emitAgentEvent: (...args: unknown[]) => cliDispatchMocks.emitAgentEvent(...args),
  onAgentEvent: vi.fn(() => () => undefined),
  withAgentRunLifecycleGeneration: (_generation: string, run: () => unknown) => run(),
}));

import {
  createCliToolSummaryTracker,
  keepCliSessionBindingOnlyWhenReused,
  runCliAgentWithLifecycle,
} from "./agent-runner-cli-dispatch.js";

describe("runCliAgentWithLifecycle", () => {
  it("keeps the captured lifecycle generation on start and terminal events", async () => {
    cliDispatchMocks.emitAgentEvent.mockClear();
    cliDispatchMocks.runCliAgent.mockResolvedValueOnce({
      payloads: [],
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    await runCliAgentWithLifecycle({
      runId: "run-before-restart",
      lifecycleGeneration: "pre-restart-generation",
      provider: "claude-cli",
      runParams: {
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        provider: "claude-cli",
        model: "claude",
        thinkLevel: "off",
        timeoutMs: 1_000,
        runId: "run-before-restart",
      },
    });

    const lifecycleEvents = cliDispatchMocks.emitAgentEvent.mock.calls
      .map(([event]) => event as { stream?: string; lifecycleGeneration?: string })
      .filter((event) => event.stream === "lifecycle");
    expect(lifecycleEvents).toHaveLength(2);
    expect(
      lifecycleEvents.every((event) => event.lifecycleGeneration === "pre-restart-generation"),
    ).toBe(true);
  });

  it("preserves restart ownership when the CLI resolves after cancellation", async () => {
    cliDispatchMocks.emitAgentEvent.mockClear();
    const controller = new AbortController();
    cliDispatchMocks.runCliAgent.mockImplementationOnce(async () => {
      controller.abort(createAgentRunRestartAbortError());
      return {
        payloads: [{ text: "stale result" }],
        meta: { durationMs: 1 },
      } satisfies EmbeddedAgentRunResult;
    });

    await expect(
      runCliAgentWithLifecycle({
        runId: "run-restart",
        provider: "claude-cli",
        runParams: {
          sessionId: "session-1",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp/workspace",
          prompt: "hello",
          provider: "claude-cli",
          model: "claude",
          thinkLevel: "off",
          timeoutMs: 1_000,
          runId: "run-restart",
          abortSignal: controller.signal,
        },
      }),
    ).rejects.toThrow("agent run aborted for restart");

    const terminal = cliDispatchMocks.emitAgentEvent.mock.calls
      .map(([event]) => event as { stream?: string; data?: Record<string, unknown> })
      .find((event) => event.stream === "lifecycle" && event.data?.phase === "error");
    expect(terminal?.data).toMatchObject({
      aborted: true,
      stopReason: "restart",
    });
    expect(
      cliDispatchMocks.emitAgentEvent.mock.calls.some(
        ([event]) => (event as { stream?: string }).stream === "assistant",
      ),
    ).toBe(false);
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

describe("createCliToolSummaryTracker", () => {
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

  it("delivers a tool summary for a result using meta captured at start", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      deliver,
    });
    await tracker.noteToolEvent(startEvent);
    await tracker.noteToolEvent(resultEvent);
    expect(deliver).toHaveBeenCalledTimes(1);
    const payload = deliver.mock.calls[0]?.[0] as { text: string; isError?: boolean };
    expect(payload.text).toContain("date -u");
    expect(payload.text).not.toContain("Wed Jun 10 2026");
    expect(payload.isError).toBeUndefined();
  });

  it("appends the tool output block when full verbose output is enabled", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => true,
      deliver,
    });
    await tracker.noteToolEvent(startEvent);
    await tracker.noteToolEvent(resultEvent);
    const payload = deliver.mock.calls[0]?.[0] as { text: string };
    expect(payload.text).toContain("```txt");
    expect(payload.text).toContain("Wed Jun 10 2026");
  });

  it("emits nothing while tool summaries are disabled", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
      deliver,
    });
    await tracker.noteToolEvent(startEvent);
    await tracker.noteToolEvent(resultEvent);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("propagates tool errors on the summary payload", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      deliver,
    });
    await tracker.noteToolEvent(startEvent);
    await tracker.noteToolEvent({ ...resultEvent, isError: true });
    const payload = deliver.mock.calls[0]?.[0] as { isError?: boolean };
    expect(payload.isError).toBe(true);
  });

  it("summarizes results without a tracked start event", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      deliver,
    });
    await tracker.noteToolEvent({ ...resultEvent, toolCallId: "unseen" });
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
