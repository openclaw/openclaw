import path from "node:path";
import { afterEach } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { clearAgentRunContext } from "../infra/agent-run-registry.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import type { admitWorkerStopChat } from "./server-worker-placement.test-harness.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "./session-utils-store.js";
import { REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

export function cleanupAdmission(
  runId: string,
  result: Awaited<Awaited<ReturnType<typeof admitWorkerStopChat>>["promise"]> | undefined,
) {
  if (result?.ok) {
    result.value.cleanupAdmittedRun();
    clearAgentRunContext(runId, result.value.lifecycleGeneration);
  }
}

export function sessionRuntime(storePath: string, worktreePath?: string) {
  return {
    managedWorktrees: {
      findLiveByOwner: async () =>
        worktreePath
          ? { id: "task-worktree", ownerId: REQUEST.sessionKey, path: worktreePath }
          : undefined,
    },
    resolveGatewaySessionStoreTargetInWorker: (
      params: Parameters<typeof resolveGatewaySessionStoreTargetInWorker>[0],
    ) =>
      resolveGatewaySessionStoreTargetInWorker({
        ...params,
        cfg: { ...params.cfg, session: { ...params.cfg.session, store: storePath } },
      }),
    resolveCanonicalSessionEntryFromStoreKeys,
  };
}

export function useReclaimFixtures() {
  const tempDirs = createTempDirTracker();
  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await closeStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    tempDirs.cleanup();
  });
  return {
    makeRoot: (prefix: string) => tempDirs.make(prefix),
    async createSession(
      root: string,
      options: {
        worktreePath?: string;
        lifecycleRevision?: string;
        now?: () => number;
      } = {},
    ) {
      const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      const placements = createWorkerSessionPlacementStore({ database, now: options.now });
      const storePath = path.join(root, "sessions.sqlite");
      setRuntimeConfigSnapshot({ session: { store: storePath } });
      const entry = {
        sessionId: REQUEST.sessionId,
        ...(options.lifecycleRevision ? { lifecycleRevision: options.lifecycleRevision } : {}),
        ...(options.worktreePath
          ? { worktree: { id: "task-worktree", branch: "test", repoRoot: options.worktreePath } }
          : {}),
        updatedAt: Date.now(),
      };
      await replaceSessionEntry({ ...REQUEST, storePath }, entry);
      const runtime = sessionRuntime(storePath, options.worktreePath);
      return { database, placements, storePath, entry, runtime };
    },
  };
}
