import { describe, expect, it } from "vitest";
import { resolveBrowserRequestTimeoutMs } from "./browser-cli-shared.js";

describe("resolveBrowserRequestTimeoutMs", () => {
  it("keeps command-specific fallbacks when parent timeout is still the CLI default", () => {
    expect(
      resolveBrowserRequestTimeoutMs(
        { timeout: "30000", timeoutSource: "default" },
        { fallbackMs: 1500 },
      ),
    ).toBe(1500);
  });

  it("uses the parent browser timeout when it was explicitly provided", () => {
    expect(
      resolveBrowserRequestTimeoutMs(
        { timeout: "60000", timeoutSource: "cli" },
        { fallbackMs: 1500 },
      ),
    ).toBe(60000);
  });
});
