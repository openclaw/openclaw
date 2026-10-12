import {
  createSqliteWorkerOperationAdmission,
  observeSqliteWorkerCommittedFacts,
} from "../infra/sqlite-worker-operation-admission.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "./openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import {
  captureOpenClawStateReadWorkerContext,
  captureOpenClawStateWorkerContext,
} from "./openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";
import {
  observeUserGitHubConnectionAuthority,
  publishUserGitHubConnectionCommit,
} from "./user-github-connection-events.js";
import {
  cancelUserGitHubAuthorizationInDatabase,
  disconnectUserGitHubConnectionInDatabase,
  parseUserGitHubConnection,
  readUserGitHubConnectionInDatabase,
  resolvePersonalGitHubOwnerInDatabase,
} from "./user-github-connections.kernel.js";
import {
  isUserGitHubConnectionCommit,
  type UserGitHubConnection,
  type UserGitHubConnectionEntry,
  type UserGitHubConnectionMutation,
  type UserGitHubRefreshMutation,
} from "./user-github-connections.types.js";
import type { UserGitHubConnectionWorkerOperations } from "./user-github-connections.worker.js";
import { captureUserProfileAuthorityRead } from "./user-profile-events.js";

export { observeUserGitHubProfileRetirement } from "./user-github-connection-events.js";
export type {
  UserGitHubConnection,
  UserGitHubConnected,
  UserGitHubDevice,
} from "./user-github-connections.types.js";

/** Native compatibility and fixture reader; Gateway effects prepare their worker snapshot. */
export function resolvePersonalGitHubOwner(
  profile: string,
  db = openOpenClawStateDatabase().db,
): string | undefined {
  return resolvePersonalGitHubOwnerInDatabase(profile, db);
}

/** Native compatibility and fixture reader; Gateway effects use receipt-backed preparation. */
export function readUserGitHubConnection(
  owner: string,
  database?: OpenClawStateDatabaseOptions,
): UserGitHubConnection | undefined {
  return readUserGitHubConnectionInDatabase(openOpenClawStateDatabase(database).db, owner);
}

/** Native adapter for the released synchronous personal OAuth service contract. */
export function cancelUserGitHubAuthorizationSync(
  owner: string,
  requestId: string,
  assertCurrent: () => void,
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent();
      return Boolean(cancelUserGitHubAuthorizationInDatabase(db, owner, requestId));
    },
    undefined,
    { operationLabel: "users.github.cancel" },
  );
}

/** Native adapter for the released synchronous personal OAuth service contract. */
export function disconnectUserGitHubConnectionSync(owner: string, assertCurrent: () => void): void {
  assertCurrent();
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent();
      disconnectUserGitHubConnectionInDatabase(db, owner);
    },
    undefined,
    { operationLabel: "users.github.disconnect" },
  );
}

export async function readUserGitHubConnectionAsync(
  owner: string,
): Promise<UserGitHubConnection | undefined> {
  const prepared = await prepareUserGitHubConnection(owner);
  return prepared.read();
}

export async function readCanonicalUserGitHubConnectionAsync(profile: string) {
  const context = captureOpenClawStateReadWorkerContext();
  return await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "userGitHubConnections.readCanonical", input: { profile } }),
    { existingOnly: true },
  );
}

type PreparedUserGitHubConnection = {
  read(): UserGitHubConnection | undefined;
};
type ConnectionRead = {
  databasePath: string;
  owner: string;
  valid: boolean;
  prepared: Promise<PreparedUserGitHubConnection>;
  current?: PreparedUserGitHubConnection;
};
const connectionReads = new Map<string, ConnectionRead>();
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind === "opened") {
    return;
  }
  for (const [key, entry] of connectionReads) {
    if (entry.databasePath === event.path) {
      entry.valid = false;
      connectionReads.delete(key);
    }
  }
});
observeUserGitHubConnectionAuthority(({ databasePath, changedOwners }) => {
  for (const [key, entry] of connectionReads) {
    if (entry.databasePath === databasePath && changedOwners.includes(entry.owner)) {
      entry.valid = false;
      connectionReads.delete(key);
    }
  }
});

