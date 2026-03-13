import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getChannelActivity,
  recordChannelActivity,
  resetChannelActivityForTest,
} from "./channel-activity.js";

describe("channel activity", () => {
  beforeEach(() => {
    resetChannelActivityForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-08T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the default account for blank inputs and falls back to null timestamps", () => {
    expect(getChannelActivity({ channel: "telegram" })).toEqual({
      inboundAt: null,
      outboundAt: null,
    });

    recordChannelActivity({
      channel: "telegram",
      accountId: "  ",
      direction: "inbound",
    });

    expect(getChannelActivity({ channel: "telegram", accountId: null })).toEqual({
      inboundAt: 1767830400000,
      outboundAt: null,
    });
  });

  it("keeps inbound and outbound timestamps independent and trims account ids", () => {
    recordChannelActivity({
      channel: "whatsapp",
      accountId: " team-a ",
      direction: "inbound",
      at: 10,
    });
    recordChannelActivity({
      channel: "whatsapp",
      accountId: "team-a",
      direction: "outbound",
      at: 20,
    });
    recordChannelActivity({
      channel: "whatsapp",
      accountId: "team-a",
      direction: "inbound",
      at: 30,
    });

    expect(getChannelActivity({ channel: "whatsapp", accountId: " team-a " })).toEqual({
      inboundAt: 30,
      outboundAt: 20,
    });
  });

  it("reset clears previously recorded activity", () => {
    recordChannelActivity({ channel: "line", direction: "outbound", at: 7 });
    resetChannelActivityForTest();

    expect(getChannelActivity({ channel: "line" })).toEqual({
      inboundAt: null,
      outboundAt: null,
    });
  });
});
