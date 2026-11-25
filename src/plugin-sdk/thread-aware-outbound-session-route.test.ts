import { expect, it } from "vitest";
import {
  buildThreadAwareOutboundSessionRoute,
  recoverCurrentThreadSessionId,
  type ChannelOutboundSessionRoute,
} from "./core.js";

const baseSessionKey = "agent:main:workspace:channel:c123";
const currentSessionKey = `${baseSessionKey}:thread:current-1`;
const baseRoute: ChannelOutboundSessionRoute = {
  sessionKey: baseSessionKey,
  baseSessionKey,
  peer: { kind: "channel", id: "c123" },
  chatType: "channel",
  from: "workspace:channel:c123",
  to: "channel:c123",
};

it.each([
  [
    "reply precedence",
    { replyToId: "reply-1", threadId: "thread-1", currentSessionKey },
    "reply-1",
  ],
  ["numeric delivery id", { threadId: 99 }, 99],
  [
    "provider recovery veto",
    { currentSessionKey, canRecoverCurrentThread: () => false },
    undefined,
  ],
] as const)("preserves %s", (_name, input, threadId) => {
  expect(buildThreadAwareOutboundSessionRoute({ route: baseRoute, ...input })).toEqual(
    threadId === undefined
      ? baseRoute
      : { ...baseRoute, sessionKey: `${baseSessionKey}:thread:${threadId}`, threadId },
  );
});

it.each([
  [baseSessionKey, currentSessionKey, "current-1"],
  [baseSessionKey, "agent:main:workspace:channel:other:thread:current-1", undefined],
  [
    "agent:main:matrix:channel:!Mixed:example.org",
    "agent:main:matrix:channel:!mixed:example.org:thread:$Root",
    undefined,
  ],
])(
  "recovers a thread only for the matching case-sensitive base %s / %s",
  (key, current, expected) => {
    const route = { ...baseRoute, sessionKey: key, baseSessionKey: key };
    expect(recoverCurrentThreadSessionId({ route, currentSessionKey: current })).toBe(expected);
  },
);
