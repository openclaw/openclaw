import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import { createConfigIO } from "./io.js";

async function waitForPersistedSecret(configPath: string, expectedSecret: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      commands?: { ownerDisplaySecret?: string };
    };
    if (parsed.commands?.ownerDisplaySecret === expectedSecret) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for ownerDisplaySecret persistence");
}

describe("config io owner display secret autofill", () => {
  it("auto-generates and persists commands.ownerDisplaySecret in hash mode", async () => {
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
      await waitForPersistedSecret(configPath, secret ?? "");

      const cfgReloaded = io.loadConfig();
      expect(cfgReloaded.commands?.ownerDisplaySecret).toBe(secret);
    });
  });
});
