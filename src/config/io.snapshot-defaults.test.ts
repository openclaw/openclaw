import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import { createConfigIO } from "./io.js";

describe("config snapshot defaults chain", () => {
  const silentLogger = {
    warn: () => {},
    error: () => {},
  };

  it("applies compaction defaults when config file exists", async () => {
    await withTempHome("openclaw-config-snapshot-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      // A config with agents.defaults triggers applyAgentDefaults, which
      // creates the defaults object that applyCompactionDefaults then fills in.
      await fs.writeFile(
        configPath,
        JSON.stringify({ agents: { defaults: {} } }, null, 2),
        "utf-8",
      );

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);
      expect(snapshot.config.agents?.defaults?.compaction?.mode).toBe("safeguard");
    });
  });

  it("applies compaction defaults when no config file exists", async () => {
    await withTempHome("openclaw-config-snapshot-nofile-", async (home) => {
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);
      // No config file => applyAgentDefaults creates agents.defaults,
      // then applyCompactionDefaults sets the mode.
      expect(snapshot.config.agents?.defaults?.compaction?.mode).toBe("safeguard");
    });
  });
});
