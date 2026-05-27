import { describe, expect, it } from "vitest";
import {
  resolveMentionPatternPolicy,
  resolveMentionPatternsEnabled,
} from "./mention-pattern-policy.js";

describe("resolveMentionPatternPolicy", () => {
  it("defaults to enabled for backward compatibility", () => {
    expect(resolveMentionPatternsEnabled({})).toBe(true);
  });

  it("inherits the global allow mode by default", () => {
    const result = resolveMentionPatternPolicy({
      cfg: {
        messages: {
          groupChat: {
            mentionPatternsMode: "allow",
          },
        },
      },
      providerPolicy: {
        mode: "inherit",
        denyIn: ["chan-2"],
      },
      conversationId: "chan-1",
    });

    expect(result.effectiveMode).toBe("allow");
    expect(result.enabled).toBe(true);
  });

  it("disables all configured patterns when the global mode is deny", () => {
    expect(
      resolveMentionPatternsEnabled({
        cfg: {
          messages: {
            groupChat: {
              mentionPatternsMode: "deny",
            },
          },
        },
        provider: "discord",
        conversationId: "chan-1",
      }),
    ).toBe(false);
  });

  it("allows only allowIn channels when effective mode is deny", () => {
    const result = resolveMentionPatternPolicy({
      cfg: {
        messages: {
          groupChat: {
            mentionPatternsMode: "deny",
          },
        },
      },
      providerPolicy: {
        mode: "inherit",
        allowIn: ["chan-1"],
      },
      conversationId: "chan-1",
    });

    expect(result.allowMatched).toBe(true);
    expect(result.enabled).toBe(true);
  });

  it("lets provider allow mode opt back into the legacy default", () => {
    expect(
      resolveMentionPatternsEnabled({
        cfg: {
          messages: {
            groupChat: {
              mentionPatternsMode: "deny",
            },
          },
        },
        providerPolicy: {
          mode: "allow",
        },
        conversationId: "chan-1",
      }),
    ).toBe(true);
  });

  it("lets an agent group chat mode override the global mode for routed messages", () => {
    expect(
      resolveMentionPatternsEnabled({
        cfg: {
          messages: {
            groupChat: {
              mentionPatternsMode: "allow",
            },
          },
          agents: {
            list: [
              {
                id: "quiet-agent",
                groupChat: {
                  mentionPatternsMode: "deny",
                },
              },
            ],
          },
        },
        agentId: "quiet-agent",
        conversationId: "chan-1",
      }),
    ).toBe(false);
  });

  it("reads provider policy from channels.<provider>.mentionPatterns", () => {
    expect(
      resolveMentionPatternsEnabled({
        cfg: {
          channels: {
            discord: {
              mentionPatterns: {
                mode: "deny",
                allowIn: ["chan-1"],
              },
            },
          },
        },
        provider: "discord",
        conversationId: "chan-1",
      }),
    ).toBe(true);
  });

  it("accepts an empty provider policy object like the config schema", () => {
    const result = resolveMentionPatternPolicy({
      cfg: {
        channels: {
          discord: {
            mentionPatterns: {},
          },
        },
        messages: {
          groupChat: {
            mentionPatternsMode: "deny",
          },
        },
      },
      provider: "discord",
      conversationId: "chan-1",
    });

    expect(result.effectiveMode).toBe("deny");
    expect(result.enabled).toBe(false);
  });

  it("lets denyIn override allowIn when both match", () => {
    const result = resolveMentionPatternPolicy({
      providerPolicy: {
        mode: "allow",
        allowIn: ["chan-1"],
        denyIn: ["chan-1"],
      },
      conversationId: "chan-1",
    });

    expect(result.allowMatched).toBe(true);
    expect(result.denyMatched).toBe(true);
    expect(result.enabled).toBe(false);
  });
});
