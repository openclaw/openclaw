import {
  listAgentIds,
  resolveAgentDir,
  tryResolveAmbientOwnerAgentId,
} from "../../../agents/agent-scope-config.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "../../../agents/auth-profiles/path-resolve.js";
import { loadPersistedAuthProfileStoreAtDatabasePath } from "../../../agents/auth-profiles/persisted.js";
import { resolveAuthProfileDatabasePath } from "../../../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { ProviderRename, ProviderRenameAuthProfiles } from "./provider-rename.js";

/** Bind to saved credentials only: no runtime overlays, external CLI sync, or keychain reads. */
export function bindProviderRenameAuthProfiles(
  config: OpenClawConfig,
  renames: readonly ProviderRename[],
  env: NodeJS.ProcessEnv = process.env,
  agentIds: readonly string[] = [],
): ProviderRename[] {
  if (renames.length === 0) {
    return [];
  }
  const sharedPath = resolveSharedAuthStorePath(env);
  const shared = loadPersistedAuthProfileStoreAtDatabasePath(
    sharedPath,
    resolveSharedAuthStoreOwnership(env).location === "state-db" ? "shared-state" : "agent",
  );
  const defaultAgentId = tryResolveAmbientOwnerAgentId(config);
  const profilesByAgent = new Map<string, AuthProfileStore["profiles"]>();
  for (const agentId of new Set([
    ...listAgentIds(config),
    ...agentIds,
    ...(defaultAgentId ? [defaultAgentId] : []),
  ])) {
    const localPath = resolveAuthProfileDatabasePath(resolveAgentDir(config, agentId, env));
    const local =
      localPath === sharedPath
        ? undefined
        : loadPersistedAuthProfileStoreAtDatabasePath(localPath, "agent");
    profilesByAgent.set(agentId, { ...shared?.profiles, ...local?.profiles });
  }
  const select = (
    profiles: AuthProfileStore["profiles"],
    provider: string,
  ): ProviderRenameAuthProfiles => {
    const targetAuthProfileIds = Object.keys(profiles).filter(
      (id) => profiles[id].provider === provider,
    );
    const defaultId = `${provider}:default`;
    const targetAuthProfileId = targetAuthProfileIds.includes(defaultId)
      ? defaultId
      : targetAuthProfileIds.length === 1
        ? targetAuthProfileIds[0]
        : undefined;
    return { targetAuthProfileIds, targetAuthProfileId };
  };
  return renames.map((rename) => {
    const sharedAuthProfiles = select(shared?.profiles ?? {}, rename.to);
    return {
      ...rename,
      ...(defaultAgentId
        ? select(profilesByAgent.get(defaultAgentId) ?? {}, rename.to)
        : sharedAuthProfiles),
      sharedAuthProfiles,
      targetAuthProfilesByAgent: Object.fromEntries(
        [...profilesByAgent].map(([id, profiles]) => [id, select(profiles, rename.to)]),
      ),
    };
  });
}
