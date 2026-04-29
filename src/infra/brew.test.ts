import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { resolveBrewExecutable, resolveBrewPathDirs } from "./brew.js";

describe("brew helpers", () => {
  async function writeExecutable(filePath: string) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "#!/bin/sh\necho ok\n", "utf-8");
    await fs.chmod(filePath, 0o755);
  }

  it("resolves brew from ~/.linuxbrew/bin when executable exists", async () => {
    await withTempDir({ prefix: "openclaw-brew-" }, async (tmp) => {
      const homebrewBin = path.join(tmp, ".linuxbrew", "bin");
      const brewPath = path.join(homebrewBin, "brew");
      await writeExecutable(brewPath);

      const env: NodeJS.ProcessEnv = {};
      expect(resolveBrewExecutable({ homeDir: tmp, env })).toBe(brewPath);
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

      const env: NodeJS.ProcessEnv = {
        HOMEBREW_BREW_FILE: explicit,
        HOMEBREW_PREFIX: prefix,
      };

      expect(resolveBrewExecutable({ homeDir: tmp, env })).toBe(homebrewBrew);
      expect(resolveBrewPathDirs({ homeDir: tmp, env })).not.toContain(prefixBin);
    });
  });

  it("ignores blank HOMEBREW_BREW_FILE and HOMEBREW_PREFIX values", async () => {
    await withTempDir({ prefix: "openclaw-brew-" }, async (tmp) => {
      const homebrewBin = path.join(tmp, ".linuxbrew", "bin");
      const brewPath = path.join(homebrewBin, "brew");
      await writeExecutable(brewPath);

      const env: NodeJS.ProcessEnv = {
        HOMEBREW_BREW_FILE: "   ",
        HOMEBREW_PREFIX: "\t",
      };

      expect(resolveBrewExecutable({ homeDir: tmp, env })).toBe(brewPath);

      const dirs = resolveBrewPathDirs({ homeDir: tmp, env });
      expect(dirs).not.toContain(path.join("", "bin"));
      expect(dirs).not.toContain(path.join("", "sbin"));
    });
  });

  it("always includes the standard macOS brew dirs after linuxbrew candidates", () => {
    const env: NodeJS.ProcessEnv = {
      HOMEBREW_BREW_FILE: "   ",
      HOMEBREW_PREFIX: "   ",
    };
    const dirs = resolveBrewPathDirs({ homeDir: "/home/test", env });

    expect(dirs.slice(-2)).toEqual(["/opt/homebrew/bin", "/usr/local/bin"]);
  });

  it("includes Linuxbrew bin/sbin in path candidates without env prefixes", () => {
    const env: NodeJS.ProcessEnv = { HOMEBREW_PREFIX: "/custom/prefix" };
    const dirs = resolveBrewPathDirs({ homeDir: "/home/test", env });
    expect(dirs).not.toContain(path.join("/custom/prefix", "bin"));
    expect(dirs).not.toContain(path.join("/custom/prefix", "sbin"));
    expect(dirs).toContain("/home/linuxbrew/.linuxbrew/bin");
    expect(dirs).toContain("/home/linuxbrew/.linuxbrew/sbin");
    expect(dirs).toContain(path.join("/home/test", ".linuxbrew", "bin"));
    expect(dirs).toContain(path.join("/home/test", ".linuxbrew", "sbin"));
  });
});
