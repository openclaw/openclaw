import { hasOrphanedSqliteSidecars } from "../../infra/sqlite-files.js";
import { createRetainedAgentDatabaseMatcher } from "../../state/agent-deletion-discovery.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveConfiguredAgentDatabaseTargets, type SessionStoreTarget } from "./targets.js";

/** Preserve deleted stores across Doctor's session import and legacy-key repair. */
export function selectSessionStoreMaintenanceTargets<
  T extends { target: SessionStoreTarget; sqlitePath: string },
>(
  targets: T[],
  params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    onExcluded?: (sqlitePath: string) => void;
  },
): T[] {
  const isRetained = createRetainedAgentDatabaseMatcher(
    params.env,
    () => resolveConfiguredAgentDatabaseTargets(params.cfg, { env: params.env }),
    {
      kind: "legacy-database",
      readDatabasePaths: () => targets.map(({ sqlitePath }) => sqlitePath),
    },
  );
  return targets.filter(({ target, sqlitePath }) => {
    const orphanedSidecars = hasOrphanedSqliteSidecars(sqlitePath);
    const admitted = [target.storePath, sqlitePath].every((pathname) => {
      const disposition = isRetained(pathname, target.agentId);
      // Unknown history is not a deletion; an incomplete SQLite family still needs recovery.
      return !disposition || (disposition === "unavailable" && !orphanedSidecars);
    });
    if (!admitted) {
      params.onExcluded?.(sqlitePath);
    }
    return admitted;
  });
}
