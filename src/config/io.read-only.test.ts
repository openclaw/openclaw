import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import { createConfigIO, loadConfigReadOnly, readConfigFileSnapshot } from "./io.js";

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

  it("resolves dotenv-backed refs in top-level read-only helpers without mutating process env", async () => {
    await withTempHome("openclaw-config-read-only-top-level-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
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
      await fs.writeFile(
        path.join(home, ".openclaw", ".env"),
        "BRAVE_API_KEY=from-dotenv\n",
        "utf-8",
      );

      const prev = process.env.BRAVE_API_KEY;
      delete process.env.BRAVE_API_KEY;
      try {
        const cfg = loadConfigReadOnly();
        expect(cfg.tools?.web?.search?.apiKey).toBe("from-dotenv");

        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.config.tools?.web?.search?.apiKey).toBe("from-dotenv");

        expect(process.env.BRAVE_API_KEY).toBeUndefined();
      } finally {
        if (prev === undefined) {
          delete process.env.BRAVE_API_KEY;
        } else {
          process.env.BRAVE_API_KEY = prev;
        }
      }
    });
  });
});