/** A synchronous effect check is valid only after its async owner preparation. */
export function readPreparedUserGitHubConnection(owner: string): UserGitHubConnection | undefined {
  const context = captureOpenClawStateReadWorkerContext();
  const entry = connectionReads.get(JSON.stringify([context.admission.identity.key, owner]));
  if (!entry?.current) {
    throw new Error("Personal GitHub connection is not prepared.");
  }
  return entry.current.read();
}

/** Retained effect guards consume the same worker snapshot until its owner publishes a write. */
export async function prepareUserGitHubConnection(
  owner: string,
): Promise<PreparedUserGitHubConnection> {
  const context = captureOpenClawStateReadWorkerContext();
  const key = JSON.stringify([context.admission.identity.key, owner]);
  const existing = connectionReads.get(key);
  if (existing) {
    const prepared = await existing.prepared;
    try {
      prepared.read();
      return prepared;
    } catch {
      existing.valid = false;
      connectionReads.delete(key);
    }
  }
  const entry: ConnectionRead = {
    databasePath: context.admission.databasePath,
    owner,
    valid: true,
    prepared: Promise.resolve({ read: () => undefined }),
  };
  connectionReads.set(key, entry);
  entry.prepared = (async () => {
    const authority = await captureUserProfileAuthorityRead(context.admission);
    const connection = await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "userGitHubConnections.read", input: { owner } }),
      { existingOnly: true },
    );
    const profileIsCurrent = authority.bind(owner);
    const parsed = connection ? parseUserGitHubConnection(JSON.stringify(connection)) : undefined;
    const read = () => {
      context.admission.assertCurrent();
      if (!entry.valid || !profileIsCurrent?.()) {
        throw new Error("Personal GitHub connection changed; prepare it again.");
      }
      return parsed ? structuredClone(parsed) : undefined;
    };
    read();
    entry.current = { read };
    return entry.current;
  })();
  try {
    return await entry.prepared;
  } catch (error) {
    if (connectionReads.get(key) === entry) {
      connectionReads.delete(key);
    }
    throw error;
  }
}

export async function listUserGitHubConnectionsAsync(): Promise<UserGitHubConnectionEntry[]> {
  const context = captureOpenClawStateReadWorkerContext();
  const connections = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "userGitHubConnections.list", input: undefined }),
    { existingOnly: true },
  );
  context.admission.assertCurrent();
  return (connections ?? []).map(({ owner, connection }) => ({
    owner,
    connection: parseUserGitHubConnection(JSON.stringify(connection)),
  }));
}

async function write<Key extends keyof UserGitHubConnectionWorkerOperations>(
  type: Key,
  input: UserGitHubConnectionWorkerOperations[Key]["input"],
  assertCurrent: () => void,
): Promise<UserGitHubConnectionWorkerOperations[Key]["output"]> {
  const context = captureOpenClawStateWorkerContext();
  const captured = structuredClone(input);
  return await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type, input: captured }),
    {
      assertCurrent,
      createAdmission: () => {
        const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
          context.admission.assertCurrent();
          assertCurrent();
          if (_request.stage === "commit" && !isUserGitHubConnectionCommit(_request.facts)) {
            throw new Error("Personal GitHub connection returned invalid commit facts");
          }
          grant();
        });
        observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
          if (!isUserGitHubConnectionCommit(facts)) {
            throw new Error("Personal GitHub connection returned an invalid commit receipt");
          }
          publishUserGitHubConnectionCommit(context.admission.databasePath, facts);
        });
        return { admission, nativeLocations: [context.admission.databasePath] };
      },
    },
  );
}

export async function mutateUserGitHubConnection(
  owner: string,
  mutation: UserGitHubConnectionMutation,
  assertCurrent: () => void,
): Promise<UserGitHubConnection | undefined> {
  const connection = await write(
    "userGitHubConnections.mutate",
    { owner, mutation },
    assertCurrent,
  );
  return connection ? parseUserGitHubConnection(JSON.stringify(connection)) : undefined;
}

/** An exact remote rotation follows profile transfer; its receipt grants no external authority. */
export async function updateUserGitHubRefreshAsync(
  input: UserGitHubRefreshMutation,
  assertCurrent: () => void,
): Promise<boolean> {
  return await write("userGitHubConnections.refresh", input, assertCurrent);
}
