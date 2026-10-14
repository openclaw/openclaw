import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import type { UserGitHubConnectionCommit } from "./user-github-connections.types.js";
import type { ProfileDisplayRow, UserProfileEmailBinding } from "./user-profiles.types.js";

export type UserProfileMutationChanges = {
  profiles: string[];
  identities: string[];
  channels: string[];
};
export type UserProfileEmailBindingChange = {
  email: string;
  before: UserProfileEmailBinding | null;
  after: UserProfileEmailBinding | null;
};
export type UserProfileMutationPublication = {
  kind: "user-profile-mutation";
  sequence: number;
  changes: UserProfileMutationChanges;
  before: Array<[string, ProfileDisplayRow | undefined]>;
  after: Array<[string, ProfileDisplayRow | undefined]>;
  emailBindings: UserProfileEmailBindingChange[];
  githubConnections?: UserGitHubConnectionCommit;
};
export type UserProfileMutationContext = {
  runTransaction<T>(db: EngineConnection, operation: () => T): T;
  before(db: EngineConnection, ...profileIds: string[]): void;
  authority(...profileIds: string[]): void;
  identity(...profileIds: string[]): void;
  publish(...profileIds: string[]): void;
  publishGitHubConnections?(receipt: UserGitHubConnectionCommit): void;
};
export type UserProfileMutationOptions = OpenClawStateDatabaseOptions & {
  mutation?: UserProfileMutationContext;
};

/** Worker-only admission augments the existing transaction; native one-shots keep its kernel. */
export function runUserProfileWriteTransaction<T>(
  operation: Parameters<typeof runOpenClawStateWriteTransaction<T>>[0],
  options: UserProfileMutationOptions,
  transactionOptions?: Parameters<typeof runOpenClawStateWriteTransaction<T>>[2],
): T {
  return runOpenClawStateWriteTransaction(
    (database) =>
      options.mutation
        ? options.mutation.runTransaction(database.db, () => operation(database))
        : operation(database),
    options,
    transactionOptions,
  );
}

export function isUserProfileMutationPublication(
  value: unknown,
): value is UserProfileMutationPublication {
  // Only the typed profile writer publishes this private admission/commit fact.
  return isRecord(value) && value.kind === "user-profile-mutation";
}
