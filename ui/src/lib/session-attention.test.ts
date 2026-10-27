// @vitest-environment node
import { expect, it } from "vitest";
import { isUnacknowledgedSessionFailure, sessionRowAttention } from "./session-attention.ts";

it("keeps a failure an alert until it is read, and alerts again for a later failure", () => {
  const failed = { status: "failed", endedAt: 10, updatedAt: 12 } as const;
  expect(isUnacknowledgedSessionFailure(failed)).toBe(true);
  expect(isUnacknowledgedSessionFailure({ ...failed, lastReadAt: 10 })).toBe(false);
  expect(isUnacknowledgedSessionFailure({ ...failed, endedAt: 20, lastReadAt: 10 })).toBe(true);
  expect(isUnacknowledgedSessionFailure({ status: "timeout", updatedAt: 5 })).toBe(true);
  expect(isUnacknowledgedSessionFailure({ status: "killed", endedAt: 10 })).toBe(false);
});

it("carries the failed session's own read-acknowledgement facts", () => {
  expect(
    sessionRowAttention({
      key: "agent:main:subagent:child",
      sessionId: "child-session",
      status: "failed",
      endedAt: 10,
      lastRunError: "Synthetic failure",
      markedUnreadAt: 5,
      sharingRole: "owner",
    }),
  ).toEqual({
    kind: "error",
    reason: "Synthetic failure",
    sourceSessionKey: "agent:main:subagent:child",
    sourceSessionId: "child-session",
    sourceMarkedUnreadAt: 5,
    sourceSharingRole: "owner",
  });
});
