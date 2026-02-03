import { describe, expect, it } from "vitest";
import { getConsumerToolsConfig, CONSUMER_DENIED_TOOLS } from "./consumer-defaults.js";

describe("consumer-defaults", () => {
  it("should deny dangerous tools", () => {
    const config = getConsumerToolsConfig();
    expect(config.deny).toContain("exec");
    expect(config.deny).toContain("browser");
    expect(config.deny).toContain("shell");
  });

  it("should export denied tools list", () => {
    expect(CONSUMER_DENIED_TOOLS).toBeInstanceOf(Array);
    expect(CONSUMER_DENIED_TOOLS.length).toBeGreaterThan(0);
  });
});
