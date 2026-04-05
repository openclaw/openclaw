import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { VERSION } from "../version.js";
import { createConfigIO } from "./io.js";
import { parseMullusiVersion } from "./version.js";

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "mullusi-config-"));
  try {
    await run(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function writeConfig(
  home: string,
  dirname: ".mullusi",
  port: number,
  filename: string = "mullusi.json",
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

async function expectNoNewerVersionWarning(touchedVersion: string) {
  await withTempHome(async (home) => {
    const configDir = path.join(home, ".mullusi");
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, "mullusi.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ meta: { lastTouchedVersion: touchedVersion } }, null, 2),
    );

    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };

    const io = createConfigIO({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
      logger,
    });

    io.loadConfig();

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Config was last written by a newer Mullusi"),
    );
    expect(io.configPath).toBe(configPath);
  });
}

describe("config io paths", () => {
  it("uses ~/.mullusi/mullusi.json when config exists", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeConfig(home, ".mullusi", 19001);
      const io = createIoForHome(home);
      expect(io.configPath).toBe(configPath);
      expect(io.loadConfig().gateway?.port).toBe(19001);
    });
  });

  it("defaults to ~/.mullusi/mullusi.json when config is missing", async () => {
    await withTempHome(async (home) => {
      const io = createIoForHome(home);
      expect(io.configPath).toBe(path.join(home, ".mullusi", "mullusi.json"));
    });
  });

  it("uses MULLUSI_HOME for default config path", async () => {
    await withTempHome(async (home) => {
      const io = createConfigIO({
        env: { MULLUSI_HOME: path.join(home, "svc-home") } as NodeJS.ProcessEnv,
        homedir: () => path.join(home, "ignored-home"),
      });
      expect(io.configPath).toBe(path.join(home, "svc-home", ".mullusi", "mullusi.json"));
    });
  });

  it("honors explicit MULLUSI_CONFIG_PATH override", async () => {
    await withTempHome(async (home) => {
      const customPath = await writeConfig(home, ".mullusi", 20002, "custom.json");
      const io = createIoForHome(home, { MULLUSI_CONFIG_PATH: customPath } as NodeJS.ProcessEnv);
      expect(io.configPath).toBe(customPath);
      expect(io.loadConfig().gateway?.port).toBe(20002);
    });
  });

  it("normalizes safe-bin config entries at config load time", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".mullusi");
      await fs.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, "mullusi.json");
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            tools: {
              exec: {
                safeBinTrustedDirs: [" /custom/bin ", "", "/custom/bin", "/agent/bin"],
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
                      safeBinTrustedDirs: [" /ops/bin ", "/ops/bin"],
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
      expect(cfg.tools?.exec?.safeBinTrustedDirs).toEqual(["/custom/bin", "/agent/bin"]);
      expect(cfg.agents?.list?.[0]?.tools?.exec?.safeBinProfiles).toEqual({
        custom: {
          deniedFlags: ["-f"],
        },
      });
      expect(cfg.agents?.list?.[0]?.tools?.exec?.safeBinTrustedDirs).toEqual(["/ops/bin"]);
    });
  });

  it("logs invalid config path details and throws on invalid config", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".mullusi");
      await fs.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, "mullusi.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({ gateway: { port: "not-a-number" } }, null, 2),
      );

      const logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger,
      });

      expect(() => io.loadConfig()).toThrow(/Invalid config/);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(`Invalid config at ${configPath}:\\n`),
      );
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("- gateway.port:"));
    });
  });

  it("does not warn when config was last touched by a same-base correction publish", async () => {
    const parsedVersion = parseMullusiVersion(VERSION);
    if (!parsedVersion) {
      throw new Error(`Unable to parse VERSION: ${VERSION}`);
    }
    const touchedVersion = `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch}-${(parsedVersion.revision ?? 0) + 1}`;
    await expectNoNewerVersionWarning(touchedVersion);
  });

  it("does not warn for same-base prerelease configs when current version is newer", async () => {
    const parsedVersion = parseMullusiVersion(VERSION);
    if (!parsedVersion) {
      throw new Error(`Unable to parse VERSION: ${VERSION}`);
    }
    const touchedVersion = `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch}-beta.1`;
    await expectNoNewerVersionWarning(touchedVersion);
  });
});
