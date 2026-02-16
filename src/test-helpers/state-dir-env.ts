import { captureEnv } from "../test-utils/env.js";

export function snapshotStateDirEnv() {
  return captureEnv(["SMART_AGENT_NEO_STATE_DIR", "NEOBOT_STATE_DIR"]);
}

export function restoreStateDirEnv(snapshot: ReturnType<typeof snapshotStateDirEnv>): void {
  snapshot.restore();
}

export function setStateDirEnv(stateDir: string): void {
  process.env.SMART_AGENT_NEO_STATE_DIR = stateDir;
  delete process.env.NEOBOT_STATE_DIR;
}
