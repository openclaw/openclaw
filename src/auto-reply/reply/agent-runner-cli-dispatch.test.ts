// Tests CLI dispatch arguments and runtime selection for agent runner turns.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import {
  createCliToolSummaryTracker,
  keepCliSessionBindingOnlyWhenReused,
  runCliAgentWithLifecycle,
} from "./agent-runner-cli-dispatch.js";

const cliDispatchMocks = vi.hoisted(() => ({
  emitAgentEvent: vi.fn(),
  onAgentEvent: vi.fn(() => () => undefined),
  runCliAgent: vi.fn(),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: cliDispatchMocks.runCliAgent,
}));

vi.mock("../../infra/agent-events.js", () => ({
  emitAgentEvent: cliDispatchMocks.emitAgentEvent,
  onAgentEvent: cliDispatchMocks.onAgentEvent,
}));

beforeEach(() => {
  vi.clearAllMocks();
  cliDispatchMocks.onAgentEvent.mockReturnValue(() => undefined);
});

describe("runCliAgentWithLifecycle", () => {
  it("propagates yielded CLI result state on lifecycle end events", async () => {
    cliDispatchMocks.runCliAgent.mockResolvedValue({
      payloads: [],
      meta: {
        durationMs: 12,
        yielded: true,
        livenessState: "paused",
        stopReason: "end_turn",
      },
    } satisfies EmbeddedAgentRunResult);

    await runCliAgentWithLifecycle({
      runId: "run-yielded-cli",
      provider: "claude-cli",
      startedAt: 1_000,
      runParams: {
        sessionId: "session-yielded-cli",
        sessionFile: "/tmp/session-yielded-cli.jsonl",
        workspaceDir: "/tmp",
        prompt: "yield now",
        provider: "claude-cli",
        timeoutMs: 1_000,
        runId: "run-yielded-cli",
      },
    });

    const lifecycleEndEvent = cliDispatchMocks.emitAgentEvent.mock.calls
      .map(([event]) => event as { runId: string; stream: string; data: Record<string, unknown> })
      .find(
        (event) =>
          event.runId === "run-yielded-cli" &&
          event.stream === "lifecycle" &&
          event.data.phase === "end",
      );

    expect(lifecycleEndEvent?.data).toMatchObject({
      phase: "end",
      startedAt: 1_000,
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
    });
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
