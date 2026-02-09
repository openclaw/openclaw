import { describe, expect, it } from "vitest";
import type { SessionConfig } from "../types.base.js";
import { resolveSessionResetPolicy } from "./reset.js";

describe("resolveSessionResetPolicy", () => {
  describe("backward compatibility: resetByType.dm → direct", () => {
    it("uses resetByType.direct when available", () => {
      const sessionCfg = {
        resetByType: {
          direct: { mode: "idle" as const, idleMinutes: 30 },
        },
      } satisfies SessionConfig;

      const policy = resolveSessionResetPolicy({
        sessionCfg,
        resetType: "direct",
      });

      expect(policy.mode).toBe("idle");
      expect(policy.idleMinutes).toBe(30);
    });

    it("falls back to resetByType.dm (legacy) when direct is missing", () => {
      // Simulating legacy config with "dm" key instead of "direct"
      const sessionCfg = {
        resetByType: {
          dm: { mode: "idle" as const, idleMinutes: 45 },
        },
      } as unknown as SessionConfig;

      const policy = resolveSessionResetPolicy({
        sessionCfg,
        resetType: "direct",
      });

      expect(policy.mode).toBe("idle");
      expect(policy.idleMinutes).toBe(45);
    });

    it("prefers resetByType.direct over resetByType.dm when both present", () => {
      const sessionCfg = {
        resetByType: {
          direct: { mode: "daily" as const },
          dm: { mode: "idle" as const, idleMinutes: 99 },
        },
      } as unknown as SessionConfig;

      const policy = resolveSessionResetPolicy({
        sessionCfg,
        resetType: "direct",
      });

      expect(policy.mode).toBe("daily");
    });

    it("does not use dm fallback for group/thread types", () => {
      const sessionCfg = {
        resetByType: {
          dm: { mode: "idle" as const, idleMinutes: 45 },
        },
      } as unknown as SessionConfig;

      const groupPolicy = resolveSessionResetPolicy({
        sessionCfg,
        resetType: "group",
      });

      // Should use default mode since group has no config and dm doesn't apply
      expect(groupPolicy.mode).toBe("daily");
    });
  });
});
