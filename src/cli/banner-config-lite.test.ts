import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCliBannerTaglineMode } from "./banner-config-lite.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readCliBannerTaglineMode", () => {
  it("reads tagline mode from the active config file", () => {
    const root = makeTempDir("openclaw-banner-config-");
    const configPath = path.join(root, "openclaw.json");
    fs.writeFileSync(
      configPath,
      `{
        cli: {
          banner: {
            taglineMode: "off",
          },
        },
      }
      `,
      "utf-8",
    );

    expect(readCliBannerTaglineMode({ OPENCLAW_CONFIG_PATH: configPath })).toBe("off");
  });

  it("resolves tagline mode from included config files", () => {
    const root = makeTempDir("openclaw-banner-include-");
    const configPath = path.join(root, "openclaw.json");
    const includePath = path.join(root, "banner.json5");
    fs.writeFileSync(configPath, `{ "$include": "./banner.json5" }\n`, "utf-8");
    fs.writeFileSync(
      includePath,
      `{
        cli: {
          banner: {
            taglineMode: "default",
          },
        },
      }
      `,
      "utf-8",
    );

    expect(readCliBannerTaglineMode({ OPENCLAW_CONFIG_PATH: configPath })).toBe("default");
  });

  it("returns undefined when the config is missing or invalid", () => {
    const root = makeTempDir("openclaw-banner-missing-");
    const missingPath = path.join(root, "missing.json");
    const invalidPath = path.join(root, "invalid.json");
    fs.writeFileSync(invalidPath, "{ not valid json5", "utf-8");

    expect(readCliBannerTaglineMode({ OPENCLAW_CONFIG_PATH: missingPath })).toBeUndefined();
    expect(readCliBannerTaglineMode({ OPENCLAW_CONFIG_PATH: invalidPath })).toBeUndefined();
  });

  it("resolves tagline mode from process env substitution", () => {
    const root = makeTempDir("openclaw-banner-process-env-");
    const configPath = path.join(root, "openclaw.json");
    fs.writeFileSync(
      configPath,
      `{
        cli: {
          banner: {
            taglineMode: "\${TAGLINE_MODE}",
          },
        },
      }
      `,
      "utf-8",
    );

    expect(
      readCliBannerTaglineMode({
        OPENCLAW_CONFIG_PATH: configPath,
        TAGLINE_MODE: "off",
      }),
    ).toBe("off");
  });

  it("resolves tagline mode from config env substitution", () => {
    const root = makeTempDir("openclaw-banner-config-env-");
    const configPath = path.join(root, "openclaw.json");
    fs.writeFileSync(
      configPath,
      `{
        env: {
          TAGLINE_MODE: "default",
        },
        cli: {
          banner: {
            taglineMode: "\${TAGLINE_MODE}",
          },
        },
      }
      `,
      "utf-8",
    );

    expect(readCliBannerTaglineMode({ OPENCLAW_CONFIG_PATH: configPath })).toBe("default");
  });

  it("prefers the OPENCLAW_STATE_DIR config path over legacy home fallbacks", () => {
    const homeRoot = makeTempDir("openclaw-banner-home-");
    const stateDir = makeTempDir("openclaw-banner-state-");
    const legacyConfigDir = path.join(homeRoot, ".openclaw");
    const legacyConfigPath = path.join(legacyConfigDir, "openclaw.json");
    fs.mkdirSync(legacyConfigDir, { recursive: true });
    fs.writeFileSync(
      legacyConfigPath,
      `{
        cli: {
          banner: {
            taglineMode: "off",
          },
        },
      }
      `,
      "utf-8",
    );

    expect(
      readCliBannerTaglineMode({
        HOME: homeRoot,
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toBeUndefined();
  });

  it("keeps a valid banner mode when unrelated env vars are missing", () => {
    const root = makeTempDir("openclaw-banner-missing-env-");
    const configPath = path.join(root, "openclaw.json");
    fs.writeFileSync(
      configPath,
      `{
        features: {
          extra: "\${MISSING_VALUE}",
        },
        cli: {
          banner: {
            taglineMode: "off",
          },
        },
      }
      `,
      "utf-8",
    );

    expect(readCliBannerTaglineMode({ OPENCLAW_CONFIG_PATH: configPath })).toBe("off");
  });

  it("hydrates dotenv before resolving banner env substitutions for process.env", () => {
    const root = makeTempDir("openclaw-banner-dotenv-");
    const configPath = path.join(root, "openclaw.json");
    const envPath = path.join(root, ".env");
    fs.writeFileSync(
      configPath,
      `{
        cli: {
          banner: {
            taglineMode: "\${TAGLINE_MODE}",
          },
        },
      }
      `,
      "utf-8",
    );
    fs.writeFileSync(envPath, "TAGLINE_MODE=off\n", "utf-8");

    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousTaglineMode = process.env.TAGLINE_MODE;
    delete process.env.TAGLINE_MODE;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = root;
    try {
      expect(readCliBannerTaglineMode()).toBe("off");
    } finally {
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousTaglineMode === undefined) {
        delete process.env.TAGLINE_MODE;
      } else {
        process.env.TAGLINE_MODE = previousTaglineMode;
      }
    }
  });
});
