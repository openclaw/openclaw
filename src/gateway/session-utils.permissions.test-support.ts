import { afterAll } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as execApprovalsStore from "../infra/exec-approvals-store.js";
import { withEnvAsync } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";

let agentPermissionStateDir: string | undefined;
let pristineAgentApprovals:
  | ReturnType<typeof execApprovalsStore.readExecApprovalsSnapshot>
  | undefined;
const agentPermissionDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    if (agentPermissionStateDir) {
      await cleanupSessionStateForTest({ stateDir: agentPermissionStateDir });
    }
    cleanup();
  }),
);

export async function withAgentPermissionState<T>(fn: () => Promise<T>): Promise<T> {
  // Permission rows share empty provenance; only their persisted approval policy varies.
  agentPermissionStateDir ??= agentPermissionDirs.make("openclaw-agent-permission-");
  return withEnvAsync({ OPENCLAW_STATE_DIR: agentPermissionStateDir }, async () => {
    pristineAgentApprovals ??= execApprovalsStore.readExecApprovalsSnapshot();
    execApprovalsStore.restoreExecApprovalsSnapshot(pristineAgentApprovals);
    return fn();
  });
}
