import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { SessionRunCompletedEventSchema } from "../../packages/gateway-protocol/src/schema/sessions-run-completed.js";
import { countActiveDescendantRuns } from "../agents/subagents/registry/subagent-registry-read.js";
import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
import { createSessionTerminalPublisher } from "./session-run-completion.js";

vi.mock("../agents/subagents/registry/subagent-registry-read.js", () => ({
  countActiveDescendantRuns: vi.fn(() => 0),
}));

function publishCompletion(params: {
  event: AgentEventRuntimePayload;
  sessionKey: string;
  runId: string;
}) {
  const broadcastToConnIds = vi.fn();
  createSessionTerminalPublisher({
    broadcastToConnIds,
    resolveActiveLifecycleGenerationForRun: () => undefined,
  }).publish({
    ...params,
    snapshot: {},
    recipients: new Set(["listener"]),
    sessionKeys: [params.sessionKey],
    completionEligible: true,
  });
  return broadcastToConnIds.mock.calls.find(([event]) => event === "session.run.completed")?.[1];
}

describe("settled run completion projection", () => {
  it("does not announce an interposed terminal while descendants are still executing", () => {
    const broadcastToConnIds = vi.fn();
    const publisher = createSessionTerminalPublisher({
      broadcastToConnIds,
      resolveActiveLifecycleGenerationForRun: () => undefined,
    });
    const publish = (runId: string) =>
      publisher.publish({
        event: {
          runId,
          seq: 1,
          ts: 100,
          stream: "lifecycle",
          data: { phase: "end", executionSettled: true },
        },
        runId,
        sessionKey: "agent:coder:task:one",
        snapshot: {},
        recipients: new Set(["listener"]),
        sessionKeys: ["agent:coder:task:one"],
        completionEligible: true,
      });
    vi.mocked(countActiveDescendantRuns).mockReturnValueOnce(1);
    publish("interposed-run");
    expect(
      broadcastToConnIds.mock.calls.filter(([event]) => event === "session.run.completed"),
    ).toEqual([]);
    expect(countActiveDescendantRuns).toHaveBeenCalledWith("agent:coder:task:one", "coder");
    publish("settled-continuation");
    expect(
      broadcastToConnIds.mock.calls.filter(([event]) => event === "session.run.completed"),
    ).toEqual([
      [
        "session.run.completed",
        {
          runId: "settled-continuation",
          sessionKey: "agent:coder:task:one",
          agentId: "coder",
          status: "ok",
        },
        new Set(["listener"]),
        { sessionKeys: ["agent:coder:task:one"], agentId: "coder" },
      ],
    ]);
  });
  it.each([
    { data: { phase: "end" }, status: "ok" },
    { data: { phase: "error", error: "private provider diagnostic" }, status: "error" },
    { data: { phase: "end", status: "timeout", timeoutPhase: "run" }, status: "timeout" },
    { data: { phase: "end", aborted: true, stopReason: "rpc" }, status: "aborted" },
  ])("projects $status without private error or transcript data", ({ data, status }) => {
    const completion = publishCompletion({
      event: {
        runId: "run",
        seq: 1,
        ts: 100,
        stream: "lifecycle",
        data: { ...data, executionSettled: true },
      },
      sessionKey: "agent:coder:task:one",
      runId: "client-run",
    });
    expect(completion).toEqual({
      agentId: "coder",
      sessionKey: "agent:coder:task:one",
      runId: "client-run",
      status,
    });
    expect(Value.Check(SessionRunCompletedEventSchema, completion)).toBe(true);
    expect(Value.Check(SessionRunCompletedEventSchema, { ...completion, message: "private" })).toBe(
      false,
    );
  });

  it("does not invent an agent owner for unscoped session keys", () => {
    expect(
      publishCompletion({
        event: {
          runId: "run",
          seq: 1,
          ts: 100,
          stream: "lifecycle",
          data: { phase: "end", executionSettled: true },
        },
        sessionKey: "global",
        runId: "run",
      }),
    ).toBeUndefined();
  });
});
