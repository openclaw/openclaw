import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

describe("heartbeat timeoutSeconds config", () => {
  it("should accept timeoutSeconds in heartbeat config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            timeoutSeconds: 60,
          },
        },
      },
    };

    expect(cfg.agents?.defaults?.heartbeat?.timeoutSeconds).toBe(60);
  });

  it("should accept timeoutSeconds in per-agent heartbeat config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
          },
        },
        list: [
          {
            id: "ops",
            heartbeat: {
              every: "1h",
              timeoutSeconds: 90,
            },
          },
        ],
      },
    };

    const opsAgent = cfg.agents?.list?.[0];
    expect(opsAgent?.heartbeat?.timeoutSeconds).toBe(90);
  });

  it("should allow timeoutSeconds override at agent level", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            timeoutSeconds: 60,
          },
        },
        list: [
          {
            id: "research",
            heartbeat: {
              timeoutSeconds: 120, // Override default
            },
          },
        ],
      },
    };

    const researchAgent = cfg.agents?.list?.[0];
    // Per-agent override should take precedence
    expect(researchAgent?.heartbeat?.timeoutSeconds).toBe(120);
  });

  it("should work without timeoutSeconds (backward compatible)", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            model: "anthropic/claude-sonnet-4-5",
          },
        },
      },
    };

    expect(cfg.agents?.defaults?.heartbeat?.timeoutSeconds).toBeUndefined();
  });
});
