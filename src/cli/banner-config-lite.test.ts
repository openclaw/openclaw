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
});
