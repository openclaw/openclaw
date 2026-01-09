import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getProviderActivity,
  recordProviderActivity,
  resetProviderActivityForTest,
} from "./provider-activity.js";

describe("provider activity", () => {
  beforeEach(() => {
    resetProviderActivityForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-08T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records inbound/outbound separately", () => {
    recordProviderActivity({ provider: "telegram", direction: "inbound" });
    vi.advanceTimersByTime(1000);
    recordProviderActivity({ provider: "telegram", direction: "outbound" });
    const res = getProviderActivity({ provider: "telegram" });
    expect(res.inboundAt).toBe(1767830400000);
    expect(res.outboundAt).toBe(1767830401000);
  });

  it("isolates accounts", () => {
    recordProviderActivity({
      provider: "whatsapp",
      accountId: "a",
      direction: "inbound",
      at: 1,
    });
    recordProviderActivity({
      provider: "whatsapp",
      accountId: "b",
      direction: "inbound",
      at: 2,
    });
    expect(
      getProviderActivity({ provider: "whatsapp", accountId: "a" }),
    ).toEqual({
      inboundAt: 1,
      outboundAt: null,
    });
    expect(
      getProviderActivity({ provider: "whatsapp", accountId: "b" }),
    ).toEqual({
      inboundAt: 2,
      outboundAt: null,
    });
  });
});
