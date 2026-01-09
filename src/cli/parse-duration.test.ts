import { describe, expect, it } from "vitest";

import { parseDurationMs } from "./parse-duration.js";

describe("parseDurationMs", () => {
  it("parses bare ms", () => {
    expect(parseDurationMs("10000")).toBe(10_000);
  });

  it("parses seconds suffix", () => {
    expect(parseDurationMs("10s")).toBe(10_000);
  });

  it("parses minutes suffix", () => {
    expect(parseDurationMs("1m")).toBe(60_000);
  });

  it("parses hours suffix", () => {
    expect(parseDurationMs("2h")).toBe(7_200_000);
  });

  it("parses days suffix", () => {
    expect(parseDurationMs("2d")).toBe(172_800_000);
  });

  it("supports decimals", () => {
    expect(parseDurationMs("0.5s")).toBe(500);
  });
});
