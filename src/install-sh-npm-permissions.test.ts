import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function runFixNpmPermissions(env: NodeJS.ProcessEnv): void {
  const installerPath = path.join(process.cwd(), "scripts", "install.sh");
  execFileSync("bash", ["-lc", 'source "$INSTALLER_PATH" && fix_npm_permissions'], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      ...env,
      INSTALLER_PATH: installerPath,
      OPENCLAW_INSTALL_SH_NO_RUN: "1",
    },
  });
}

describe("install.sh fix_npm_permissions", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        fs.chmodSync(dir, 0o755);
      } catch {
        // chmod can fail if the dir was already removed; ignore.
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "configures ~/.npm-global when npm prefix is not writable (macOS)",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm-home-"));
      tempDirs.push(home);
      const roPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm-ro-"));
      tempDirs.push(roPrefix);
      fs.chmodSync(roPrefix, 0o555);

      runFixNpmPermissions({
        OS: "macos",
        HOME: home,
        NPM_CONFIG_PREFIX: roPrefix,
      });

      const npmrc = path.join(home, ".npmrc");
      expect(fs.existsSync(npmrc)).toBe(true);
      expect(fs.readFileSync(npmrc, "utf-8")).toContain(".npm-global");
    },
  );

  it.runIf(process.platform !== "win32")(
    "configures ~/.npm-global when npm prefix is not writable (Linux)",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm-home-"));
      tempDirs.push(home);
      const roPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm-ro-"));
      tempDirs.push(roPrefix);
      fs.chmodSync(roPrefix, 0o555);

      runFixNpmPermissions({
        OS: "linux",
        HOME: home,
        NPM_CONFIG_PREFIX: roPrefix,
      });

      const npmrc = path.join(home, ".npmrc");
      expect(fs.existsSync(npmrc)).toBe(true);
      expect(fs.readFileSync(npmrc, "utf-8")).toContain(".npm-global");
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not rewrite npm prefix when the configured prefix is writable",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm-home-"));
      tempDirs.push(home);
      const writablePrefix = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm-ok-"));
      tempDirs.push(writablePrefix);

      runFixNpmPermissions({
        OS: "macos",
        HOME: home,
        NPM_CONFIG_PREFIX: writablePrefix,
      });

      const npmrc = path.join(home, ".npmrc");
      const content = fs.existsSync(npmrc) ? fs.readFileSync(npmrc, "utf-8") : "";
      expect(content).not.toContain(".npm-global");
    },
  );
});
