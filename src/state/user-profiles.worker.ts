import { createHash } from "node:crypto";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import { executeUserChannelIdentityChange } from "./user-channel-identities.worker.js";
import { selectStoredGitHubIdentities } from "./user-profile-github-identity.js";
import { listUserProfilesSync } from "./user-profile-identity.read.js";
import {
  executeUserProfileWrite,
  linkEmail,
  mergeProfiles,
  setAvatar,
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "./user-profile-writes.worker.js";
import {
  selectProfileDisplayEntries,
  inspectProfileAvatarInDatabase,
  selectResolvedUserProfileById,
  toUserProfile,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
} from "./user-profiles.js";
import type { ProfileDisplayRow, UserProfileAvatarMime } from "./user-profiles.types.js";
import type { WorkerOperationHandlers, WorkerOperations } from "./worker-operation-registry.js";

const userProfileWriteOperations = {
  "userProfiles.setRole": (
    input: { profileId: string; role: string | null },
    { open, stateOptions },
  ) =>
    executeUserProfileWrite(
      "userProfiles.setRole",
      { ...stateOptions(), database: open() },
      (owned) => setUserProfileRole(input.profileId, input.role, owned),
    ),
  "userProfiles.linkEmail": (
    input: { email: string; targetProfileId: string },
    { open, stateOptions },
  ) =>
    executeUserProfileWrite(
      "userProfiles.linkEmail",
      { ...stateOptions(), database: open() },
      (owned, display) => ({
        profile: linkEmail(input.email, input.targetProfileId, owned),
        display: display(),
      }),
      input.targetProfileId,
    ),
  "userProfiles.merge": (
    input: { sourceProfileId: string; targetProfileId: string },
    { open, stateOptions },
  ) =>
    executeUserProfileWrite(
      "userProfiles.merge",
      { ...stateOptions(), database: open() },
      (owned, display) => ({
        ...mergeProfiles(input.sourceProfileId, input.targetProfileId, owned),
        display: display(),
      }),
      input.targetProfileId,
    ),
  "userProfiles.ensureEmail": (
    input: { email: string; expectedGitHubAccountId?: number },
    { open, stateOptions },
  ) =>
    executeUserProfileWrite(
      "userProfiles.ensureEmail",
      { ...stateOptions(), database: open() },
      (owned) =>
        ensureProfileForEmail(input.email, {
          ...owned,
          expectedGitHubAccountId: input.expectedGitHubAccountId,
        }),
    ),
  "userProfiles.ensureTailscale": (
    input: Parameters<typeof ensureProfileForTailscaleIdentity>[0],
    { open, stateOptions },
  ) =>
    executeUserProfileWrite(
      "userProfiles.ensureTailscale",
      { ...stateOptions(), database: open() },
      (owned) => ensureProfileForTailscaleIdentity(input, owned),
    ),
  "userProfiles.syncGitHub": (
    input: Parameters<typeof syncGitHubIdentity>[0],
    { open, stateOptions },
  ) =>
    executeUserProfileWrite(
      "userProfiles.syncGitHub",
      { ...stateOptions(), database: open() },
      (owned) => syncGitHubIdentity(input, owned),
    ),
  "userProfiles.ensureOwner": (input: { displayName: string | null }, { open, stateOptions }) =>
    executeUserProfileWrite(
      "userProfiles.ensureOwner",
      { ...stateOptions(), database: open() },
      (owned) => ensureGatewayOwnerProfile(input.displayName, owned),
    ),
  "userProfiles.setDisplayName": (
    input: { profileId: string; name: string | null },
    { open, stateOptions },
  ) =>
    executeUserProfileWrite(
      "userProfiles.setDisplayName",
      { ...stateOptions(), database: open() },
      (owned, display) => ({
        profile: setDisplayName(input.profileId, input.name, owned),
        display: display(),
      }),
      input.profileId,
    ),
  "userProfiles.setAvatar": (
    input: { profileId: string; bytes: Uint8Array; mime: string },
    { open, stateOptions },
  ) =>
    executeUserProfileWrite(
      "userProfiles.setAvatar",
      { ...stateOptions(), database: open() },
      (owned, display) => {
        const result = setAvatar(input.profileId, input.bytes, input.mime, owned);
        return result.ok
          ? { ok: true as const, value: { profile: result.value, display: display() } }
          : result;
      },
      input.profileId,
    ),
} satisfies WorkerOperationHandlers;

export type UserProfileWriteOperations = WorkerOperations<typeof userProfileWriteOperations>;

export const userProfileOperations = {
  ...userProfileWriteOperations,
  "userProfiles.list": (_input: undefined, { open, stateOptions }) =>
    listUserProfilesSync({ ...stateOptions(), database: open() }),
  "userProfiles.directory": ({ limit }: { limit: number }, { open, stateOptions }) => {
    const database = open();
    ensureUserProfilesSchema(stateOptions(), database);
    return runSqliteDeferredTransactionSync(
      database.db,
      () => {
        const profiles = executeSqliteQuerySync(
          database.db,
          userProfilesDb(database.db)
            .selectFrom("user_profiles")
            .select("id")
            .where("merged_into", "is", null)
            .orderBy("created_at", "asc")
            .orderBy("id", "asc")
            .limit(limit + 1),
        ).rows;
        const selected = profiles.slice(0, limit);
        const identities = selectStoredGitHubIdentities(
          database.db,
          selected.map(({ id }) => id),
        );
        return {
          profiles: selected.map(({ id }) => ({
            id,
            logins: identities.get(id)?.accounts.map((account) => account.login) ?? [],
          })),
          truncated: profiles.length > limit,
        };
      },
      { databaseLabel: database.path, operationLabel: "user-profiles.directory" },
    );
  },
  "userProfiles.channelIdentity.change": (
    input: Parameters<typeof executeUserChannelIdentityChange>[0],
    { open, stateOptions },
  ) => executeUserChannelIdentityChange(input, { ...stateOptions(), database: open() }),
  "userProfiles.avatar.inspect": ({ profileId }: { profileId: string }, { open }) =>
    inspectProfileAvatarInDatabase(open().db, profileId),
  "userProfiles.avatar.adopt": (
    input: { profileId: string; bytes: Uint8Array; mime: UserProfileAvatarMime; now: number },
    { open, stateOptions },
  ): { profile: ReturnType<typeof toUserProfile> | undefined; committed?: ProfileDisplayRow } => {
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const profile = selectResolvedUserProfileById(db, input.profileId);
        if (!profile) {
          return { profile: undefined };
        }
        if (profile.avatar !== null) {
          return { profile: toUserProfile(profile) };
        }
        const before = selectProfileDisplayEntries(db, [profile.id])[0]![1];
        requestSqliteWorkerOperationAdmission({
          stage: "transaction",
          facts: { kind: "profile-avatar", before },
        });
        executeSqliteQuerySync(
          db,
          userProfilesDb(db)
            .updateTable("user_profiles")
            .set({
              avatar: input.bytes,
              avatar_mime: input.mime,
              avatar_sha256: sha256,
              updated_at: input.now,
            })
            .where("id", "=", profile.id),
        );
        const committed = selectProfileDisplayEntries(db, [profile.id])[0]![1];
        return {
          profile: toUserProfile({ ...profile, avatar_mime: input.mime, updated_at: input.now }),
          committed,
        };
      },
      { ...stateOptions(), database: open() },
      { operationLabel: "user-profiles.adopt-avatar" },
    );
  },
} satisfies WorkerOperationHandlers;

export type UserProfileWorkerOperations = WorkerOperations<typeof userProfileOperations>;
