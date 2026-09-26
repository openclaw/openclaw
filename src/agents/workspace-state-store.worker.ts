import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  resolveWorkspaceStateAliases,
  WorkspaceAliasRepointedError,
} from "./workspace-state-identity.js";
import {
  readWorkspaceStateSnapshotFromDatabase,
  registerWorkspaceStateAliasIdentitiesInTransaction,
  workspacePathEntryExists,
  type WorkspaceStateSnapshot,
  type WorkspaceIdentityResolution,
} from "./workspace-state-store.kernel.js";

export function registerWorkspaceStateAliasesInDatabase(
  database: OpenClawStateDatabase,
  workspaceDir: string,
  resolution: WorkspaceIdentityResolution,
  admit: (stage: "transaction" | "commit") => void,
): WorkspaceStateSnapshot {
  // Register a newly observed configured spelling once state proves the target
  // identity. Later disappearance must still find the same safety evidence.
  return runOpenClawStateWriteTransaction(
    (writeDatabase) => {
      admit("transaction");
      const currentAliases = resolveWorkspaceStateAliases(workspaceDir);
      const currentCanonicalIdentity = currentAliases.at(-1)!;
      if (
        workspacePathEntryExists(workspaceDir) &&
        currentCanonicalIdentity.workspaceKey !== resolution.identity.workspaceKey
      ) {
        throw new WorkspaceAliasRepointedError({
          aliasPath: currentAliases[0]!.workspacePath,
          storedWorkspacePath: resolution.identity.workspacePath,
          currentWorkspacePath: currentCanonicalIdentity.workspacePath,
        });
      }
      const snapshot = readWorkspaceStateSnapshotFromDatabase({
        identity: resolution.identity,
        database: writeDatabase,
      });
      if (snapshot.setupExists || snapshot.attestation) {
        const aliases = new Map(
          [...resolution.aliases, ...currentAliases].map((alias) => [alias.workspaceKey, alias]),
        );
        registerWorkspaceStateAliasIdentitiesInTransaction({
          database: writeDatabase,
          identity: resolution.identity,
          aliases: [...aliases.values()],
          updatedAtMs: Date.now(),
        });
      }
      admit("commit");
      return snapshot;
    },
    { database },
  );
}
