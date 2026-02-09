import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigIO } from "./io.js";

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "EasyHub-config-"));
  try {
    await run(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function writeConfig(
  home: string,
  dirname: ".easyhub",
  port: number,
  filename: string = "easyhub.json",
) {
  const dir = path.join(home, dirname);
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, filename);
  await fs.writeFile(configPath, JSON.stringify({ gateway: { port } }, null, 2));
  return configPath;
}

describe("config io paths", () => {
  it("uses ~/.easyhub/easyhub.json when config exists", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeConfig(home, ".easyhub", 19001);
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
      });
      expect(io.configPath).toBe(configPath);
      expect(io.loadConfig().gateway?.port).toBe(19001);
    });
  });

  it("defaults to ~/.easyhub/easyhub.json when config is missing", async () => {
    await withTempHome(async (home) => {
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
      });
      expect(io.configPath).toBe(path.join(home, ".easyhub", "easyhub.json"));
    });
  });

  it("uses EASYHUB_HOME for default config path", async () => {
    await withTempHome(async (home) => {
      const io = createConfigIO({
        env: { EASYHUB_HOME: path.join(home, "svc-home") } as NodeJS.ProcessEnv,
        homedir: () => path.join(home, "ignored-home"),
      });
      expect(io.configPath).toBe(path.join(home, "svc-home", ".easyhub", "easyhub.json"));
    });
  });

  it("honors explicit EASYHUB_CONFIG_PATH override", async () => {
    await withTempHome(async (home) => {
      const customPath = await writeConfig(home, ".easyhub", 20002, "custom.json");
      const io = createConfigIO({
        env: { EASYHUB_CONFIG_PATH: customPath } as NodeJS.ProcessEnv,
        homedir: () => home,
      });
      expect(io.configPath).toBe(customPath);
      expect(io.loadConfig().gateway?.port).toBe(20002);
    });
  });
});
