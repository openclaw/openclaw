import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import { createConfigIO } from "./io.js";

describe("config io owner display secret autofill", () => {
  it("keeps auto-generated commands.ownerDisplaySecret in-memory on load", async () => {
    await withTempHome("openclaw-owner-display-secret-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ commands: { ownerDisplay: "hash" } }, null, 2),
        "utf-8",
      );

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      });
      const cfg = io.loadConfig();
      const secret = cfg.commands?.ownerDisplaySecret;

      expect(secret).toMatch(/^[a-f0-9]{64}$/);
      const parsed = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        commands?: { ownerDisplaySecret?: string };
      };
      expect(parsed.commands?.ownerDisplaySecret).toBeUndefined();

      const cfgReloaded = io.loadConfig();
      expect(cfgReloaded.commands?.ownerDisplaySecret).toBe(secret);
    });
  });

  it("persists the generated secret only after explicit writeConfigFile", async () => {
    await withTempHome("openclaw-owner-display-secret-persist-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ commands: { ownerDisplay: "hash" } }, null, 2),
        "utf-8",
      );

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      });
      const cfg = io.loadConfig();
      const secret = cfg.commands?.ownerDisplaySecret;
      expect(secret).toMatch(/^[a-f0-9]{64}$/);

      await io.writeConfigFile(cfg);
      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        commands?: { ownerDisplaySecret?: string };
      };
      expect(persisted.commands?.ownerDisplaySecret).toBe(secret);
    });
  });
});
