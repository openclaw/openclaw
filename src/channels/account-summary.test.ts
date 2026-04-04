import { describe, expect, it } from "vitest";
import {
  resolveChannelAccountEnabled,
} from "./account-summary.js";

describe("resolveChannelAccountEnabled", () => {
  it("returns plugin result when isEnabled is defined", () => {
    const plugin = {
      config: {
        isEnabled: () => true,
      },
    } as any;
    const result = resolveChannelAccountEnabled({ plugin, account: {}, cfg: {} });
    expect(result).toBe(true);
  });

  it("returns false when isEnabled returns false", () => {
    const plugin = {
      config: {
        isEnabled: () => false,
      },
    } as any;
    const result = resolveChannelAccountEnabled({ plugin, account: {}, cfg: {} });
    expect(result).toBe(false);
  });

  it("returns true when account.enabled is true", () => {
    const plugin = { config: {} } as any;
    const result = resolveChannelAccountEnabled({ plugin, account: { enabled: true }, cfg: {} });
    expect(result).toBe(true);
  });

  it("returns false when account.enabled is false", () => {
    const plugin = { config: {} } as any;
    const result = resolveChannelAccountEnabled({ plugin, account: { enabled: false }, cfg: {} });
    expect(result).toBe(false);
  });

  it("returns true when account.enabled is undefined (default)", () => {
    const plugin = { config: {} } as any;
    const result = resolveChannelAccountEnabled({ plugin, account: { name: "test" }, cfg: {} });
    expect(result).toBe(true);
  });

  it("returns true for empty account", () => {
    const plugin = { config: {} } as any;
    const result = resolveChannelAccountEnabled({ plugin, account: {}, cfg: {} });
    expect(result).toBe(true);
  });
});
