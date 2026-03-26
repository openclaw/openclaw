import { beforeEach, describe, expect, it, vi } from "vitest";

const getLatestSubagentRunByChildSessionKeyMock = vi.fn();
const replaceSubagentRunAfterSteerMock = vi.fn();

vi.mock("../agents/subagent-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/subagent-registry.js")>();
  return {
    ...actual,
    getLatestSubagentRunByChildSessionKey: (...args: unknown[]) =>
      getLatestSubagentRunByChildSessionKeyMock(...args),
    replaceSubagentRunAfterSteer: (...args: unknown[]) => replaceSubagentRunAfterSteerMock(...args),
  };
});

import { reactivateCompletedSubagentSession } from "./session-subagent-reactivation.js";

describe("reactivateCompletedSubagentSession", () => {
  beforeEach(() => {
    getLatestSubagentRunByChildSessionKeyMock.mockReset();
    replaceSubagentRunAfterSteerMock.mockReset();
  });

  it("reactivates the newest ended row even when stale active rows still exist for the same child session", () => {
    const childSessionKey = "agent:main:subagent:followup-race";
    const latestEndedRun = {
      runId: "run-current-ended",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current ended task",
      cleanup: "keep" as const,
      createdAt: 20,
      startedAt: 21,
      endedAt: 22,
      outcome: { status: "ok" as const },
    };

    getLatestSubagentRunByChildSessionKeyMock.mockReturnValue(latestEndedRun);
    replaceSubagentRunAfterSteerMock.mockReturnValue(true);

    expect(
      reactivateCompletedSubagentSession({
        sessionKey: childSessionKey,
        runId: "run-next",
      }),
    ).toBe(true);

    expect(getLatestSubagentRunByChildSessionKeyMock).toHaveBeenCalledWith(childSessionKey);
    expect(replaceSubagentRunAfterSteerMock).toHaveBeenCalledWith({
      previousRunId: "run-current-ended",
      nextRunId: "run-next",
      fallback: latestEndedRun,
      runTimeoutSeconds: 0,
    });
  });
});
