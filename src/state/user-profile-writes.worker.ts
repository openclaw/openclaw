import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { projectUserProfileDisplay } from "./user-profile-list.js";
import type {
  UserProfileMutationContext,
  UserProfileMutationPublication,
} from "./user-profile-mutation.js";
import {
  selectProfileDisplayEntries,
  requireResolvedUserProfileMetadataById,
} from "./user-profiles-internal.js";
import { UserProfileNotFoundError, UserProfileOwnerError } from "./user-profiles-schema.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
  linkEmail,
  setUserProfileRole,
  syncGitHubIdentity,
} from "./user-profiles.js";
import type { ProfileDisplayRow } from "./user-profiles.types.js";

export type UserProfileWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "not-found"; profileId: string }
  | { ok: false; kind: "owner"; code: UserProfileOwnerError["code"] };
export type UserProfileWriteOperations = {
  "userProfiles.setRole": {
    input: { profileId: string; role: string | null };
    output: UserProfileWriteResult<ReturnType<typeof setUserProfileRole>>;
  };
  "userProfiles.linkEmail": {
    input: { email: string; targetProfileId: string };
    output: UserProfileWriteResult<{
      profile: ReturnType<typeof linkEmail>;
      display: ReturnType<typeof projectUserProfileDisplay>;
    }>;
  };
  "userProfiles.ensureEmail": {
    input: { email: string };
    output: UserProfileWriteResult<ReturnType<typeof ensureProfileForEmail>>;
  };
  "userProfiles.ensureTailscale": {
    input: Parameters<typeof ensureProfileForTailscaleIdentity>[0];
    output: UserProfileWriteResult<ReturnType<typeof ensureProfileForTailscaleIdentity>>;
  };
  "userProfiles.syncGitHub": {
    input: Parameters<typeof syncGitHubIdentity>[0];
    output: UserProfileWriteResult<ReturnType<typeof syncGitHubIdentity>>;
  };
  "userProfiles.ensureOwner": {
    input: { displayName: string | null };
    output: UserProfileWriteResult<ReturnType<typeof ensureGatewayOwnerProfile>>;
  };
};
export function isUserProfileWriteCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<UserProfileWriteOperations> {
  return (
    command.type === "userProfiles.setRole" ||
    command.type === "userProfiles.linkEmail" ||
    command.type === "userProfiles.ensureEmail" ||
    command.type === "userProfiles.ensureTailscale" ||
    command.type === "userProfiles.syncGitHub" ||
    command.type === "userProfiles.ensureOwner"
  );
}

type PendingPublication = {
  before: Map<string, ProfileDisplayRow | undefined>;
  display: Set<string>;
  profiles: Set<string>;
  identities: Set<string>;
};

export function executeUserProfileWrite(
  command: SqliteWorkerCommand<UserProfileWriteOperations>,
  options: OpenClawStateDatabaseOptions,
): UserProfileWriteOperations[keyof UserProfileWriteOperations]["output"] {
  let pending: PendingPublication | undefined;
  let sequence = 0;
  const committed: UserProfileMutationPublication[] = [];
  let linkedDisplay: ReturnType<typeof projectUserProfileDisplay> | undefined;
  const mutation: UserProfileMutationContext = {
    runTransaction(db, operation) {
      if (pending) {
        return operation();
      }
      const current: PendingPublication = {
        before: new Map(),
        display: new Set(),
        profiles: new Set(),
        identities: new Set(),
      };
      pending = current;
      try {
        requestSqliteWorkerOperationAdmission({
          stage: "transaction",
          facts: { kind: "user-profile-write", operation: command.type },
        });
        const value = operation();
        if (command.type === "userProfiles.linkEmail") {
          const linked = requireResolvedUserProfileMetadataById(db, command.input.targetProfileId);
          const row = selectProfileDisplayEntries(db, [linked.id])[0]?.[1];
          if (!row) {
            throw new UserProfileNotFoundError(linked.id);
          }
          linkedDisplay = projectUserProfileDisplay(row);
        }
        const ids = [...current.display];
        const after = new Map(ids.length ? selectProfileDisplayEntries(db, ids) : []);
        const publication: UserProfileMutationPublication = {
          kind: "user-profile-mutation",
          sequence: ++sequence,
          changes: {
            profiles: [...current.profiles],
            identities: [...current.identities],
            channels: [],
          },
          before: ids.map((id) => {
            if (!current.before.has(id)) {
              throw new Error("Profile publication requires its transaction's original row");
            }
            return [id, current.before.get(id)];
          }),
          after: ids.map((id) => [id, after.get(id)]),
        };
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: publication });
        deferSqlitePostCommitPublication(db, () => committed.push(publication));
        deferSqliteWorkerCommitReceipt(db, {
          kind: "user-profile-commits",
          publications: [...committed, publication],
        });
        return value;
      } finally {
        pending = undefined;
      }
    },
    before(db, ...ids) {
      const current = pending;
      if (!current) {
        throw new Error("Profile mutation requires its original transaction");
      }
      const missing = ids.filter((id) => !current.before.has(id));
      const rows = new Map(missing.length ? selectProfileDisplayEntries(db, missing) : []);
      for (const id of missing) {
        current.before.set(id, rows.get(id));
      }
    },
    authority: (...ids) => ids.forEach((id) => pending?.profiles.add(id)),
    identity: (...ids) => ids.forEach((id) => pending?.identities.add(id)),
    publish: (...ids) => ids.forEach((id) => pending?.display.add(id)),
  };
  const owned = { ...options, mutation };
  try {
    switch (command.type) {
      case "userProfiles.setRole":
        return {
          ok: true,
          value: setUserProfileRole(command.input.profileId, command.input.role, owned),
        };
      case "userProfiles.linkEmail": {
        const profile = linkEmail(command.input.email, command.input.targetProfileId, owned);
        if (!linkedDisplay) {
          throw new Error("Linked profile publication is unavailable");
        }
        return { ok: true, value: { profile, display: linkedDisplay } };
      }
      case "userProfiles.ensureEmail":
        return { ok: true, value: ensureProfileForEmail(command.input.email, owned) };
      case "userProfiles.ensureTailscale":
        return { ok: true, value: ensureProfileForTailscaleIdentity(command.input, owned) };
      case "userProfiles.syncGitHub":
        return { ok: true, value: syncGitHubIdentity(command.input, owned) };
      case "userProfiles.ensureOwner":
        return { ok: true, value: ensureGatewayOwnerProfile(command.input.displayName, owned) };
    }
    return command satisfies never;
  } catch (error) {
    if (error instanceof UserProfileNotFoundError) {
      return { ok: false, kind: "not-found", profileId: error.profileId };
    }
    if (error instanceof UserProfileOwnerError) {
      return { ok: false, kind: "owner", code: error.code };
    }
    throw error;
  }
}
