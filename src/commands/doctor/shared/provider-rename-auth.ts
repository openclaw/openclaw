import {
  listAgentIds,
  resolveAgentDir,
  tryResolveAmbientOwnerAgentId,
} from "../../../agents/agent-scope-config.js";
import { coerceLegacyAuthProfileStore } from "../../../agents/auth-profiles/legacy-flat-credential.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "../../../agents/auth-profiles/path-resolve.js";
import {
  inspectAuthProfileJsonCellReadOnly,
  resolveAuthProfileDatabasePath,
} from "../../../agents/auth-profiles/sqlite.js";
import { AuthProfileStoreUnreadableError } from "../../../agents/auth-profiles/store-unreadable-error.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { ProviderRename, ProviderRenameAuthProfiles } from "./provider-rename.js";

function loadSavedAuthProfiles(
  databasePath: string,
  kind: "agent" | "shared-state",
  env: NodeJS.ProcessEnv,
): AuthProfileStore | null {
  const credentials = inspectAuthProfileJsonCellReadOnly(
    { path: databasePath, kind, env },
    "store",
  );
  if (credentials.status === "missing") {
    return null;
  }
  const store =
    credentials.status === "readable" ? coerceLegacyAuthProfileStore(credentials.raw) : null;
  if (!store) {
    throw new AuthProfileStoreUnreadableError(databasePath);
  }
  return store;
}

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
  const shared = loadSavedAuthProfiles(
    sharedPath,
    resolveSharedAuthStoreOwnership(env).location === "state-db" ? "shared-state" : "agent",
    env,
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
      localPath === sharedPath ? undefined : loadSavedAuthProfiles(localPath, "agent", env);
    profilesByAgent.set(agentId, { ...shared?.profiles, ...local?.profiles });
  }
  // Inherited config cannot pin a shared ID shadowed by an agent's other provider.
  const sharedProfiles = { ...shared?.profiles };
  for (const profiles of profilesByAgent.values()) {
    for (const [id, profile] of Object.entries(sharedProfiles)) {
      if (profiles[id]?.provider !== profile.provider) {
        delete sharedProfiles[id];
      }
    }
  }
  const select = (
    profiles: AuthProfileStore["profiles"],
    provider: string,
  ): ProviderRenameAuthProfiles => {
    const targetAuthProfileIds = Object.entries(profiles)
      .filter(([, profile]) => profile.provider === provider)
      .map(([id]) => id);
    const defaultId = `${provider}:default`;
    const targetAuthProfileId = targetAuthProfileIds.includes(defaultId)
      ? defaultId
      : targetAuthProfileIds.length === 1
        ? targetAuthProfileIds[0]
        : undefined;
    return { targetAuthProfileIds, targetAuthProfileId };
  };
  return renames.map((rename) => {
    const sharedAuthProfiles = select(sharedProfiles, rename.to);
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
