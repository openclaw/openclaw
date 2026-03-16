import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import { createConfigIO } from "./io.js";

describe("config io read-only load", () => {
  it("resolves config.env substitutions without mutating caller env", async () => {
    await withTempHome("openclaw-config-read-only-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            env: {
              vars: {
                BRAVE_API_KEY: "config-key",
              },
            },
            tools: {
              web: {
                search: {
                  apiKey: "${BRAVE_API_KEY}",
                },
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const env = {} as NodeJS.ProcessEnv;
      const io = createConfigIO({
        env,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      });

      const cfg = io.loadConfigReadOnly();
      expect(cfg.tools?.web?.search?.apiKey).toBe("config-key");
      expect(env.BRAVE_API_KEY).toBeUndefined();
    });
  });
});
