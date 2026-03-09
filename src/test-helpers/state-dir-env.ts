import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureEnv } from "../test-utils/env.js";

export function snapshotStateDirEnv() {
  return captureEnv(["OPENCLAW_STATE_DIR", "CLAWDBOT_STATE_DIR"]);
}

export function restoreStateDirEnv(snapshot: ReturnType<typeof snapshotStateDirEnv>): void {
  snapshot.restore();
}

export function setStateDirEnv(stateDir: string): void {
  process.env.OPENCLAW_STATE_DIR = stateDir;
  delete process.env.CLAWDBOT_STATE_DIR;
}

export async function withStateDirEnv<T>(
  prefix: string,
  fn: (ctx: { tempRoot: string; stateDir: string }) => Promise<T>,
): Promise<T> {
  const snapshot = snapshotStateDirEnv();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(tempRoot, "state");
  await fs.mkdir(stateDir, { recursive: true });
  setStateDirEnv(stateDir);
  try {
    return await fn({ tempRoot, stateDir });
  } finally {
    restoreStateDirEnv(snapshot);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
