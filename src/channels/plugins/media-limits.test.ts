import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveChannelMediaMaxBytes } from "./media-limits.js";

const MB = 1024 * 1024;

describe("resolveChannelMediaMaxBytes", () => {
  it("returns channel limit in bytes", () => {
    const result = resolveChannelMediaMaxBytes({
      cfg: {} as OpenClawConfig,
      resolveChannelLimitMb: () => 10,
    });
    expect(result).toBe(10 * MB);
  });

  it("returns 0 bytes when channel limit is explicitly 0", () => {
    const result = resolveChannelMediaMaxBytes({
      cfg: { agents: { defaults: { mediaMaxMb: 50 } } } as OpenClawConfig,
      resolveChannelLimitMb: () => 0,
    });
    expect(result).toBe(0);
  });

  it("falls back to agents.defaults.mediaMaxMb", () => {
    const result = resolveChannelMediaMaxBytes({
      cfg: { agents: { defaults: { mediaMaxMb: 25 } } } as OpenClawConfig,
      resolveChannelLimitMb: () => undefined,
    });
    expect(result).toBe(25 * MB);
  });

  it("returns 0 bytes when default limit is explicitly 0", () => {
    const result = resolveChannelMediaMaxBytes({
      cfg: { agents: { defaults: { mediaMaxMb: 0 } } } as OpenClawConfig,
      resolveChannelLimitMb: () => undefined,
    });
    expect(result).toBe(0);
  });

  it("returns undefined when no limit is configured", () => {
    const result = resolveChannelMediaMaxBytes({
      cfg: {} as OpenClawConfig,
      resolveChannelLimitMb: () => undefined,
    });
    expect(result).toBeUndefined();
  });
});
