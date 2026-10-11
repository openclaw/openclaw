import { describe, expect, it } from "vitest";
import {
  parseGatewayCounters,
  parseGatewayThreadStat,
  gatewayAffinityMatches,
  gatewayProcessDisappeared,
} from "../../scripts/lib/gateway-bench-load-resources.ts";

describe("Gateway load kernel counters", () => {
  it.each([
    ["ENOENT", true],
    ["ESRCH", true],
    ["EACCES", false],
    ["EIO", false],
  ])("handles disappearing procfs targets without hiding %s failures", (code, gone) => {
    expect(gatewayProcessDisappeared({ code })).toBe(gone);
  });
  it("checks observed ranges and subsets against the requested CPU set", () => {
    expect(gatewayAffinityMatches("0-3", "0,1,2,3")).toBe(true);
    expect(gatewayAffinityMatches("2", "0,1,2,3")).toBe(true);
    expect(gatewayAffinityMatches("0-31", "0,1,2,3")).toBe(false);
    expect(gatewayAffinityMatches("unavailable", "0,1,2,3")).toBe(false);
  });
  it("preserves microsecond counters without truncating or accepting invalid samples", () => {
    expect(parseGatewayCounters("usage_usec 1234\nuser_usec 1000\nsystem_usec 234\n")).toEqual({
      usage_usec: 1234,
      user_usec: 1000,
      system_usec: 234,
    });
    for (const text of [
      "usage_usec",
      "usage_usec -1",
      "usage_usec NaN",
      "usage_usec 1.5",
      "usage_usec 9007199254740992",
    ]) {
      expect(() => parseGatewayCounters(text)).toThrow("Malformed");
    }
  });

  it("parses thread identity with spaces and closing parentheses in the command name", () => {
    const fields = Array.from({ length: 30 }, () => "0");
    fields[0] = "S";
    fields[11] = "37";
    fields[12] = "11";
    fields[19] = "12345678";
    expect(parseGatewayThreadStat(`42 (worker (special)) ${fields.join(" ")}`)).toEqual({
      name: "worker (special)",
      born: "12345678",
      cpuTicks: 48,
    });
    expect(() => parseGatewayThreadStat("42 (worker) S 0")).toThrow("Malformed");
  });
});
