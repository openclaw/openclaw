import { describe, expect, it } from "vitest";
import { buildGroupChatContext } from "./groups.js";

describe("buildGroupChatContext", () => {
  it("allows message tool usage for same-group media/file sends", () => {
    const context = buildGroupChatContext({
      sessionCtx: {
        Provider: "telegram",
        GroupSubject: "Release Ops",
        GroupMembers: "alice, bob",
      },
    } as Parameters<typeof buildGroupChatContext>[0]);

    expect(context).toContain('You are in the Telegram group chat "Release Ops".');
    expect(context).toContain("Participants: alice, bob.");
    expect(context).toContain("Reply normally for text.");
    expect(context).toContain("You may use the message tool when you need to send media/files");
    expect(context).toContain("to this same group/topic");
  });
});
