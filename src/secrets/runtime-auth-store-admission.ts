import {
  AuthProfileMigrationRequiredError,
  markAuthProfileMigrationRequired,
} from "../agents/auth-profiles/legacy-source-diagnostic.js";
import {
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
} from "../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import { isSameOpenClawAgentDatabasePath } from "../state/openclaw-agent-db-registry.js";
import { shortenHomePath } from "../utils.js";
import type { DegradedSecretOwner } from "./runtime-degraded-state.js";

export function loadAdmittedAuthStores(params: {
  agentDirs: readonly string[];
  env: NodeJS.ProcessEnv;
  loadAuthStore: (agentDir?: string) => AuthProfileStore;
  allowUnavailable: boolean;
}): {
  authStores: Array<{ agentDir: string; store: AuthProfileStore }>;
  degradedOwners: DegradedSecretOwner[];
} {
  const authStores: Array<{ agentDir: string; store: AuthProfileStore }> = [];
  const degradedOwners: DegradedSecretOwner[] = [];
  for (const agentDir of params.agentDirs) {
    const databasePath = resolveAuthProfileDatabasePath(agentDir);
    const refusal = readAgentDatabaseAdmissionRefusal(resolveAuthProfileDatabaseOwnerId(agentDir), {
      env: params.env,
    });
    if (
      refusal?.paths.some((pathname) => isSameOpenClawAgentDatabasePath(pathname, databasePath))
    ) {
      // The admission owner keeps this store unavailable, including cached credentials.
      degradedOwners.push({
        ownerKind: "route",
        ownerId: shortenHomePath(databasePath),
        state: "unavailable",
        degradationState: "cold",
        paths: [databasePath],
        refKeys: [],
        reason: `${refusal.reason}\n${refusal.repairHint}`,
      });
      continue;
    }
    try {
      authStores.push({ agentDir, store: structuredClone(params.loadAuthStore(agentDir)) });
    } catch (error) {
      if (!(error instanceof AuthProfileMigrationRequiredError) || !params.allowUnavailable) {
        throw error;
      }
      markAuthProfileMigrationRequired(agentDir, error);
      authStores.push({ agentDir, store: { version: 1, profiles: {} } });
      degradedOwners.push({
        ownerKind: "route",
        ownerId: error.ownerId,
        state: "unavailable",
        degradationState: "cold",
        paths: error.sourceKinds.map((kind) => `auth-profile-legacy:${kind}`),
        refKeys: [],
        reason: "auth profile migration required",
      });
    }
  }
  return { authStores, degradedOwners };
}
