import { copyCanonicalAuthProfileCredentialObservations } from "../agents/auth-profiles/credential-observation.js";
import {
  AuthProfileMigrationRequiredError,
  markAuthProfileMigrationRequired,
} from "../agents/auth-profiles/legacy-source-diagnostic.js";
import {
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
} from "../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { readAgentDatabaseReadAdmissionRefusal } from "../state/agent-database-admission.js";
import { getOrLoadAgentDeletionJournalStatus } from "../state/agent-deletion-journal-status.js";
import { isSameOpenClawAgentDatabasePath } from "../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { shortenHomePath } from "../utils.js";
import type { DegradedSecretOwner } from "./runtime-degraded-state.js";

export async function loadAdmittedAuthStores(params: {
  agentDirs: readonly string[];
  env: NodeJS.ProcessEnv;
  loadAuthStore: (agentDir?: string) => AuthProfileStore | Promise<AuthProfileStore>;
  allowUnavailable: boolean;
}): Promise<{
  authStores: Array<{ agentDir: string; store: AuthProfileStore }>;
  degradedOwners: DegradedSecretOwner[];
}> {
  const authStores: Array<{ agentDir: string; store: AuthProfileStore }> = [];
  const degradedOwners: DegradedSecretOwner[] = [];
  const statePath = resolveOpenClawStateSqlitePath(params.env);
  for (const agentDir of params.agentDirs) {
    const databasePath = resolveAuthProfileDatabasePath(agentDir);
    const agentId = resolveAuthProfileDatabaseOwnerId(agentDir);
    const isDeleted = () => {
      const status = getOrLoadAgentDeletionJournalStatus(statePath, agentId, () => undefined);
      return status === "pending" || status === "complete";
    };
    // A concurrent roster write can still name an owner whose deletion already committed.
    // Never reopen or publish its credentials while the deletion owner retires its readers.
    if (isDeleted()) {
      continue;
    }
    const refusal = readAgentDatabaseReadAdmissionRefusal(agentId, {
      env: params.env,
    });
    if (
      refusal?.paths.some((pathname) => isSameOpenClawAgentDatabasePath(pathname, databasePath))
    ) {
      // The admission owner keeps this store unavailable, including cached credentials.
      // Pending preparation resolves its secrets before publishing successful admission.
      if (refusal.code === "agent-database-inspection-pending") {
        continue;
      }
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
      const source = await params.loadAuthStore(agentDir);
      if (isDeleted()) {
        continue;
      }
      const store = structuredClone(source);
      copyCanonicalAuthProfileCredentialObservations(source.profiles, store.profiles);
      authStores.push({ agentDir, store });
    } catch (error) {
      if (isDeleted()) {
        continue;
      }
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
