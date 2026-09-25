import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { tryAcquireExclusiveSqliteCoordinator } from "../../infra/sqlite-coordinator.js";
import {
  resolveStateDatabaseCoordinatorPath,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "../../infra/state-database-coordinator.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { fingerprintSessionGoalRequest } from "./session-goal-request.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("fingerprints chat sends with the cached identity while the state database is busy", () => {
  const stateDir = tempDirs.make("openclaw-chat-identity-contention-");
  const runtimeDirectory = path.join(stateDir, "runtime");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

  withStateDatabaseCoordinatorRuntimeDirectory(runtimeDirectory, () => {
    const request = { sessionKey: "agent:test:main", message: "hello" };
    const expected = fingerprintSessionGoalRequest(request);
    closeOpenClawStateDatabaseForTest();

    // Hold the real lifecycle lock without borrowing this thread's reentrant owner.
    const coordinatorPath = resolveStateDatabaseCoordinatorPath({
      databasePath: path.join(stateDir, "state", "openclaw.sqlite"),
      runtimeDirectory,
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    });
    const blocker = tryAcquireExclusiveSqliteCoordinator(coordinatorPath, { busyTimeoutMs: 0 });
    expect(blocker).not.toBeNull();
    try {
      expect(fingerprintSessionGoalRequest(request)).toBe(expected);
      expect(fingerprintSessionGoalRequest({ ...request, message: "changed" })).not.toBe(expected);
    } finally {
      blocker?.release();
    }
  });
});
