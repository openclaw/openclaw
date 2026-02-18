import { describe, expect, it } from "vitest";
import { resolveSlackGroupRequireMention, resolveSlackGroupToolPolicy } from "./group-mentions.js";

const cfg = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channels: {
        alerts: {
          requireMention: false,
          tools: { allow: ["message.send"] },
          toolsBySender: {
            "user:alice": { allow: ["sessions.list"] },
          },
        },
        "*": {
          requireMention: true,
          tools: { deny: ["exec"] },
        },
      },
    },
  },
  // oxlint-disable-next-line typescript/no-explicit-any
} as any;

describe("group mentions (slack)", () => {
  it("uses matched channel requireMention and wildcard fallback", () => {
    expect(resolveSlackGroupRequireMention({ cfg, groupChannel: "#alerts" })).toBe(false);
    expect(resolveSlackGroupRequireMention({ cfg, groupChannel: "#missing" })).toBe(true);
  });

  it("resolves sender override, then channel tools, then wildcard tools", () => {
    const senderOverride = resolveSlackGroupToolPolicy({
      cfg,
      groupChannel: "#alerts",
      senderId: "user:alice",
    });
    expect(senderOverride).toEqual({ allow: ["sessions.list"] });

    const channelTools = resolveSlackGroupToolPolicy({
      cfg,
      groupChannel: "#alerts",
      senderId: "user:bob",
    });
    expect(channelTools).toEqual({ allow: ["message.send"] });

    const wildcardTools = resolveSlackGroupToolPolicy({
      cfg,
      groupChannel: "#missing",
      senderId: "user:bob",
    });
    expect(wildcardTools).toEqual({ deny: ["exec"] });
  });
});
