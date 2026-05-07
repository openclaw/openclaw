import { describe, expect, it } from "vitest";
import {
  formatConfigPath,
  resolveConfigPathTarget,
  stripUnknownConfigKeys,
} from "./doctor-config-analysis.js";

describe("doctor config analysis helpers", () => {
  it("formats config paths predictably", () => {
    expect(formatConfigPath([])).toBe("<root>");
    expect(formatConfigPath(["channels", "slack", "accounts", 0, "token"])).toBe(
      "channels.slack.accounts[0].token",
    );
  });

  it("resolves nested config targets without throwing", () => {
    const target = resolveConfigPathTarget(
      { channels: { slack: { accounts: [{ token: "x" }] } } },
      ["channels", "slack", "accounts", 0],
    );
    expect(target).toEqual({ token: "x" });
    expect(resolveConfigPathTarget({ channels: null }, ["channels", "slack"])).toBeNull();
  });

  it("strips unknown nested config keys while keeping known values", () => {
    // Unknown keys at the root level are preserved (catchall),
    // but unknown keys inside strict nested objects are still stripped.
    const result = stripUnknownConfigKeys({
      hooks: {},
      unexpected: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(result.removed).toEqual([]);
    expect((result.config as Record<string, unknown>).unexpected).toBe(true);
    expect((result.config as Record<string, unknown>).hooks).toEqual({});
  });

  it("strips unknown keys from nested strict objects", () => {
    const result = stripUnknownConfigKeys({
      gateway: { port: 3000, bogusField: "should be removed" },
    } as never);
    expect(result.removed).toContain("gateway.bogusField");
    expect((result.config as Record<string, unknown>).gateway).toEqual({ port: 3000 });
  });
});
