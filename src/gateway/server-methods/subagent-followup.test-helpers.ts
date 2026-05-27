import { expect } from "vitest";

export function expectSubagentFollowupReactivation(params: {
  replaceSubagentRunAfterSteerMock: unknown;
  broadcastToConnIds: unknown;
  completedRun: unknown;
  childSessionKey: string;
}) {
  expect(params.replaceSubagentRunAfterSteerMock).toHaveBeenCalledWith({
    previousRunId: "run-old",
    nextRunId: "run-new",
    fallback: params.completedRun,
    runTimeoutSeconds: 0,
  });
  expect(params.broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({
      sessionKey: params.childSessionKey,
      reason: "send",
      status: "running",
      startedAt: 123,
      endedAt: undefined,
    }),
    new Set(["conn-1"]),
    { dropIfSlow: true },
  );
}
