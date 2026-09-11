/** Read-only target layout shared by startup migration and Doctor session repairs. */
import fs from "node:fs";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  resolveAllAgentSessionStoreCandidateTargetsSync,
  type SessionStoreTarget as ResolvedSessionStoreTarget,
} from "./targets.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };
export type ExistingAgentDatabaseTarget = SessionStoreTarget & { sqlitePath: string };

export function resolveTargetSqliteOptions(target: SessionStoreTarget, env?: NodeJS.ProcessEnv) {
  return toDatabaseOptions(
    resolveSqliteReadScope({
      agentId: target.agentId,
      env,
      storePath: target.sqlitePath ?? target.storePath,
    }),
  );
}

export function resolveTargetSqlitePath(
  target: SessionStoreTarget,
  env?: NodeJS.ProcessEnv,
): string {
  return resolveOpenClawAgentSqlitePath(resolveTargetSqliteOptions(target, env));
}

/** First physical path wins; callers retain ownership of target selection. */
export function projectExistingAgentDatabaseTargets(
  targets: readonly SessionStoreTarget[],
  env: NodeJS.ProcessEnv,
): ExistingAgentDatabaseTarget[] {
  const seenPaths = new Set<string>();
  return targets.flatMap((target) => {
    const sqlitePath = resolveTargetSqlitePath(target, env);
    if (seenPaths.has(sqlitePath) || !fs.existsSync(sqlitePath)) {
      return [];
    }
    seenPaths.add(sqlitePath);
    return [{ agentId: target.agentId, sqlitePath, storePath: target.storePath }];
  });
}

export function listExistingAgentDatabaseTargets(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): ExistingAgentDatabaseTarget[] {
  return projectExistingAgentDatabaseTargets(
    resolveAllAgentSessionStoreCandidateTargetsSync(cfg, { env }),
    env,
  );
}
