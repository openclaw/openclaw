import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigIO } from "./io.js";

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "activi-config-"));
  try {
    await run(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function writeConfig(
  home: string,
  dirname: ".activi",
  port: number,
  filename: string = "activi.json",
) {
  const dir = path.join(home, dirname);
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, filename);
  await fs.writeFile(configPath, JSON.stringify({ gateway: { port } }, null, 2));
  return configPath;
}

function createIoForHome(home: string, env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv) {
  return createConfigIO({
    env,
    homedir: () => home,
  });
}

describe("config io paths", () => {
  it("uses ~/.activi/activi.json when config exists", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeConfig(home, ".activi", 19001);
      const io = createIoForHome(home);
      expect(io.configPath).toBe(configPath);
      expect(io.loadConfig().gateway?.port).toBe(19001);
    });
  });

  it("defaults to ~/.activi/activi.json when config is missing", async () => {
    await withTempHome(async (home) => {
      const io = createIoForHome(home);
      expect(io.configPath).toBe(path.join(home, ".activi", "activi.json"));
    });
  });

  it("uses ACTIVI_HOME for default config path", async () => {
    await withTempHome(async (home) => {
      const io = createConfigIO({
        env: { ACTIVI_HOME: path.join(home, "svc-home") } as NodeJS.ProcessEnv,
        homedir: () => path.join(home, "ignored-home"),
      });
      expect(io.configPath).toBe(path.join(home, "svc-home", ".activi", "activi.json"));
    });
  });

  it("honors explicit ACTIVI_CONFIG_PATH override", async () => {
    await withTempHome(async (home) => {
      const customPath = await writeConfig(home, ".activi", 20002, "custom.json");
      const io = createIoForHome(home, { ACTIVI_CONFIG_PATH: customPath } as NodeJS.ProcessEnv);
      expect(io.configPath).toBe(customPath);
      expect(io.loadConfig().gateway?.port).toBe(20002);
    });
  });

  it("honors legacy ACTIVI_CONFIG_PATH override", async () => {
    await withTempHome(async (home) => {
      const customPath = await writeConfig(home, ".activi", 20003, "legacy-custom.json");
      const io = createIoForHome(home, { ACTIVI_CONFIG_PATH: customPath } as NodeJS.ProcessEnv);
      expect(io.configPath).toBe(customPath);
      expect(io.loadConfig().gateway?.port).toBe(20003);
    });
  });

  it("normalizes safeBinProfiles at config load time", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".activi");
      await fs.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, "activi.json");
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            tools: {
              exec: {
                safeBinProfiles: {
                  " MyFilter ": {
                    allowedValueFlags: ["--limit", " --limit ", ""],
                  },
                },
              },
            },
            agents: {
              list: [
                {
                  id: "ops",
                  tools: {
                    exec: {
                      safeBinProfiles: {
                        " Custom ": {
                          deniedFlags: ["-f", " -f ", ""],
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
      const io = createIoForHome(home);
      expect(io.configPath).toBe(configPath);
      const cfg = io.loadConfig();
      expect(cfg.tools?.exec?.safeBinProfiles).toEqual({
        myfilter: {
          allowedValueFlags: ["--limit"],
        },
      });
      expect(cfg.agents?.list?.[0]?.tools?.exec?.safeBinProfiles).toEqual({
        custom: {
          deniedFlags: ["-f"],
        },
      });
    });
  });
});
