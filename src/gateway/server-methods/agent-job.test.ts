import { describe, expect, it } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { waitForAgentJob } from "./agent-job.js";

describe("waitForAgentJob", () => {
  it("maps lifecycle end events with aborted=true to timeout", async () => {
    const runId = `run-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const waitPromise = waitForAgentJob({ runId, timeoutMs: 1_000 });

    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt: 100 } });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "end", endedAt: 200, aborted: true },
    });

    const snapshot = await waitPromise;
    expect(snapshot).not.toBeNull();
    expect(snapshot?.status).toBe("timeout");
    expect(snapshot?.startedAt).toBe(100);
    expect(snapshot?.endedAt).toBe(200);
  });

  it("keeps non-aborted lifecycle end events as ok", async () => {
    const runId = `run-ok-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const waitPromise = waitForAgentJob({ runId, timeoutMs: 1_000 });

    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt: 300 } });
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end", endedAt: 400 } });

    const snapshot = await waitPromise;
    expect(snapshot).not.toBeNull();
    expect(snapshot?.status).toBe("ok");
    expect(snapshot?.startedAt).toBe(300);
    expect(snapshot?.endedAt).toBe(400);
  });

  it("captures latest assistant text before lifecycle end", async () => {
    const runId = `run-text-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const waitPromise = waitForAgentJob({ runId, timeoutMs: 1_000 });

    emitAgentEvent({ runId, stream: "assistant", data: { text: "draft" } });
    emitAgentEvent({ runId, stream: "assistant", data: { text: "final answer" } });
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end", endedAt: 500 } });

    const snapshot = await waitPromise;
    expect(snapshot).not.toBeNull();
    expect(snapshot?.status).toBe("ok");
    expect(snapshot?.finalAssistantText).toBe("final answer");
  });

  it("returns cached assistant text for completed runs", async () => {
    const runId = `run-cached-text-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    emitAgentEvent({ runId, stream: "assistant", data: { text: "cached reply" } });
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end", endedAt: 600 } });

    const first = await waitForAgentJob({ runId, timeoutMs: 1_000 });
    const second = await waitForAgentJob({ runId, timeoutMs: 1_000 });

    expect(first?.finalAssistantText).toBe("cached reply");
    expect(second?.finalAssistantText).toBe("cached reply");
  });

  it("aggregates delta-only assistant events before lifecycle end", async () => {
    const runId = `run-delta-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const waitPromise = waitForAgentJob({ runId, timeoutMs: 1_000 });

    emitAgentEvent({ runId, stream: "assistant", data: { delta: "hel" } });
    emitAgentEvent({ runId, stream: "assistant", data: { delta: "lo " } });
    emitAgentEvent({ runId, stream: "assistant", data: { delta: "world" } });
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end", endedAt: 700 } });

    const snapshot = await waitPromise;
    expect(snapshot).not.toBeNull();
    expect(snapshot?.status).toBe("ok");
    expect(snapshot?.finalAssistantText).toBe("hello world");
  });
});
