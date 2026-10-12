import { normalizeDatabasePath } from "../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  observeSqliteWorkerCommittedFacts,
} from "../infra/sqlite-worker-operation-admission.js";
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

export { observeUserGitHubProfileRetirement } from "./user-github-connection-events.js";
export type {
  UserGitHubConnection,
  UserGitHubConnected,
  UserGitHubDevice,
} from "./user-github-connections.types.js";

const connectionAuthorities = new Map<string, Map<string, { current: boolean }>>();
observeUserGitHubConnectionAuthority(({ databasePath, changedOwners }) => {
  const authorities = connectionAuthorities.get(databasePath);
  if (!authorities) {
    return;
  }
  for (const owner of changedOwners) {
    const authority = authorities.get(owner);
    if (authority) {
      authority.current = false;
      authorities.delete(owner);
    }
  }
});

/** Worker facts retain live credential authority through in-process write receipts. */
export async function prepareUserGitHubConnection(owner: string) {
  const context = captureOpenClawStateReadWorkerContext();
  const databasePath = normalizeDatabasePath(context.admission.databasePath);
  let authorities = connectionAuthorities.get(databasePath);
  if (!authorities) {
    authorities = new Map();
    connectionAuthorities.set(databasePath, authorities);
  }
  let authority = authorities.get(owner);
  if (!authority) {
    authority = { current: true };
    authorities.set(owner, authority);
  }
  const capturedAuthority = authority;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    if (!capturedAuthority.current) {
      throw new Error("My GitHub connection changed; reload its status.");
    }
  };
  const connection = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "userGitHubConnections.read", input: { owner } }),
    { existingOnly: true },
  );
  assertCurrent();
  return {
    connection: connection ? parseUserGitHubConnection(JSON.stringify(connection)) : undefined,
    assertCurrent,
  };
}

export async function resolvePersonalGitHubOwnerAsync(profile: string) {
  const context = captureOpenClawStateReadWorkerContext();
  const resolved = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "userGitHubConnections.resolveOwner", input: { profile } }),
    { existingOnly: true },
  );
  context.admission.assertCurrent();
  return resolved;
}

/** Native final-effect guard; preparation uses the shared-state worker. */
export function resolvePersonalGitHubOwner(
  profile: string,
  db = openOpenClawStateDatabase().db,
): string | undefined {
  return resolvePersonalGitHubOwnerInDatabase(profile, db);
}

/** Native final-effect guard; never substitute a pre-await connection snapshot. */
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
  const context = captureOpenClawStateReadWorkerContext();
  const connection = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "userGitHubConnections.read", input: { owner } }),
    { existingOnly: true },
  );
  context.admission.assertCurrent();
  return connection ? parseUserGitHubConnection(JSON.stringify(connection)) : undefined;
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
