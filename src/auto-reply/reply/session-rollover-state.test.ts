import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveReplySessionRolloverState } from "./session-rollover-state.js";

describe("resolveReplySessionRolloverState", () => {
  it("preserves the Telegram topic name across reply-session rollover", () => {
    const entry = {
      sessionId: "session-before-rollover",
      updatedAt: 1,
      topicName: "Existing topic",
    } as SessionEntry;

    expect(
      resolveReplySessionRolloverState(entry, "agent:main:telegram:direct:123:topic:7"),
    ).toMatchObject({ topicName: "Existing topic" });
  });
});
