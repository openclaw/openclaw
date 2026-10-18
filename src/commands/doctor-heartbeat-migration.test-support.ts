import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { captureEnv } from "../test-utils/env.js";

export function useHeartbeatMigrationRoots(
  prefix: string,
  beforeCleanup: () => void | Promise<void> = () => {},
) {
  const roots: string[] = [];
  let savedEnv: ReturnType<typeof captureEnv>;
  beforeEach(() => {
    savedEnv = captureEnv(["HOME", "OPENCLAW_STATE_DIR"]);
  });
  afterEach(async () => {
    await beforeCleanup();
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    savedEnv.restore();
    await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });
  return async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
  };
}
