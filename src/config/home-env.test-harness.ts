import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureEnv } from "../test-utils/env.js";

export async function withTempHome<T>(
  prefix: string,
  fn: (home: string) => Promise<T>,
): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });

  const snapshot = captureEnv([
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "OPENCLAW_STATE_DIR",
  ]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");

  if (process.platform === "win32") {
    const match = home.match(/^([A-Za-z]:)(.*)$/);
    if (match) {
      process.env.HOMEDRIVE = match[1];
      process.env.HOMEPATH = match[2] || "\\";
    }
  }

  try {
    return await fn(home);
  } finally {
    snapshot.restore();
    await fs.rm(home, { recursive: true, force: true });
  }
}
