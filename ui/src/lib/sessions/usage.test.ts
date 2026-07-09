import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSessionUsageDateParams } from "./usage.ts";

describe("buildSessionUsageDateParams", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses UTC mode without local timezone parameters", () => {
    expect(buildSessionUsageDateParams("utc")).toEqual({ mode: "utc" });
  });

  it("sends the browser IANA timezone with the current UTC offset in local mode", () => {
    const resolvedOptions = new Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      ...resolvedOptions,
      timeZone: "Europe/Vienna",
    });
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-120);

    expect(buildSessionUsageDateParams("local")).toEqual({
      mode: "specific",
      timeZone: "Europe/Vienna",
      utcOffset: "UTC+2",
    });
  });
});
