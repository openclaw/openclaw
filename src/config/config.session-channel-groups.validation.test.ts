import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("session channel group schema", () => {
  it("accepts selected non-direct peers in shared channel groups", () => {
    const parsed = OpenClawSchema.safeParse({
      session: {
        channelGroups: [
          {
            key: "ops-rooms",
            peers: [
              { channel: "discord", kind: "channel", id: "1494710434396110868" },
              { channel: "slack", accountId: "work", kind: "channel", id: "C024BE91L" },
            ],
          },
        ],
      },
      bindings: [
        {
          type: "route",
          agentId: "main",
          match: {
            channel: "discord",
            peer: { kind: "channel", id: "1494710434396110868" },
          },
          session: { channelGroup: "ops-rooms" },
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects empty channel groups so opt-in groups have at least one peer", () => {
    const parsed = OpenClawSchema.safeParse({
      session: {
        channelGroups: [{ key: "empty", peers: [] }],
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects direct peers because dmScope and identityLinks own DM sharing", () => {
    const parsed = OpenClawSchema.safeParse({
      session: {
        channelGroups: [
          {
            key: "dm-group",
            peers: [{ channel: "discord", kind: "direct", id: "1497598990336790559" }],
          },
        ],
      },
    });

    expect(parsed.success).toBe(false);
  });
});
