import { migrateManagedWorktreeCanonicalWorkspaces } from "../config/sessions/worktree-workspace-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  isOpenClawAgentDatabaseOpen,
} from "../state/openclaw-agent-db.js";
import { runDoctorAgentDatabaseOperationAsync } from "./doctor-agent-database-operation.js";
import {
  listExistingAgentDatabaseTargets,
  type ExistingAgentDatabaseTarget,
} from "./doctor-session-sqlite-readers.js";

/** Run after key repairs, whose source claims include workspace metadata. */
export async function repairLegacySessionWorktreeWorkspaces(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  targets?: readonly ExistingAgentDatabaseTarget[];
}) {
  const targets = params.targets ?? listExistingAgentDatabaseTargets(params.cfg, params.env);
  let found = 0;
  let repaired = 0;
  for (const target of targets) {
    const wasOpen = isOpenClawAgentDatabaseOpen(target.sqlitePath);
    try {
      const operation = await runDoctorAgentDatabaseOperationAsync({
        agentId: target.agentId,
        path: target.sqlitePath,
        run: () =>
          migrateManagedWorktreeCanonicalWorkspaces({
            agentId: target.agentId,
            cfg: params.cfg,
            env: params.env,
            storePath: target.sqlitePath,
            mode: params.apply ? "doctor-fix" : "detect",
          }),
      });
      if (operation.ok) {
        found += operation.value.found;
        repaired += operation.value.repaired;
      }
    } finally {
      if (!wasOpen) {
        await closeOpenClawAgentDatabaseByPathAsync(target.sqlitePath);
      }
    }
  }
  return { found, repaired, scannedStores: targets.length };
}
