// Tests CLI dispatch arguments and runtime selection for agent runner turns.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { emitAgentEvent, onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import {
  keepCliSessionBindingOnlyWhenReused,
  runCliAgentWithLifecycle,
} from "./agent-runner-cli-dispatch.js";

const cliDispatchState = vi.hoisted(() => ({
  runCliAgentMock: vi.fn(),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => cliDispatchState.runCliAgentMock(...args),
}));

afterEach(() => {
  vi.useRealTimers();
  resetAgentEventsForTest();
  cliDispatchState.runCliAgentMock.mockReset();
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
      provider: "codex-cli",
      runParams: {
        sessionId: "session-1",
        sessionKey: "agent:main:cli-fast",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "run one tool",
        provider: "codex-cli",
        model: "gpt-5.5",
        timeoutMs: 60_000,
        runId: "run-fast-cli",
        fastMode: "auto",
        fastModeStartedAtMs: 1_000,
        fastModeAutoOnSeconds: 5,
      },
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
