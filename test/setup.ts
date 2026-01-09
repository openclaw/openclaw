import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installWindowsCIOutputSanitizer } from "./windows-ci-output-sanitizer";

installWindowsCIOutputSanitizer();

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalStateDir = process.env.CLAWDBOT_STATE_DIR;
const originalTestHome = process.env.CLAWDBOT_TEST_HOME;

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-test-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.CLAWDBOT_TEST_HOME = tempHome;
if (process.platform === "win32") {
  process.env.CLAWDBOT_STATE_DIR = path.join(tempHome, ".clawdbot");
}
process.env.XDG_CONFIG_HOME = path.join(tempHome, ".config");
process.env.XDG_DATA_HOME = path.join(tempHome, ".local", "share");
process.env.XDG_STATE_HOME = path.join(tempHome, ".local", "state");
process.env.XDG_CACHE_HOME = path.join(tempHome, ".cache");

const restoreEnv = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

process.on("exit", () => {
  restoreEnv("HOME", originalHome);
  restoreEnv("USERPROFILE", originalUserProfile);
  restoreEnv("XDG_CONFIG_HOME", originalXdgConfigHome);
  restoreEnv("XDG_DATA_HOME", originalXdgDataHome);
  restoreEnv("XDG_STATE_HOME", originalXdgStateHome);
  restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
  restoreEnv("CLAWDBOT_STATE_DIR", originalStateDir);
  restoreEnv("CLAWDBOT_TEST_HOME", originalTestHome);
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});
