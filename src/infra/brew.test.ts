import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveBrewExecutable, resolveBrewPathDirs } from "./brew.js";

const withBrewDir = (run: (tmp: string) => Promise<void>) =>
  withTestDir({ prefix: "openclaw-brew-" }, run);

describe("brew helpers", () => {
  async function writeExecutable(filePath: string) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "#!/bin/sh\necho ok\n", "utf-8");
    await fs.chmod(filePath, 0o755);
  }

  it.each(["process", "workspace"])("trusts only the process PATH (%s)", async (source) => {
    await withBrewDir(async (tmp) => {
      const bin = path.join(tmp, "custom-homebrew", "bin");
      const executable = path.join(bin, "brew");
      await writeExecutable(executable);

      await withEnvAsync(source === "process" ? { PATH: bin } : {}, async () => {
        const resolved = resolveBrewExecutable({
          homeDir: path.join(tmp, "home"),
          ...(source === "workspace" ? { env: { PATH: bin } } : {}),
        });
        if (source === "process") {
          expect(resolved).toBe(executable);
        } else {
          expect(resolved).not.toBe(executable);
        }
      });
    });
  });

  it("ignores Homebrew executable, selector, and prefix env overrides by default", async () => {
    await withBrewDir(async (tmp) => {
      const explicit = path.join(tmp, "custom", "brew");
      const prefix = path.join(tmp, "prefix");
      const prefixBin = path.join(prefix, "bin");
      const homebrewBrew = path.join(tmp, ".linuxbrew", "bin", "brew");
      await Promise.all(
        [explicit, path.join(prefixBin, "brew"), homebrewBrew].map(writeExecutable),
      );
      const env = {
        HOMEBREW_BREW_FILE: explicit,
        HOMEBREW_CURL_PATH: explicit,
        HOMEBREW_GIT_PATH: explicit,
        HOMEBREW_PREFIX: prefix,
      };

      await withEnvAsync({ ...env, PATH: "" }, async () => {
        expect(resolveBrewExecutable({ homeDir: tmp, env })).toBe(homebrewBrew);
        expect(resolveBrewPathDirs({ homeDir: tmp, env })).not.toContain(prefixBin);
      });
    });
  });

  it("keeps Linuxbrew candidates before standard macOS dirs, ignoring env prefixes", async () => {
    await withEnvAsync({ HOMEBREW_PREFIX: "/custom/prefix" }, async () => {
      const dirs = resolveBrewPathDirs({ homeDir: "/home/test" });
      expect(dirs.slice(-2)).toEqual(["/opt/homebrew/bin", "/usr/local/bin"]);
      expect(dirs).not.toContain(path.join("/custom/prefix", "bin"));
      expect(dirs).not.toContain(path.join("/custom/prefix", "sbin"));
      expect(dirs).toContain("/home/linuxbrew/.linuxbrew/bin");
      expect(dirs).toContain("/home/linuxbrew/.linuxbrew/sbin");
      expect(dirs).toContain(path.join("/home/test", ".linuxbrew", "bin"));
      expect(dirs).toContain(path.join("/home/test", ".linuxbrew", "sbin"));
    });
  });
});
