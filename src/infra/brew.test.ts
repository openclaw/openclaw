import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { resolveBrewExecutable, resolveBrewPathDirs } from "./brew.js";

const HOMEBREW_ENV_KEYS = ["HOMEBREW_BREW_FILE", "HOMEBREW_PREFIX"] as const;

describe("brew helpers", () => {
  async function writeExecutable(filePath: string) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "#!/bin/sh\necho ok\n", "utf-8");
    await fs.chmod(filePath, 0o755);
  }

  async function withHomebrewEnv(
    values: Partial<Record<(typeof HOMEBREW_ENV_KEYS)[number], string>>,
    run: () => Promise<void>,
  ) {
    const previous = Object.fromEntries(
      HOMEBREW_ENV_KEYS.map((key) => [key, process.env[key]]),
    ) as Record<(typeof HOMEBREW_ENV_KEYS)[number], string | undefined>;
    try {
      for (const key of HOMEBREW_ENV_KEYS) {
        const value = values[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await run();
    } finally {
      for (const key of HOMEBREW_ENV_KEYS) {
        const value = previous[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  it("resolves brew from ~/.linuxbrew/bin when executable exists", async () => {
    await withTempDir({ prefix: "openclaw-brew-" }, async (tmp) => {
      const homebrewBin = path.join(tmp, ".linuxbrew", "bin");
      const brewPath = path.join(homebrewBin, "brew");
      await writeExecutable(brewPath);

      expect(resolveBrewExecutable({ homeDir: tmp })).toBe(brewPath);
    });
  });

  it("ignores HOMEBREW_BREW_FILE and HOMEBREW_PREFIX by default", async () => {
    await withTempDir({ prefix: "openclaw-brew-" }, async (tmp) => {
      const explicit = path.join(tmp, "custom", "brew");
      const prefix = path.join(tmp, "prefix");
      const prefixBin = path.join(prefix, "bin");
      const prefixBrew = path.join(prefixBin, "brew");
      const homebrewBin = path.join(tmp, ".linuxbrew", "bin");
      const homebrewBrew = path.join(homebrewBin, "brew");
      await writeExecutable(explicit);
      await writeExecutable(prefixBrew);
      await writeExecutable(homebrewBrew);

      await withHomebrewEnv(
        {
          HOMEBREW_BREW_FILE: explicit,
          HOMEBREW_PREFIX: prefix,
        },
        async () => {
          expect(resolveBrewExecutable({ homeDir: tmp })).toBe(homebrewBrew);
          expect(resolveBrewPathDirs({ homeDir: tmp })).not.toContain(prefixBin);
        },
      );
    });
  });

  it("ignores blank HOMEBREW_BREW_FILE and HOMEBREW_PREFIX values", async () => {
    await withTempDir({ prefix: "openclaw-brew-" }, async (tmp) => {
      const homebrewBin = path.join(tmp, ".linuxbrew", "bin");
      const brewPath = path.join(homebrewBin, "brew");
      await writeExecutable(brewPath);

      await withHomebrewEnv(
        {
          HOMEBREW_BREW_FILE: "   ",
          HOMEBREW_PREFIX: "\t",
        },
        async () => {
          expect(resolveBrewExecutable({ homeDir: tmp })).toBe(brewPath);

          const dirs = resolveBrewPathDirs({ homeDir: tmp });
          expect(dirs).not.toContain(path.join("", "bin"));
          expect(dirs).not.toContain(path.join("", "sbin"));
        },
      );
    });
  });

  it("always includes the standard macOS brew dirs after linuxbrew candidates", () => {
    const dirs = resolveBrewPathDirs({ homeDir: "/home/test" });

    expect(dirs.slice(-2)).toEqual(["/opt/homebrew/bin", "/usr/local/bin"]);
  });

  it("includes Linuxbrew bin/sbin in path candidates without env prefixes", async () => {
    await withHomebrewEnv({ HOMEBREW_PREFIX: "/custom/prefix" }, async () => {
      const dirs = resolveBrewPathDirs({ homeDir: "/home/test" });
      expect(dirs).not.toContain(path.join("/custom/prefix", "bin"));
      expect(dirs).not.toContain(path.join("/custom/prefix", "sbin"));
      expect(dirs).toContain("/home/linuxbrew/.linuxbrew/bin");
      expect(dirs).toContain("/home/linuxbrew/.linuxbrew/sbin");
      expect(dirs).toContain(path.join("/home/test", ".linuxbrew", "bin"));
      expect(dirs).toContain(path.join("/home/test", ".linuxbrew", "sbin"));
    });
  });
});
