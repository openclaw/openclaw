import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./types.js";
import { applySessionDefaults } from "./defaults.js";

describe("applySessionDefaults", () => {
  it("sets slack idle reset when missing", () => {
    const cfg = {} as OpenClawConfig;
    const next = applySessionDefaults(cfg);
    expect(next.session?.resetByChannel?.slack).toEqual({ mode: "idle", idleMinutes: 120 });
  });

  it("does not override existing slack reset", () => {
    const cfg = {
      session: {
        resetByChannel: {
          slack: { mode: "daily", atHour: 3 },
        },
      },
    } as OpenClawConfig;
    const next = applySessionDefaults(cfg);
    expect(next.session?.resetByChannel?.slack).toEqual({ mode: "daily", atHour: 3 });
  });
});
