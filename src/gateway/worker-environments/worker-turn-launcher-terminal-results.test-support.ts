import type { WorkerPlacementSessionRuntime } from "../server-worker-placement-reclaim.js";
import {
  SESSION_ID,
  SESSION_KEY,
  root,
  sessionTarget,
} from "./worker-turn-launcher.test-support.js";

export async function loadTerminalPlacementSessionRuntime(): Promise<WorkerPlacementSessionRuntime> {
  const entry = {
    sessionId: SESSION_ID,
    updatedAt: 1,
    worktree: { id: "workspace", branch: "fixture", repoRoot: root },
  };
  return {
    managedWorktrees: {
      findLiveByOwner: () => ({
        id: "workspace",
        name: "fixture",
        repoFingerprint: "fixture",
        repoRoot: root,
        path: root,
        branch: "fixture",
        baseRef: "main",
        ownerKind: "session",
        ownerId: SESSION_KEY,
        createdAt: 1,
        lastActiveAt: 1,
      }),
    },
    resolveGatewaySessionStoreTargetWithStore: () => ({
      storePath: sessionTarget.storePath,
      canonicalKey: SESSION_KEY,
      storeKeys: [SESSION_KEY],
      agentId: "main",
      store: { [SESSION_KEY]: entry },
    }),
    resolveCanonicalSessionEntryFromStoreKeys: () => entry,
  };
}
