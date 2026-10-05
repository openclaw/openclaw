import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveChannelMediaMaxBytes } from "./media-limits.js";

const MB = 1024 * 1024;

function resolve(channelMb: number | undefined, defaultMb?: number) {
  const cfg = { agents: { defaults: { mediaMaxMb: defaultMb } } } as unknown as OpenClawConfig;
  return resolveChannelMediaMaxBytes({
    cfg,
    accountId: "primary",
    resolveChannelLimitMb: () => channelMb,
  });
}

describe("resolveChannelMediaMaxBytes", () => {
  it("treats a negative channel limit as unset instead of a negative cap", () => {
    expect(resolve(-5)).toBeUndefined();
    expect(resolve(-5, 25)).toBe(25 * MB);
  });

  it("treats a zero channel limit as unset", () => {
    expect(resolve(0)).toBeUndefined();
    expect(resolve(0, 25)).toBe(25 * MB);
  });

  it("keeps positive channel and default limits", () => {
    expect(resolve(10)).toBe(10 * MB);
    expect(resolve(undefined, 25)).toBe(25 * MB);
  });
});
