import { expect, it } from "vitest";
import { buildSessionEventContext } from "./session-event-context.js";

it.for([
  { route: "the session's own WebChat route", to: "agent:main:webchat-owner", chatType: "direct" },
  { route: "another session's WebChat route", to: "agent:main:other", chatType: undefined },
])("keeps the session chat type only for $route", ({ to, chatType }) => {
  const ctx = buildSessionEventContext({
    cfg: {},
    agentId: "main",
    sessionKey: "agent:main:webchat-owner",
    text: "Exec completed.",
    options: { source: "exec" },
    occurrenceId: "exec-occurrence",
    deliveryContext: { channel: "webchat", to },
    target: { sessionId: "existing-session", generation: "current", chatType: "direct" },
    assertCurrent() {},
  });
  expect(ctx.ChatType).toBe(chatType);
});
