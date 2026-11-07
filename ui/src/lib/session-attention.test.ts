// @vitest-environment node
import { expect, it } from "vitest";
import { sessionRowAttention } from "./session-attention.ts";

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
