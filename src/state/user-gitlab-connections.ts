import {
  createSqliteWorkerOperationAdmission,
  observeSqliteWorkerCommittedFacts,
} from "../infra/sqlite-worker-operation-admission.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "./openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import {
  captureOpenClawStateReadWorkerContext,
  captureOpenClawStateWorkerContext,
} from "./openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";
import {
  invalidateUserGitLabConnectionAuthority,
  observeUserGitLabConnectionAuthority,
  publishUserGitLabConnectionCommit,
} from "./user-gitlab-connection-events.js";
import {
  registerUserGitLabConnectionSecrets,
  validateUserGitLabIssuer,
} from "./user-gitlab-connections.kernel.js";
import {
  userGitLabConnectionCommitSchema,
  type UserGitLabConnection,
  type UserGitLabPending,
  type UserGitLabTokens,
} from "./user-gitlab-connections.types.js";
import type { UserGitLabConnectionWorkerOperations } from "./user-gitlab-connections.worker.js";
import { captureUserProfileAuthorityRead } from "./user-profile-events.js";

export type {
  UserGitLabConnection,
  UserGitLabAccount,
  UserGitLabConnected,
  UserGitLabPending,
  UserGitLabTokens,
} from "./user-gitlab-connections.types.js";
export { validateUserGitLabIssuer } from "./user-gitlab-connections.kernel.js";

export class UserGitLabConnectionAuthorityChangedError extends Error {
  constructor() {
    super("My GitLab connection changed; reload its status.");
  }
}

type Prepared = { read: () => UserGitLabConnection | undefined };
type ReadEntry = {
  databasePath: string;
  owner: string;
  issuer: string;
  valid: boolean;
  prepared: Promise<Prepared>;
};
const reads = new Map<string, ReadEntry>();
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind === "opened") {
    return;
  }
  for (const [key, entry] of reads) {
    if (entry.databasePath === event.path) {
      entry.valid = false;
      reads.delete(key);
    }
  }
});
observeUserGitLabConnectionAuthority(({ databasePath, changed }) => {
  for (const [key, entry] of reads) {
    if (
      entry.databasePath === databasePath &&
      changed.some((item) => item.owner === entry.owner && item.issuer === entry.issuer)
    ) {
      entry.valid = false;
      reads.delete(key);
    }
  }
});

export async function prepareUserGitLabConnection(
  owner: string,
  issuer: string,
): Promise<Prepared> {
  validateUserGitLabIssuer(issuer);
  const context = captureOpenClawStateReadWorkerContext();
  const key = JSON.stringify([context.admission.identity.key, owner, issuer]);
  const existing = reads.get(key);
  if (existing) {
    const prepared = await existing.prepared;
    try {
      prepared.read();
      return prepared;
    } catch {
      existing.valid = false;
      reads.delete(key);
    }
  }
  const entry: ReadEntry = {
    databasePath: context.admission.databasePath,
    owner,
    issuer,
    valid: true,
    prepared: Promise.resolve({ read: () => undefined }),
  };
  reads.set(key, entry);
  entry.prepared = (async () => {
    const authority = await captureUserProfileAuthorityRead(context.admission);
    const result = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      { type: "userGitLabConnections.read", input: { owner, issuer } },
      { current: true, context },
    );
    const currentOwner = authority.bind(owner);
    const record = result?.connection
      ? registerUserGitLabConnectionSecrets(result.connection)
      : undefined;
    const read = () => {
      context.admission.assertCurrent();
      if (!entry.valid || !currentOwner?.()) {
        throw new UserGitLabConnectionAuthorityChangedError();
      }
      return record ? structuredClone(record) : undefined;
    };
    read();
    return { read };
  })();
  try {
    return await entry.prepared;
  } catch (error) {
    if (reads.get(key) === entry) {
      reads.delete(key);
    }
    throw error;
  }
}

export async function readUserGitLabConnectionAsync(
  owner: string,
  issuer: string,
): Promise<UserGitLabConnection | undefined> {
  return (await prepareUserGitLabConnection(owner, issuer)).read();
}

async function write<Key extends keyof UserGitLabConnectionWorkerOperations>(
  type: Key,
  input: UserGitLabConnectionWorkerOperations[Key]["input"],
  assertCurrent?: () => void,
): Promise<UserGitLabConnectionWorkerOperations[Key]["output"]> {
  const context = captureOpenClawStateWorkerContext();
  const captured = structuredClone(input);
  const affected = [{ owner: captured.owner, issuer: captured.issuer }];
  try {
    return await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type, input: captured }),
      {
        assertCurrent,
        createAdmission: () => {
          const admission = createSqliteWorkerOperationAdmission((request, grant) => {
            context.admission.assertCurrent();
            // Settlement after remote refresh does not depend on caller authority.
            if (type !== "userGitLabConnections.settleRefresh") {
              assertCurrent?.();
            }
            if (
              request.stage === "commit" &&
              !userGitLabConnectionCommitSchema.safeParse(request.facts).success
            ) {
              throw new Error("Personal GitLab connection returned invalid commit facts");
            }
            grant();
          });
          observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
            const receipt = userGitLabConnectionCommitSchema.parse(facts);
            publishUserGitLabConnectionCommit(context.admission.databasePath, receipt);
          });
          return { admission, nativeLocations: [context.admission.databasePath] };
        },
      },
    );
  } catch (error) {
    invalidateUserGitLabConnectionAuthority(context.admission.databasePath, affected);
    throw error;
  }
}

export async function replaceUserGitLabConnection(
  owner: string,
  issuer: string,
  expectedGeneration: string | undefined,
  next: UserGitLabConnection,
  assertCurrent: () => void,
): Promise<UserGitLabConnection> {
  return registerUserGitLabConnectionSecrets(
    await write(
      "userGitLabConnections.replace",
      { owner, issuer, expectedGeneration, next },
      assertCurrent,
    ),
  );
}
export async function claimUserGitLabAuthorization(
  owner: string,
  issuer: string,
  generation: string,
  requestId: string,
  state: string,
  assertCurrent: () => void,
): Promise<UserGitLabPending> {
  const pending = await write(
    "userGitLabConnections.claimPending",
    { owner, issuer, generation, requestId, state, nowMs: Date.now() },
    assertCurrent,
  );
  registerSecretValueForRedaction(pending.state);
  registerSecretValueForRedaction(pending.verifier);
  return pending;
}
export async function beginUserGitLabRefresh(
  owner: string,
  issuer: string,
  generation: string,
  operationId: string,
  assertCurrent: () => void,
): Promise<UserGitLabConnection> {
  return registerUserGitLabConnectionSecrets(
    await write(
      "userGitLabConnections.beginRefresh",
      { owner, issuer, generation, operationId },
      assertCurrent,
    ),
  );
}
export async function settleUserGitLabRefresh(
  owner: string,
  issuer: string,
  operationId: string,
  result:
    | { kind: "rotated"; tokens: UserGitLabTokens }
    | { kind: "failed"; failure: "failed" | "expired" },
): Promise<boolean> {
  if (result.kind === "rotated") {
    registerSecretValueForRedaction(result.tokens.accessToken);
    registerSecretValueForRedaction(result.tokens.refreshToken);
  }
  return write("userGitLabConnections.settleRefresh", { owner, issuer, operationId, result });
}
export async function disconnectUserGitLabConnection(
  owner: string,
  issuer: string,
  expectedGeneration: string | undefined,
  assertCurrent: () => void,
): Promise<UserGitLabConnection> {
  return write(
    "userGitLabConnections.disconnect",
    { owner, issuer, expectedGeneration },
    assertCurrent,
  );
}
