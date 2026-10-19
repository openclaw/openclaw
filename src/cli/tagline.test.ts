// Tagline tests cover CLI tagline selection and display formatting.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickTagline } from "./tagline.js";

const EXPECTED_DEFAULT_TAGLINE = "All your chats, one OpenClaw.";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("pickTagline", () => {
  it("returns empty string when mode is off", () => {
    expect(pickTagline({ mode: "off" })).toBe("");
  });

  it("returns default tagline when mode is default", () => {
    expect(pickTagline({ mode: "default" })).toBe(EXPECTED_DEFAULT_TAGLINE);
  });

  it("keeps OPENCLAW_TAGLINE_INDEX behavior in random mode", () => {
    const value = pickTagline({
      mode: "random",
      env: { OPENCLAW_TAGLINE_INDEX: "0" } as NodeJS.ProcessEnv,
    });
    expect(value).toBe(
      "Your terminal just grew claws\u2014type something and let the bot pinch the busywork.",
    );
    expect(value).not.toBe(EXPECTED_DEFAULT_TAGLINE);
  });

  it("ignores partial OPENCLAW_TAGLINE_INDEX values", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(
      pickTagline({
        mode: "random",
        env: { OPENCLAW_TAGLINE_INDEX: "1abc" } as NodeJS.ProcessEnv,
      }),
    ).toBe("Your terminal just grew claws\u2014type something and let the bot pinch the busywork.");
  });
});

describe("future holiday tagline windows (2028-2030)", () => {
  // Regression coverage for the 2028-2030 floating-holiday rows. Before those
  // rows existed, the holiday rule returned false for these dates and the
  // tagline was silently filtered out of the active pool. activeTaglines is no
  // longer exported, so sample pickTagline() across the pool with a fixed UTC
  // date and controlled randomness to check that each holiday is present.
  const activePoolOn = (year: number, monthIndex: number, day: number): string[] => {
    vi.setSystemTime(Date.UTC(year, monthIndex, day, 12, 0, 0));
    const random = vi.spyOn(Math, "random");
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const r = i / 200;
      random.mockReturnValue(r);
      seen.add(pickTagline({ mode: "random" }));
    }
    return [...seen];
  };
  const poolHas = (pool: string[], term: string) =>
    pool.some((t) => t.toLowerCase().includes(term));

  it("activates the Diwali tagline on 2029-11-05", () => {
    expect(poolHas(activePoolOn(2029, 10, 5), "diwali")).toBe(true);
  });

  it("activates the Diwali tagline on 2030-10-25", () => {
    expect(poolHas(activePoolOn(2030, 9, 25), "diwali")).toBe(true);
  });
});
