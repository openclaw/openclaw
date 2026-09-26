import type { PlacementRecoveryDeps } from "./placement-dispatch-pending-results.js";
import type { WithPreparedWorkerWorkspaceRecovery } from "./placement-reclaim-contract.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import type {
  WorkerWorkspaceConflictReport,
  WorkspaceResultConflictLookup,
} from "./workspace-conflicts.js";

export type WorkerWorkspaceRecoveryFailureReport = WorkerSessionPlacementIdentity & {
  error: string;
};

export function createWorkerWorkspaceRecoveryFixture(options: {
  resolveWorkspace: PlacementRecoveryDeps["resolveWorkspace"];
  resolveConflict?: (
    identity: WorkerSessionPlacementIdentity,
  ) => Promise<WorkspaceResultConflictLookup>;
  reportConflict?: (
    report: WorkerSessionPlacementIdentity & WorkerWorkspaceConflictReport,
  ) => Promise<void>;
  reportFailure?: (report: WorkerWorkspaceRecoveryFailureReport) => Promise<void>;
}): Pick<PlacementRecoveryDeps, "resolveWorkspace" | "withPreparedRecovery"> {
  const withPreparedRecovery: WithPreparedWorkerWorkspaceRecovery = async (
    { sessionId, sessionKey, agentId },
    assertCurrent,
    run,
  ) => {
    const identity = { sessionId, sessionKey, agentId };
    assertCurrent();
    const workspace = await options.resolveWorkspace(identity);
    assertCurrent();
    return await run({
      workspace,
      assertCurrent,
      resolveConflict: async () => {
        assertCurrent();
        const lookup = await options.resolveConflict?.(identity);
        assertCurrent();
        return lookup ?? { kind: "absent" };
      },
      reportConflict: async (report) => {
        assertCurrent();
        await options.reportConflict?.({ ...identity, ...report });
        assertCurrent();
      },
      reportFailure: async (error) => {
        assertCurrent();
        await options.reportFailure?.({ ...identity, error });
        assertCurrent();
      },
    });
  };
  return { resolveWorkspace: options.resolveWorkspace, withPreparedRecovery };
}
