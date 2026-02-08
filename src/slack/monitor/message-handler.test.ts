import { describe, expect, it } from "vitest";
import type { SlackMessageEvent } from "../types.js";
import { dedupeSlackInboundEntries } from "./message-handler.js";

describe("dedupeSlackInboundEntries", () => {
  const makeMessage = (ts: string, text: string): SlackMessageEvent =>
    ({
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text,
      ts,
    }) as SlackMessageEvent;

  it("dedupes by ts and prefers mentioned entries", () => {
    const entries = [
      {
        message: makeMessage("1.000", "Hi"),
        opts: { source: "message" as const },
      },
      {
        message: makeMessage("1.000", "Hi"),
        opts: { source: "app_mention" as const, wasMentioned: true },
      },
      {
        message: makeMessage("2.000", "Next"),
        opts: { source: "message" as const },
      },
    ];

    const deduped = dedupeSlackInboundEntries(entries);

    expect(deduped).toHaveLength(2);
    expect(deduped[0].message.ts).toBe("1.000");
    expect(deduped[0].opts.wasMentioned).toBe(true);
    expect(deduped[1].message.ts).toBe("2.000");
  });

  it("keeps distinct timestamps in order", () => {
    const entries = [
      {
        message: makeMessage("1.000", "First"),
        opts: { source: "message" as const },
      },
      {
        message: makeMessage("2.000", "Second"),
        opts: { source: "message" as const },
      },
    ];

    const deduped = dedupeSlackInboundEntries(entries);

    expect(deduped.map((entry) => entry.message.ts)).toEqual(["1.000", "2.000"]);
  });
});
