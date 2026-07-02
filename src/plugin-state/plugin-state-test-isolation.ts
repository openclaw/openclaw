// Test-only helper: per-test OPENCLAW_STATE_DIR isolation for persistent
// plugin-state consumers (e.g. persistent dedupe). The shared test home is
// per-worker, so suites that commit fixed keys through SQLite-backed state
// would otherwise collide across tests/files under --isolate=false.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "./plugin-state-store.js";

/** Points OPENCLAW_STATE_DIR at a fresh temp dir; call restore() in afterEach. */
export function installIsolatedPluginStateDirForTests(): {
  stateDir: string;
  restore: () => void;
} {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-state-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  // resetPluginStateStoreForTests only drops the cached DB handle; rows survive,
  // so isolation requires the fresh state dir above, not just the reset.
  resetPluginStateStoreForTests({ closeDatabase: false });
  return {
    stateDir,
    restore: () => {
      resetPluginStateStoreForTests();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}
