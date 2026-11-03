import path from "node:path";
import { listConfiguredSessionStoreAgentIds } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  LEGACY_IMPLICIT_AGENT_ID as DEFAULT_AGENT_ID,
  normalizeAgentId,
} from "../routing/session-key.js";
import { expandHomePrefix } from "./home-dir.js";
import { safeReadDir } from "./state-migrations.fs.js";
import {
  resolveSessionStoreAliasPlan,
  sessionStorePathsMatch,
} from "./state-migrations.session-store-paths.js";
import type { SessionStoreAliasPlan } from "./state-migrations.types.js";

export function resolveStorePathFromTemplate(
  template: string,
  agentId: string,
  env: NodeJS.ProcessEnv,
): string {
  return path.resolve(expandHomePrefix(template.replaceAll("{agentId}", agentId), { env }));
}

export function mergeSessionStoreAliasPlans(
  left: SessionStoreAliasPlan | undefined,
  right: SessionStoreAliasPlan,
): SessionStoreAliasPlan {
  if (!left) {
    return right;
  }
  return {
    hasDistinctAliases: left.hasDistinctAliases || right.hasDistinctAliases,
    hasFinalSymlink: left.hasFinalSymlink || right.hasFinalSymlink,
    hasUnresolvedIdentity: left.hasUnresolvedIdentity || right.hasUnresolvedIdentity,
  };
}

export type SessionStoreOwnership = {
  preserveAmbiguousKeys: boolean;
  preserveForeignMainAliases: boolean;
  targetStoreAliases: SessionStoreAliasPlan;
};

export function resolveSessionStoreOwnership(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  targetAgentId: string;
  pluginSessionStoreAgentIds: readonly string[];
}): SessionStoreOwnership {
  const targetStorePath = path.join(
    params.stateDir,
    "agents",
    params.targetAgentId,
    "sessions",
    "sessions.json",
  );
  const configuredStore = params.cfg.session?.store;
  const resolveAgentStorePath = (agentId: string) =>
    configuredStore
      ? resolveStorePathFromTemplate(configuredStore, agentId, params.env)
      : path.join(params.stateDir, "agents", agentId, "sessions", "sessions.json");
  const preserveForeignMainAliases = params.pluginSessionStoreAgentIds.some((pluginAgentId) => {
    const id = normalizeAgentId(pluginAgentId);
    if (id === DEFAULT_AGENT_ID) {
      return false;
    }
    return sessionStorePathsMatch(resolveAgentStorePath(id), targetStorePath);
  });
  const candidateAgentIds = new Set([
    ...listConfiguredSessionStoreAgentIds(params.cfg).map((id) => normalizeAgentId(id)),
    ...params.pluginSessionStoreAgentIds.map((id) => normalizeAgentId(id)),
  ]);
  const configuredOwnerStorePaths = [...candidateAgentIds].map(resolveAgentStorePath);
  const targetStoreOwnerCount = configuredOwnerStorePaths.filter((storePath) =>
    sessionStorePathsMatch(storePath, targetStorePath),
  ).length;
  const preserveAmbiguousKeys = targetStoreOwnerCount > 1;
  const candidateStorePaths = [...configuredOwnerStorePaths];
  const agentsDir = path.join(params.stateDir, "agents");
  for (const entry of safeReadDir(agentsDir)) {
    if (entry.isDirectory()) {
      candidateStorePaths.push(path.join(agentsDir, entry.name, "sessions", "sessions.json"));
    }
  }
  const targetStoreAliases = resolveSessionStoreAliasPlan(targetStorePath, candidateStorePaths);
  return { preserveAmbiguousKeys, preserveForeignMainAliases, targetStoreAliases };
}
