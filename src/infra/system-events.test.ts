import { beforeEach, describe, expect, it } from "vitest";

import { prependSystemEvents } from "../auto-reply/reply/session-updates.js";
import type { ClawdbotConfig } from "../config/config.js";
import {
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "./system-events.js";

const cfg = {} as unknown as ClawdbotConfig;

describe("system events (session routing)", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
  });

  it("does not leak session-scoped events into main", async () => {
    enqueueSystemEvent("Discord reaction added: ✅", {
      sessionKey: "discord:group:123",
      contextKey: "discord:reaction:added:msg:user:✅",
    });

    expect(peekSystemEvents()).toEqual([]);
    expect(peekSystemEvents("discord:group:123")).toEqual([
      "Discord reaction added: ✅",
    ]);

    const main = await prependSystemEvents({
      cfg,
      sessionKey: "main",
      isMainSession: true,
      isNewSession: false,
      prefixedBodyBase: "hello",
    });
    expect(main).toBe("hello");
    expect(peekSystemEvents("discord:group:123")).toEqual([
      "Discord reaction added: ✅",
    ]);

    const discord = await prependSystemEvents({
      cfg,
      sessionKey: "discord:group:123",
      isMainSession: false,
      isNewSession: false,
      prefixedBodyBase: "hi",
    });
    expect(discord).toBe("System: Discord reaction added: ✅\n\nhi");
    expect(peekSystemEvents("discord:group:123")).toEqual([]);
  });

  it("defaults system events to main", async () => {
    enqueueSystemEvent("Node: Mac Studio");

    const main = await prependSystemEvents({
      cfg,
      sessionKey: "main",
      isMainSession: true,
      isNewSession: false,
      prefixedBodyBase: "ping",
    });
    expect(main).toBe("System: Node: Mac Studio\n\nping");
  });
});
