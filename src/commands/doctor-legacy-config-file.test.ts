import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { maybeMigrateLegacyConfigFile } from "./doctor-legacy-config-file.js";

describe("maybeMigrateLegacyConfigFile", () => {
  it("copies a legacy config file into the canonical config path", async () => {
    await withTempHome(async (home) => {
      const legacyPath = path.join(home, ".clawdbot", "clawdbot.json");
      const legacyContent = JSON.stringify({ model: "claude-sonnet-4-5" }, null, 2);
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(legacyPath, legacyContent, "utf8");

      const changes = await maybeMigrateLegacyConfigFile();
      const targetPath = path.join(home, ".openclaw", "openclaw.json");

      expect(changes).toEqual([`Migrated legacy config: ${legacyPath} -> ${targetPath}`]);
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe(legacyContent);
    });
  });

  it("skips migration when the canonical config already exists", async () => {
    await withTempHome(async (home) => {
      const targetPath = path.join(home, ".openclaw", "openclaw.json");
      const legacyPath = path.join(home, ".clawdbot", "clawdbot.json");
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(targetPath, JSON.stringify({ model: "existing" }, null, 2), "utf8");
      await fs.writeFile(legacyPath, JSON.stringify({ model: "legacy" }, null, 2), "utf8");

      const changes = await maybeMigrateLegacyConfigFile();

      expect(changes).toEqual([]);
      await expect(fs.readFile(targetPath, "utf8")).resolves.toContain('"existing"');
    });
  });

  it("returns no changes when no legacy config file exists", async () => {
    await withTempHome(async () => {
      await expect(maybeMigrateLegacyConfigFile()).resolves.toEqual([]);
    });
  });
});
