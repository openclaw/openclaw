import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "./types.js";
import { applySessionDefaults } from "./defaults.js";

describe("applySessionDefaults – session.mainKey", () => {
  test("returns config unchanged when session is undefined", () => {
    const cfg: OpenClawConfig = {};
    const result = applySessionDefaults(cfg);
    expect(result).toBe(cfg);
  });

  test("returns config unchanged when session.mainKey is undefined", () => {
    const cfg: OpenClawConfig = { session: { dmScope: "per-channel-peer" } };
    const result = applySessionDefaults(cfg);
    expect(result).toBe(cfg);
  });

  test("preserves mainKey = 'main' as-is", () => {
    const cfg: OpenClawConfig = { session: { mainKey: "main" } };
    const result = applySessionDefaults(cfg);
    expect(result.session?.mainKey).toBe("main");
  });

  test("preserves custom mainKey without overriding to 'main'", () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "telegram:direct:123456" },
    };
    const result = applySessionDefaults(cfg);
    expect(result.session?.mainKey).toBe("telegram:direct:123456");
  });

  test("lowercases custom mainKey for consistency", () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "Telegram:Direct:ABC" },
    };
    const result = applySessionDefaults(cfg);
    expect(result.session?.mainKey).toBe("telegram:direct:abc");
  });

  test("normalizes empty mainKey to 'main'", () => {
    const cfg: OpenClawConfig = { session: { mainKey: "" } };
    const result = applySessionDefaults(cfg);
    expect(result.session?.mainKey).toBe("main");
  });

  test("normalizes whitespace-only mainKey to 'main'", () => {
    const cfg: OpenClawConfig = { session: { mainKey: "   " } };
    const result = applySessionDefaults(cfg);
    expect(result.session?.mainKey).toBe("main");
  });

  test("trims whitespace from custom mainKey", () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "  primary  " },
    };
    const result = applySessionDefaults(cfg);
    expect(result.session?.mainKey).toBe("primary");
  });

  test("preserves other session properties when normalizing mainKey", () => {
    const cfg: OpenClawConfig = {
      session: {
        mainKey: "custom",
        dmScope: "per-channel-peer",
      },
    };
    const result = applySessionDefaults(cfg);
    expect(result.session?.mainKey).toBe("custom");
    expect(result.session?.dmScope).toBe("per-channel-peer");
  });
});
