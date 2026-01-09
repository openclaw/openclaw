import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type EnvSnapshot = {
  home: string | undefined;
  userProfile: string | undefined;
  homeDrive: string | undefined;
  homePath: string | undefined;
};

function snapshotEnv(): EnvSnapshot {
  return {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    homeDrive: process.env.HOMEDRIVE,
    homePath: process.env.HOMEPATH,
  };
}

function restoreEnv(snapshot: EnvSnapshot) {
  const restoreKey = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restoreKey("HOME", snapshot.home);
  restoreKey("USERPROFILE", snapshot.userProfile);
  restoreKey("HOMEDRIVE", snapshot.homeDrive);
  restoreKey("HOMEPATH", snapshot.homePath);
}

function setTempHome(base: string) {
  process.env.HOME = base;
  process.env.USERPROFILE = base;

  if (process.platform !== "win32") return;
  const match = base.match(/^([A-Za-z]:)(.*)$/);
  if (!match) return;
  process.env.HOMEDRIVE = match[1];
  process.env.HOMEPATH = match[2] || "\\";
}

export async function withTempHome<T>(
  fn: (home: string) => Promise<T>,
  opts: { prefix?: string } = {},
): Promise<T> {
  const base = await fs.mkdtemp(
    path.join(os.tmpdir(), opts.prefix ?? "clawdbot-test-home-"),
  );
  const snapshot = snapshotEnv();
  setTempHome(base);

  try {
    return await fn(base);
  } finally {
    restoreEnv(snapshot);
    try {
      await fs.rm(base, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    } catch {
      // ignore cleanup failures in tests
    }
  }
}
