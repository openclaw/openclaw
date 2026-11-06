import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import {
  readUserGitHubConnectionInDatabase,
  writeUserGitHubConnectionInDatabase,
} from "./user-github-connections.kernel.js";
import type { UserGitHubConnection } from "./user-github-connections.types.js";

/** Native fixture mutation for final-guard and recovery boundary tests. */
export function updateUserGitHubConnection(
  owner: string,
  update: (current: UserGitHubConnection | undefined) => UserGitHubConnection,
  assertCurrent: () => void,
  database?: OpenClawStateDatabaseOptions,
): UserGitHubConnection {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const current = readUserGitHubConnectionInDatabase(db, owner);
      const next = update(current);
      assertCurrent();
      return writeUserGitHubConnectionInDatabase(db, owner, next, current);
    },
    database,
    { operationLabel: "users.github.fixture" },
  );
}

export function expireUserGitHubAuthorization(owner: string): void {
  updateUserGitHubConnection(
    owner,
    (current) => {
      if (current?.pending?.kind !== "device") {
        throw new Error("Expected pending device authorization");
      }
      const expiresAtMs = Date.now() - 1;
      return {
        ...current,
        pending: {
          ...current.pending,
          createdAtMs: expiresAtMs - 900000,
          expiresAtMs,
          nextPollAtMs: expiresAtMs,
        },
      };
    },
    () => {},
  );
}

export function expireUserGitHubAccessToken(owner: string): void {
  updateUserGitHubConnection(
    owner,
    (current) => {
      if (current?.selection.kind !== "connected") {
        throw new Error("Expected connection");
      }
      return { ...current, selection: { ...current.selection, accessExpiresAtMs: Date.now() - 1 } };
    },
    () => {},
  );
}
