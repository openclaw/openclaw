import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";
import { loadConfig } from "./config.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";

describe("fallbackNotify config option", () => {
  it("accepts fallbackNotify: true", () => {
    const parsed = OpenClawSchema.parse({
      agents: { defaults: { fallbackNotify: true } },
    });
    expect(parsed.agents?.defaults?.fallbackNotify).toBe(true);
  });

  it("accepts fallbackNotify: false", () => {
    const parsed = OpenClawSchema.parse({
      agents: { defaults: { fallbackNotify: false } },
    });
    expect(parsed.agents?.defaults?.fallbackNotify).toBe(false);
  });

  it("defaults to undefined when omitted", () => {
    const parsed = OpenClawSchema.parse({
      agents: { defaults: {} },
    });
    expect(parsed.agents?.defaults?.fallbackNotify).toBeUndefined();
  });

  it("loads correctly from config file", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        agents: { defaults: { fallbackNotify: true } },
      });

      const cfg = loadConfig();
      expect(cfg.agents?.defaults?.fallbackNotify).toBe(true);
    });
  });
});
