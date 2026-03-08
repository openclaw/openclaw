import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "./test-helpers.js";

const LASTGOOD_SUFFIX = ".lastgood";

async function writeConfig(home: string, content: string): Promise<string> {
  const configDir = path.join(home, ".openclaw");
  await fs.mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, "openclaw.json");
  await fs.writeFile(configPath, content, "utf-8");
  return configPath;
}

describe("last-known-good config fallback", () => {
  it("saves a .lastgood file after successful loadConfig()", async () => {
    await withTempHome(async (home) => {
      const validConfig = JSON.stringify({ agents: { list: [{ id: "test-agent" }] } });
      const configPath = await writeConfig(home, validConfig);

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();
      expect(cfg).toBeDefined();

      const lastGoodPath = `${configPath}${LASTGOOD_SUFFIX}`;
      const lastGoodContent = await fs.readFile(lastGoodPath, "utf-8");
      expect(lastGoodContent).toBe(validConfig);
    });
  });

  it("saves a .lastgood file after successful readConfigFileSnapshot()", async () => {
    await withTempHome(async (home) => {
      const validConfig = JSON.stringify({ agents: { list: [{ id: "snap-agent" }] } });
      const configPath = await writeConfig(home, validConfig);

      vi.resetModules();
      const { readConfigFileSnapshot } = await import("./config.js");
      const snap = await readConfigFileSnapshot();
      expect(snap.valid).toBe(true);

      const lastGoodPath = `${configPath}${LASTGOOD_SUFFIX}`;
      const lastGoodContent = await fs.readFile(lastGoodPath, "utf-8");
      expect(lastGoodContent).toBe(validConfig);
    });
  });

  it("falls back to lastgood when config is invalid JSON", async () => {
    await withTempHome(async (home) => {
      // First: write valid config and load it to create .lastgood
      const validConfig = JSON.stringify({ agents: { list: [{ id: "good-agent" }] } });
      const configPath = await writeConfig(home, validConfig);

      vi.resetModules();
      const { loadConfig: loadFirst } = await import("./config.js");
      loadFirst();

      // Verify .lastgood was created
      const lastGoodPath = `${configPath}${LASTGOOD_SUFFIX}`;
      await expect(fs.stat(lastGoodPath)).resolves.toBeDefined();

      // Now: corrupt the config file
      await fs.writeFile(configPath, "{ this is not valid json !!!", "utf-8");

      vi.resetModules();
      const { loadConfig: loadSecond } = await import("./config.js");
      const cfg = loadSecond();

      // Should have recovered from lastgood, not empty
      expect(cfg.agents?.list?.[0]?.id).toBe("good-agent");
    });
  });

  it("falls back to lastgood when config has validation errors", async () => {
    await withTempHome(async (home) => {
      // First: write valid config and load to create .lastgood
      const validConfig = JSON.stringify({ agents: { list: [{ id: "valid-agent" }] } });
      const configPath = await writeConfig(home, validConfig);

      vi.resetModules();
      const { loadConfig: loadFirst } = await import("./config.js");
      loadFirst();

      // Now: write config with unknown fields (fails strict validation)
      await fs.writeFile(
        configPath,
        JSON.stringify({ customUnknownField: { nested: "value" } }),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig: loadSecond } = await import("./config.js");
      const cfg = loadSecond();

      expect(cfg.agents?.list?.[0]?.id).toBe("valid-agent");
    });
  });

  it("returns empty config when both config and lastgood are invalid", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeConfig(home, "{ broken json");

      // Manually write a broken lastgood file
      const lastGoodPath = `${configPath}${LASTGOOD_SUFFIX}`;
      await fs.writeFile(lastGoodPath, "{ also broken", "utf-8");

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      // Both failed — should return empty config without crashing
      expect(cfg).toEqual({});
    });
  });

  it("returns empty config when no lastgood exists and config is invalid", async () => {
    await withTempHome(async (home) => {
      await writeConfig(home, "not json at all");

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg).toEqual({});
    });
  });

  it("does not save .lastgood when config is invalid", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeConfig(home, "{ broken");

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      loadConfig();

      const lastGoodPath = `${configPath}${LASTGOOD_SUFFIX}`;
      await expect(fs.stat(lastGoodPath)).rejects.toThrow();
    });
  });

  it("does not save .lastgood when snapshot is invalid", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeConfig(home, "{ broken");

      vi.resetModules();
      const { readConfigFileSnapshot } = await import("./config.js");
      const snap = await readConfigFileSnapshot();
      expect(snap.valid).toBe(false);

      const lastGoodPath = `${configPath}${LASTGOOD_SUFFIX}`;
      await expect(fs.stat(lastGoodPath)).rejects.toThrow();
    });
  });

  it("updates .lastgood when a new valid config is loaded", async () => {
    await withTempHome(async (home) => {
      // Load first valid config
      const configPath = await writeConfig(
        home,
        JSON.stringify({ agents: { list: [{ id: "v1" }] } }),
      );

      vi.resetModules();
      const { loadConfig: load1 } = await import("./config.js");
      load1();

      // Update config to v2
      await fs.writeFile(
        configPath,
        JSON.stringify({ agents: { list: [{ id: "v2" }] } }),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig: load2 } = await import("./config.js");
      load2();

      // .lastgood should now reflect v2
      const lastGoodPath = `${configPath}${LASTGOOD_SUFFIX}`;
      const raw = await fs.readFile(lastGoodPath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.agents.list[0].id).toBe("v2");
    });
  });
});
