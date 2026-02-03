import { describe, expect, it } from "vitest";
import { buildMentionContext, type MentionContextParams } from "./mention-context.js";

describe("buildMentionContext", () => {
  it("detects direct mention", () => {
    const result = buildMentionContext({
      messageText: "Hey <@U12345> can you help?",
      selfUserId: "U12345",
      teammates: [],
    });

    expect(result.wasMentioned).toBe(true);
    expect(result.mentionType).toBe("direct");
  });

  it("detects no mention", () => {
    const result = buildMentionContext({
      messageText: "Just chatting here",
      selfUserId: "U12345",
      teammates: [],
    });

    expect(result.wasMentioned).toBe(false);
    expect(result.mentionType).toBe("none");
  });

  it("detects teammate mentions", () => {
    const result = buildMentionContext({
      messageText: "Hey <@U99999> what do you think?",
      selfUserId: "U12345",
      teammates: [
        {
          userId: "U99999",
          name: "data-bot",
          displayName: "Data Bot",
          isBot: true,
          deleted: false,
        },
      ],
    });

    expect(result.wasMentioned).toBe(false);
    expect(result.otherBotsMentioned).toHaveLength(1);
    expect(result.otherBotsMentioned[0].userId).toBe("U99999");
  });

  it("detects implicit mention from thread reply", () => {
    const result = buildMentionContext({
      messageText: "Thanks!",
      selfUserId: "U12345",
      teammates: [],
      isReplyToSelf: true,
    });

    expect(result.wasMentioned).toBe(true);
    expect(result.mentionType).toBe("implicit");
  });
});
