import { afterEach, expect, it, vi } from "vitest";
import {
  emitAgentEvent,
  onAgentEventForRun,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import { claimAgentRunContext } from "../infra/agent-run-registry.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import { createSubscriptionTestFixture } from "./server-runtime-subscriptions.test-support.js";

// mock-isolation: subscriptions read the fixture config without live file I/O.
vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => ({}),
  getRuntimeConfigSnapshot: () => ({}),
}));
// mock-isolation: the audit recorder would otherwise open its own state store.
vi.mock("../audit/audit-recorder.js", () => ({
  createAuditEventRecorder: () => ({
    record: vi.fn(),
    recordTool: vi.fn(),
    recordMessage: vi.fn(),
    recordExecutionIdentity: vi.fn(),
    recordExecutionDecision: vi.fn(),
    stop: vi.fn(async () => {}),
  }),
}));

afterEach(() => resetAgentEventsForTest());

it("delivers a queued run's lifecycle start when the run links its chat while starting", async () => {
  const params = createSubscriptionTestFixture().createParams();
  const unsubs = startGatewayEventSubscriptions(params);
  const runId = "queued-followup-run";
  const sessionKey = "agent:main:main";
  claimAgentRunContext(runId, { sessionId: "queued-followup-session", sessionKey });
  // A queued chat turn links its client run from the run's own start notification.
  const stopRunListener = onAgentEventForRun(runId, (evt) => {
    if (evt.stream === "lifecycle" && evt.data.phase === "start") {
      params.chatRunState.registry.add(runId, { sessionKey, clientRunId: runId });
    }
  });
  try {
    for (const phase of ["preparing_workspace", "preparing_context"]) {
      emitAgentEvent({ runId, sessionKey, stream: "run_status", data: { phase } });
    }
    emitAgentEvent({
      runId,
      sessionKey,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    emitAgentEvent({ runId, sessionKey, stream: "run_status", data: { phase: "starting_model" } });
    await vi.waitFor(() =>
      expect(params.broadcast).toHaveBeenCalledWith(
        "agent",
        expect.objectContaining({ stream: "run_status", data: { phase: "starting_model" } }),
        expect.anything(),
      ),
    );
    const agentPayloads = vi
      .mocked(params.broadcast)
      .mock.calls.filter(([event]) => event === "agent")
      .map(([, payload]) => payload as { stream?: string; data?: { phase?: string } });
    expect(agentPayloads).toContainEqual(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({ phase: "start" }),
      }),
    );
    // Clients must not be told the stream broke ("seq gap") for a start the Gateway delivered.
    expect(agentPayloads.filter((payload) => payload.stream === "error")).toEqual([]);
  } finally {
    stopRunListener();
    await unsubs.agentUnsub();
  }
});
