import { expect } from "vitest";

/** Checks both run replacement and the session-change broadcast emitted after steer. */
export function expectSubagentFollowupReactivation(params: {
  replaceSubagentRunAfterSteerMock: unknown;
  broadcastToConnIds: unknown;
  completedRun: unknown;
  childSessionKey: string;
  status: "queued" | "running";
  /**
   * Canonical follow-up prompt text the caller passed to
   * `reactivateCompletedSubagentSession`. Mirrors the `task` override now
   * threaded through `replaceSubagentRunAfterSteer` so restart redispatch
   * rewraps the dispatched follow-up instead of the stale original task.
   */
  task?: string;
}) {
  expect(params.replaceSubagentRunAfterSteerMock).toHaveBeenCalledWith({
    previousRunId: "run-old",
    nextRunId: "run-new",
    fallback: params.completedRun,
    runTimeoutSeconds: 0,
    persistenceFailure: "throw",
    ...(params.task ? { task: params.task } : {}),
  });
  expect(params.broadcastToConnIds).toHaveBeenNthCalledWith(
    1,
    "sessions.changed",
    expect.objectContaining({
      sessionKey: params.childSessionKey,
      reason: "send",
      status: params.status,
      startedAt: 123,
      endedAt: null,
      runtimeMs: 10,
    }),
    new Set(["conn-1"]),
    { agentId: "main", dropIfSlow: true, sessionKeys: [params.childSessionKey] },
  );
}
