import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
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
};
export type UserProfileMutationContext = {
  runTransaction<T>(db: DatabaseSync, operation: () => T): T;
  before(db: DatabaseSync, ...profileIds: string[]): void;
  authority(...profileIds: string[]): void;
  identity(...profileIds: string[]): void;
  publish(...profileIds: string[]): void;
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

function isDisplayRow(value: unknown): value is ProfileDisplayRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.updated_at === "number" &&
    (value.has_avatar === 0 || value.has_avatar === 1) &&
    ["display_name", "avatar_mime", "avatar_sha256", "merged_into"].every(
      (key) => value[key] === null || typeof value[key] === "string",
    ) &&
    (value.role === undefined || value.role === null || typeof value.role === "string")
  );
}
function isDisplayEntries(value: unknown): value is Array<[string, ProfileDisplayRow | undefined]> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        (entry[1] === undefined || (isDisplayRow(entry[1]) && entry[1].id === entry[0])),
    )
  );
}
function isEmailBinding(value: unknown, email: string): value is UserProfileEmailBinding | null {
  return (
    value === null ||
    (isRecord(value) &&
      value.email === email &&
      typeof value.profileId === "string" &&
      (value.bindingId === null || typeof value.bindingId === "string"))
  );
}
export function isUserProfileMutationPublication(
  value: unknown,
): value is UserProfileMutationPublication {
  return (
    isRecord(value) &&
    value.kind === "user-profile-mutation" &&
    Number.isSafeInteger(value.sequence) &&
    isRecord(value.changes) &&
    [value.changes.profiles, value.changes.identities, value.changes.channels].every(
      (keys) => Array.isArray(keys) && keys.every((key) => typeof key === "string"),
    ) &&
    isDisplayEntries(value.before) &&
    isDisplayEntries(value.after) &&
    Array.isArray(value.emailBindings) &&
    value.emailBindings.every(
      (change) =>
        isRecord(change) &&
        typeof change.email === "string" &&
        isEmailBinding(change.before, change.email) &&
        isEmailBinding(change.after, change.email),
    )
  );
}
