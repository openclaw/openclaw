// Creates isolated temporary home directories for config-heavy tests.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "./env.js";

const HOME_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
] as const;

export type TempHomeEnv = {
  home: string;
  restore: () => Promise<void>;
};

/** Creates a temporary OpenClaw home and process env override for stateful tests. */
export async function createTempHomeEnv(prefix: string): Promise<TempHomeEnv> {
  const { cleanupSessionStateForTest } = await import("./session-state-cleanup.js");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(home, ".openclaw");
  const snapshot = captureEnv([...HOME_ENV_KEYS]);
  try {
    await fs.mkdir(stateDir, { mode: 0o700 });
    setTestEnvValue("HOME", home);
    setTestEnvValue("USERPROFILE", home);
    deleteTestEnvValue("OPENCLAW_HOME");
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    if (process.platform === "win32") {
      const match = home.match(/^([A-Za-z]:)(.*)$/);
      if (match) {
        setTestEnvValue("HOMEDRIVE", expectDefined(match[1], "temp home regex capture 1"));
        setTestEnvValue("HOMEPATH", match[2] || "\\");
      }
    }
  } catch (error) {
    // No fixture work has started, so rollback must not drain shared session state.
    snapshot.restore();
    await fs.rm(home, { recursive: true, force: true });
    throw error;
  }

  return {
    home,
    restore: async () => {
      try {
        await cleanupSessionStateForTest({ stateDir, rootPath: home });
      } finally {
        snapshot.restore();
      }
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}
