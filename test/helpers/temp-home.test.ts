import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "./temp-home.js";

describe("withTempHome", () => {
  it("clears explicit config path overrides inside temp home and restores them after", async () => {
    const previousOpenClawConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousLegacyConfigPath = process.env.CLAWDBOT_CONFIG_PATH;
    const leakedOpenClawConfigPath = "/tmp/openclaw-config-leak.json";
    const leakedLegacyConfigPath = "/tmp/clawdbot-config-leak.json";

    process.env.OPENCLAW_CONFIG_PATH = leakedOpenClawConfigPath;
    process.env.CLAWDBOT_CONFIG_PATH = leakedLegacyConfigPath;

    await withTempHome(async (home) => {
      expect(process.env.HOME).toBe(home);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(path.join(home, ".openclaw"));
      expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
      expect(process.env.CLAWDBOT_CONFIG_PATH).toBeUndefined();
    });

    expect(process.env.OPENCLAW_CONFIG_PATH).toBe(leakedOpenClawConfigPath);
    expect(process.env.CLAWDBOT_CONFIG_PATH).toBe(leakedLegacyConfigPath);

    if (previousOpenClawConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previousOpenClawConfigPath;
    }
    if (previousLegacyConfigPath === undefined) {
      delete process.env.CLAWDBOT_CONFIG_PATH;
    } else {
      process.env.CLAWDBOT_CONFIG_PATH = previousLegacyConfigPath;
    }
  });
});
