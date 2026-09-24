import {
  readAuthProfileRows,
  SHARED_AUTH_STORE_STATE_KEY,
} from "../agents/auth-profiles/sqlite-json.js";
import { isMissingDatabasePath } from "../agents/auth-profiles/sqlite-read-pool.js";
import type { AuthProfileRowRead } from "../agents/auth-profiles/types.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { readConfigMachineState } from "./config-machine-state.js";
import {
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerRuntimeCommand } from "./openclaw-state-worker-contract.js";
import { readUserModelAuthProfile } from "./user-model-accounts.js";

export function executeSharedAuthProfileCommand(
  command: Extract<
    OpenClawStateWorkerRuntimeCommand,
    { type: "authProfiles.read" | "authProfiles.sharedOwnership" | "authProfiles.personal" }
  >,
  context: { databasePath: string },
) {
  const read = () => {
    const options = {
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
    };
    if (command.type === "authProfiles.sharedOwnership") {
      return readConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, options);
    }
    if (command.type === "authProfiles.personal") {
      return readUserModelAuthProfile(command.input.profileId, options);
    }
    const missing: AuthProfileRowRead = {
      store: { status: "missing", reason: "database" },
      state: { status: "missing", reason: "database" },
      cacheable: false,
    };
    try {
      return (
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) => readAuthProfileRows(db, context.databasePath, "shared-state"),
          options,
        ) ?? missing
      );
    } catch {
      return isMissingDatabasePath(context.databasePath)
        ? missing
        : {
            store: { status: "unreadable" as const },
            state: { status: "unreadable" as const },
            cacheable: false,
          };
    }
  };
  return command.input.artifactPreserving ? withArtifactPreservingStateReads(read) : read();
}
