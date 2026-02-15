import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureOpenClawCliOnPath } from "./path-env.js";

describe("ensureOpenClawCliOnPath", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-path-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("prepends the bundled app bin dir when a sibling openclaw exists", async () => {
    const tmp = path.join(fixtureRoot, `case-${fixtureCount++}`);
    const appBinDir = path.join(tmp, "AppBin");
    await fs.mkdir(appBinDir, { recursive: true });
    const cliPath = path.join(appBinDir, "openclaw");
    await fs.writeFile(cliPath, "#!/bin/sh\necho ok\n", "utf-8");
    await fs.chmod(cliPath, 0o755);

    const originalPath = process.env.PATH;
    const originalFlag = process.env.OPENCLAW_PATH_BOOTSTRAPPED;
    process.env.PATH = "/usr/bin";
    delete process.env.OPENCLAW_PATH_BOOTSTRAPPED;
    try {
      ensureOpenClawCliOnPath({
        execPath: cliPath,
        cwd: tmp,
        homeDir: tmp,
        platform: "darwin",
      });
      const updated = process.env.PATH ?? "";
      expect(updated.split(path.delimiter)[0]).toBe(appBinDir);
    } finally {
      process.env.PATH = originalPath;
      if (originalFlag === undefined) {
        delete process.env.OPENCLAW_PATH_BOOTSTRAPPED;
      } else {
        process.env.OPENCLAW_PATH_BOOTSTRAPPED = originalFlag;
      }
    }
  });

  it("is idempotent", () => {
    const originalPath = process.env.PATH;
    const originalFlag = process.env.OPENCLAW_PATH_BOOTSTRAPPED;
    process.env.PATH = "/bin";
    process.env.OPENCLAW_PATH_BOOTSTRAPPED = "1";
    try {
      ensureOpenClawCliOnPath({
        execPath: "/tmp/does-not-matter",
        cwd: "/tmp",
        homeDir: "/tmp",
        platform: "darwin",
      });
      expect(process.env.PATH).toBe("/bin");
    } finally {
      process.env.PATH = originalPath;
      if (originalFlag === undefined) {
        delete process.env.OPENCLAW_PATH_BOOTSTRAPPED;
      } else {
        process.env.OPENCLAW_PATH_BOOTSTRAPPED = originalFlag;
      }
    }
  });

  it("prepends mise shims when available", async () => {
    const tmp = path.join(fixtureRoot, `case-${fixtureCount++}`);
    const originalPath = process.env.PATH;
    const originalFlag = process.env.OPENCLAW_PATH_BOOTSTRAPPED;
    const originalMiseDataDir = process.env.MISE_DATA_DIR;
    try {
      const appBinDir = path.join(tmp, "AppBin");
      await fs.mkdir(appBinDir, { recursive: true });
      const appCli = path.join(appBinDir, "openclaw");
      await fs.writeFile(appCli, "#!/bin/sh\necho ok\n", "utf-8");
      await fs.chmod(appCli, 0o755);

      const miseDataDir = path.join(tmp, "mise");
      const shimsDir = path.join(miseDataDir, "shims");
      await fs.mkdir(shimsDir, { recursive: true });
      process.env.MISE_DATA_DIR = miseDataDir;
      process.env.PATH = "/usr/bin";
      delete process.env.OPENCLAW_PATH_BOOTSTRAPPED;

      ensureOpenClawCliOnPath({
        execPath: appCli,
        cwd: tmp,
        homeDir: tmp,
        platform: "darwin",
      });

      const updated = process.env.PATH ?? "";
      const parts = updated.split(path.delimiter);
      const appBinIndex = parts.indexOf(appBinDir);
      const shimsIndex = parts.indexOf(shimsDir);
      expect(appBinIndex).toBeGreaterThanOrEqual(0);
      expect(shimsIndex).toBeGreaterThan(appBinIndex);
    } finally {
      process.env.PATH = originalPath;
      if (originalFlag === undefined) {
        delete process.env.OPENCLAW_PATH_BOOTSTRAPPED;
      } else {
        process.env.OPENCLAW_PATH_BOOTSTRAPPED = originalFlag;
      }
      if (originalMiseDataDir === undefined) {
        delete process.env.MISE_DATA_DIR;
      } else {
        process.env.MISE_DATA_DIR = originalMiseDataDir;
      }
    }
  });

  it("only appends project-local node_modules/.bin when explicitly enabled", async () => {
    const tmp = path.join(fixtureRoot, `case-${fixtureCount++}`);
    const originalPath = process.env.PATH;
    const originalFlag = process.env.OPENCLAW_PATH_BOOTSTRAPPED;
    try {
      const appBinDir = path.join(tmp, "AppBin");
      await fs.mkdir(appBinDir, { recursive: true });
      const appCli = path.join(appBinDir, "openclaw");
      await fs.writeFile(appCli, "#!/bin/sh\necho ok\n", "utf-8");
      await fs.chmod(appCli, 0o755);

      const localBinDir = path.join(tmp, "node_modules", ".bin");
      await fs.mkdir(localBinDir, { recursive: true });
      const localCli = path.join(localBinDir, "openclaw");
      await fs.writeFile(localCli, "#!/bin/sh\necho ok\n", "utf-8");
      await fs.chmod(localCli, 0o755);

      process.env.PATH = "/usr/bin";
      delete process.env.OPENCLAW_PATH_BOOTSTRAPPED;

      ensureOpenClawCliOnPath({
        execPath: appCli,
        cwd: tmp,
        homeDir: tmp,
        platform: "darwin",
      });
      const withoutOptIn = (process.env.PATH ?? "").split(path.delimiter);
      expect(withoutOptIn.includes(localBinDir)).toBe(false);

      process.env.PATH = "/usr/bin";
      delete process.env.OPENCLAW_PATH_BOOTSTRAPPED;

      ensureOpenClawCliOnPath({
        execPath: appCli,
        cwd: tmp,
        homeDir: tmp,
        platform: "darwin",
        allowProjectLocalBin: true,
      });
      const withOptIn = (process.env.PATH ?? "").split(path.delimiter);
      const usrBinIndex = withOptIn.indexOf("/usr/bin");
      const localIndex = withOptIn.indexOf(localBinDir);
      expect(usrBinIndex).toBeGreaterThanOrEqual(0);
      expect(localIndex).toBeGreaterThan(usrBinIndex);
    } finally {
      process.env.PATH = originalPath;
      if (originalFlag === undefined) {
        delete process.env.OPENCLAW_PATH_BOOTSTRAPPED;
      } else {
        process.env.OPENCLAW_PATH_BOOTSTRAPPED = originalFlag;
      }
    }
  });

  it("prepends Linuxbrew dirs when present", async () => {
    const tmp = path.join(fixtureRoot, `case-${fixtureCount++}`);
    const originalPath = process.env.PATH;
    const originalFlag = process.env.OPENCLAW_PATH_BOOTSTRAPPED;
    const originalHomebrewPrefix = process.env.HOMEBREW_PREFIX;
    const originalHomebrewBrewFile = process.env.HOMEBREW_BREW_FILE;
    const originalXdgBinHome = process.env.XDG_BIN_HOME;
    try {
      const execDir = path.join(tmp, "exec");
      await fs.mkdir(execDir, { recursive: true });

      const linuxbrewBin = path.join(tmp, ".linuxbrew", "bin");
      const linuxbrewSbin = path.join(tmp, ".linuxbrew", "sbin");
      await fs.mkdir(linuxbrewBin, { recursive: true });
      await fs.mkdir(linuxbrewSbin, { recursive: true });

      process.env.PATH = "/usr/bin";
      delete process.env.OPENCLAW_PATH_BOOTSTRAPPED;
      delete process.env.HOMEBREW_PREFIX;
      delete process.env.HOMEBREW_BREW_FILE;
      delete process.env.XDG_BIN_HOME;

      ensureOpenClawCliOnPath({
        execPath: path.join(execDir, "node"),
        cwd: tmp,
        homeDir: tmp,
        platform: "linux",
      });

      const updated = process.env.PATH ?? "";
      const parts = updated.split(path.delimiter);
      expect(parts[0]).toBe(linuxbrewBin);
      expect(parts[1]).toBe(linuxbrewSbin);
    } finally {
      process.env.PATH = originalPath;
      if (originalFlag === undefined) {
        delete process.env.OPENCLAW_PATH_BOOTSTRAPPED;
      } else {
        process.env.OPENCLAW_PATH_BOOTSTRAPPED = originalFlag;
      }
      if (originalHomebrewPrefix === undefined) {
        delete process.env.HOMEBREW_PREFIX;
      } else {
        process.env.HOMEBREW_PREFIX = originalHomebrewPrefix;
      }
      if (originalHomebrewBrewFile === undefined) {
        delete process.env.HOMEBREW_BREW_FILE;
      } else {
        process.env.HOMEBREW_BREW_FILE = originalHomebrewBrewFile;
      }
      if (originalXdgBinHome === undefined) {
        delete process.env.XDG_BIN_HOME;
      } else {
        process.env.XDG_BIN_HOME = originalXdgBinHome;
      }
    }
  });
});
