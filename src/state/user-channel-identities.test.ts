import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  linkUserChannelIdentity,
  resolveUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "./user-channel-identities.js";
import {
  changeCanonicalUserChannelIdentity,
  listCanonicalUserChannelIdentities,
  prepareUserChannelIdentityAuthority,
  prepareUserProfileRoleAuthority,
  prepareUserProfileSelectionAuthority,
} from "./user-channel-identity-operations.js";
import { readUserProfileAliasRevision } from "./user-profile-events.js";
import {
  getUserProfileDisplay,
  readUserProfileIdentity,
  retainUserProfileCatalog,
} from "./user-profile-list.js";
import {
  linkCanonicalUserProfileEmail,
  setCanonicalUserProfileRole,
} from "./user-profile-writes.js";
import { userProfilesDb } from "./user-profiles-internal.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
  linkEmail,
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "./user-profiles.js";
import type { UserChannelIdentity } from "./user-profiles.types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});
const identity: UserChannelIdentity = {
  channelId: "discord",
  accountId: "team-bot",
  senderId: "100000000000000001",
};
function stateOptions() {
  return { path: join(tempDirs.make("openclaw-channel-identities-"), "state.sqlite") };
}

it("does not create state or identity tables while resolving absent links", async () => {
  const options = stateOptions();
  expect(await prepareUserChannelIdentityAuthority(identity, options)).toBeUndefined();
  expect(await listCanonicalUserChannelIdentities("absent", options)).toEqual([]);
  expect(resolveUserChannelIdentity(identity, options)).toBeUndefined();
  expect(existsSync(options.path)).toBe(false);
  const { db } = openOpenClawStateDatabase(options);
  expect(resolveUserChannelIdentity(identity, options)).toBeUndefined();
  expect(await listCanonicalUserChannelIdentities("absent", options)).toEqual([]);
  expect(tableExists(db, "user_profiles")).toBe(false);
  expect(tableExists(db, "user_profile_identities")).toBe(false);
});

it("keeps prepared authority SQL-free and revokes the exact binding before worker commit acknowledgement", async () => {
  const options = stateOptions();
  const otherOptions = stateOptions();
  const ada = ensureProfileForEmail("ada@example.test", options);
  const grace = ensureProfileForEmail("grace@example.test", options);
  const other = ensureProfileForEmail("other@example.test", otherOptions);
  setUserProfileRole(ada.id, "admin", options);
  linkUserChannelIdentity(ada.id, identity, options);
  const prepared = await prepareUserChannelIdentityAuthority(identity, options);
  expect(prepared?.linked.profileId).toBe(ada.id);
  const { db } = openOpenClawStateDatabase(options);
  const releaseCatalog = retainUserProfileCatalog(options);
  const queries = vi.spyOn(db, "prepare");
  try {
    expect(prepared?.isCurrent()).toBe(true);
    expect(queries).not.toHaveBeenCalled();
    setDisplayName(ada.id, "Updated name", options);
    setUserProfileRole(ada.id, "admin", options);
    setUserProfileRole(grace.id, "admin", options);
    setUserProfileRole(other.id, "admin", otherOptions);
    linkUserChannelIdentity(ada.id, { ...identity, accountId: "other-bot" }, options);
    queries.mockClear();
    expect(prepared?.isCurrent()).toBe(true);
    expect(queries).not.toHaveBeenCalled();
    await changeCanonicalUserChannelIdentity("link", ada.id, identity, options);
    expect(prepared?.isCurrent()).toBe(true);
    const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
    let observedCommitGrant = false;
    const admissionSpy = vi
      .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit) =>
        createAdmission((request, grant) => {
          admit(request, () => {
            if (request.stage === "commit") {
              observedCommitGrant = true;
              // This executes before the worker receives permission to COMMIT.
              expect(prepared?.isCurrent()).toBe(false);
            }
            return grant();
          });
        }),
      );
    try {
      await changeCanonicalUserChannelIdentity("unlink", ada.id, identity, options);
      expect(observedCommitGrant).toBe(true);
    } finally {
      admissionSpy.mockRestore();
    }
    await changeCanonicalUserChannelIdentity("link", ada.id, identity, options);
    expect(prepared?.isCurrent()).toBe(false);
    const renewed = await prepareUserChannelIdentityAuthority(identity, options);
    expect(renewed?.isCurrent()).toBe(true);
    setUserProfileRole(ada.id, "member", options);
    setUserProfileRole(ada.id, "admin", options);
    expect(renewed?.isCurrent()).toBe(false);

    const admin = await prepareUserProfileRoleAuthority(ada.id, options);
    const selectedSource = await prepareUserProfileSelectionAuthority(ada.id, options);
    const selectedTarget = await prepareUserProfileSelectionAuthority(grace.id, options);
    expect(admin?.role).toBe("admin");
    expect(selectedSource?.isCurrent()).toBe(true);
    expect(selectedTarget?.isCurrent()).toBe(true);
    let mutation: "demote" | "reject" | "rollback" | "recover" | "merge" = "demote";
    let actorCurrent = true;
    let rejectedBeforeAdmission = false;
    let rollbackGranted = false;
    let pendingRole: ReturnType<typeof prepareUserProfileRoleAuthority> | undefined;
    let pendingSelection: ReturnType<typeof prepareUserProfileSelectionAuthority> | undefined;
    const mutationAdmissionSpy = vi
      .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit" && mutation === "reject") {
            actorCurrent = false;
            rejectedBeforeAdmission = true;
          }
          admit(request, () => {
            if (request.stage === "commit" && mutation === "rollback") {
              rollbackGranted = true;
            } else if (request.stage === "commit" && mutation === "demote") {
              queries.mockClear();
              expect(admin?.isCurrent()).toBe(false);
              expect(selectedSource?.isCurrent()).toBe(true);
              expect(queries).not.toHaveBeenCalled();
              pendingRole = prepareUserProfileRoleAuthority(ada.id, options);
              void pendingRole.catch(() => undefined);
            } else if (request.stage === "commit" && mutation === "merge") {
              queries.mockClear();
              expect(selectedSource?.isCurrent()).toBe(false);
              expect(selectedTarget?.isCurrent()).toBe(true);
              expect(queries).not.toHaveBeenCalled();
              pendingSelection = prepareUserProfileSelectionAuthority(ada.id, options);
              void pendingSelection.catch(() => undefined);
            }
            return grant();
          });
        }),
      );
    try {
      await expect(
        setCanonicalUserProfileRole(ada.id, "member", {
          ...options,
          assertCurrent: () => {
            if (!admin?.isCurrent()) {
              throw new Error("Administrative authority was revoked");
            }
          },
        }),
      ).resolves.toMatchObject({ id: ada.id, role: "member" });
      expect(admin?.isCurrent()).toBe(false);
      expect(selectedSource?.isCurrent()).toBe(true);
      expect(pendingRole).toBeDefined();
      await expect(pendingRole).resolves.toMatchObject({ profileId: ada.id, role: "member" });

      setUserProfileRole(ada.id, "admin", options);
      mutation = "reject";
      await expect(
        setCanonicalUserProfileRole(ada.id, "member", {
          ...options,
          assertCurrent: () => {
            if (!actorCurrent) {
              throw new Error("Original actor was revoked");
            }
          },
        }),
      ).rejects.toThrow("Original actor was revoked");
      expect(rejectedBeforeAdmission).toBe(true);
      expect((await prepareUserProfileRoleAuthority(ada.id, options))?.role).toBe("admin");

      mutation = "rollback";
      const beforeRollback = getUserProfileDisplay(ada.id, options);
      runOpenClawStateWriteTransaction(({ db: fixtureDb }) => {
        // Deferred integrity failure occurs at real COMMIT, after the worker receives its grant.
        fixtureDb.exec(`
          CREATE TABLE profile_rollback_parent (id INTEGER PRIMARY KEY);
          CREATE TABLE profile_rollback_child (
            parent_id INTEGER REFERENCES profile_rollback_parent(id) DEFERRABLE INITIALLY DEFERRED
          );
          CREATE TRIGGER profile_rollback_at_commit AFTER UPDATE OF role ON user_profiles
          WHEN NEW.role = 'member'
          BEGIN INSERT INTO profile_rollback_child VALUES (1); END;
        `);
      }, options);
      try {
        await expect(setCanonicalUserProfileRole(ada.id, "member", options)).rejects.toThrow(
          /FOREIGN KEY constraint failed/i,
        );
        expect(rollbackGranted).toBe(true);
        expect(resolveUserChannelIdentity(identity, options)?.role).toBe("admin");
        queries.mockClear();
        expect(readUserProfileIdentity(ada.id, options)?.role).toBe("admin");
        expect(getUserProfileDisplay(ada.id, options)).toEqual(beforeRollback);
        expect(queries).not.toHaveBeenCalled();
        const afterRollback = await prepareUserProfileRoleAuthority(ada.id, options);
        expect(afterRollback?.role).toBe("admin");
        expect(afterRollback?.isCurrent()).toBe(true);
      } finally {
        runOpenClawStateWriteTransaction(({ db: fixtureDb }) => {
          fixtureDb.exec(
            "DROP TRIGGER profile_rollback_at_commit; DROP TABLE profile_rollback_child; DROP TABLE profile_rollback_parent;",
          );
        }, options);
      }
      mutation = "recover";
      await expect(setCanonicalUserProfileRole(ada.id, "member", options)).resolves.toMatchObject({
        id: ada.id,
        role: "member",
      });

      mutation = "merge";
      const linked = await linkCanonicalUserProfileEmail("ada@example.test", grace.id, options);
      expect(selectedSource?.isCurrent()).toBe(false);
      expect(selectedTarget?.isCurrent()).toBe(true);
      expect(pendingSelection).toBeDefined();
      await expect(pendingSelection).resolves.toMatchObject({ profileId: grace.id });
      expect(linked.profile.id).toBe(grace.id);
      expect(linked.display.id).toBe(linked.profile.id);
      expect(getUserProfileDisplay(ada.id, options)).toEqual(linked.display);
      expect(getUserProfileDisplay(grace.id, options)).toEqual(linked.display);
    } finally {
      mutationAdmissionSpy.mockRestore();
      await Promise.allSettled([pendingRole, pendingSelection]);
    }
    const latest = await prepareUserChannelIdentityAuthority(identity, options);
    await closeOpenClawStateDatabaseAsync();
    expect(latest?.isCurrent()).toBe(false);
  } finally {
    queries.mockRestore();
    releaseCatalog();
  }
});

it("keeps stable senders scoped to the channel account and refuses conflicting assignments", async () => {
  const options = stateOptions();
  const ada = ensureProfileForEmail("ada@example.test", options);
  const grace = ensureProfileForEmail("grace@example.test", options);
  const link = { profileId: ada.id, identity };
  expect(linkUserChannelIdentity(ada.id, identity, options)).toEqual(link);
  expect(linkUserChannelIdentity(ada.id, identity, options)).toEqual(link);
  await closeOpenClawStateDatabaseAsync();
  expect(resolveUserChannelIdentity(identity, options)?.profileId).toBe(ada.id);
  expect(await listCanonicalUserChannelIdentities(ada.id, options)).toEqual([link]);
  expect(() => linkUserChannelIdentity(grace.id, identity, options)).toThrow(
    "linked to another profile",
  );
  expect(() => unlinkUserChannelIdentity(grace.id, identity, options)).toThrow(
    "linked to another profile",
  );
  for (const other of [
    { ...identity, accountId: "personal-bot" },
    { ...identity, channelId: "another-channel" },
  ]) {
    expect(resolveUserChannelIdentity(other, options)).toBeUndefined();
    linkUserChannelIdentity(grace.id, other, options);
    expect(resolveUserChannelIdentity(other, options)?.profileId).toBe(grace.id);
  }
  expect(resolveUserChannelIdentity(identity, options)?.profileId).toBe(ada.id);
  expect(unlinkUserChannelIdentity(ada.id, identity, options)).toBe(true);
  expect(unlinkUserChannelIdentity(ada.id, identity, options)).toBe(false);
  expect(resolveUserChannelIdentity(identity, options)).toBeUndefined();
});

it("reads current roles and only canonical login identities, including the current verified GitHub login", () => {
  const options = stateOptions();
  const passkey = ensureProfileForTailscaleIdentity({ login: "ada@passkey" }, options);
  linkEmail("ada@example.test", passkey.id, options);
  const profile = syncGitHubIdentity(
    {
      identity: { accountId: 123, login: "old-login" },
      authenticationAlias: { kind: "email", email: "ada@example.test" },
    },
    options,
  );
  linkUserChannelIdentity(profile.id, identity, options);
  setUserProfileRole(profile.id, "admin", options);
  const { db } = openOpenClawStateDatabase(options);
  executeSqliteQuerySync(
    db,
    userProfilesDb(db).insertInto("user_profile_emails").values({
      email: "old-login@github",
      profile_id: profile.id,
      created_at: 1,
    }),
  );
  executeSqliteQuerySync(
    db,
    userProfilesDb(db)
      .insertInto("user_profile_identities")
      .values([
        {
          provider: "github-attribution",
          subject: "123",
          profile_id: profile.id,
          canonical_login: "retired-login",
          created_at: 1,
        },
        {
          provider: "github-attribution",
          subject: "456",
          profile_id: profile.id,
          canonical_login: null,
          created_at: 1,
        },
      ]),
  );
  syncGitHubIdentity(
    {
      identity: { accountId: 123, login: "new-login" },
      authenticationAlias: { kind: "github-login", login: "new-login" },
    },
    options,
  );
  expect(resolveUserChannelIdentity(identity, options)).toEqual({
    profileId: profile.id,
    role: "admin",
    emails: ["ada@example.test", "old-login@github"],
    loginIdentities: ["ada@example.test", "ada@passkey", "new-login@github"],
  });
  setUserProfileRole(profile.id, "member", options);
  expect(resolveUserChannelIdentity(identity, options)?.role).toBe("member");
  syncGitHubIdentity(
    {
      identity: { accountId: 789, login: "new-person" },
      authenticationAlias: { kind: "email", email: "ada@example.test" },
    },
    options,
  );
  expect(resolveUserChannelIdentity(identity, options)).toEqual({
    profileId: profile.id,
    role: "member",
    emails: ["old-login@github"],
    loginIdentities: ["ada@passkey", "new-login@github"],
  });
});

it("moves links through explicit profile merges and uses the surviving person's role and aliases", async () => {
  const options = stateOptions();
  const source = ensureProfileForEmail("source@example.test", options);
  const target = ensureProfileForEmail("target@example.test", options);
  setUserProfileRole(source.id, "admin", options);
  setUserProfileRole(target.id, "member", options);
  linkUserChannelIdentity(source.id, identity, options);
  linkEmail("source@example.test", target.id, options);
  expect(resolveUserChannelIdentity(identity, options)).toEqual({
    profileId: target.id,
    role: "member",
    emails: ["source@example.test", "target@example.test"],
    loginIdentities: ["source@example.test", "target@example.test"],
  });
  expect(await listCanonicalUserChannelIdentities(source.id, options)).toEqual([
    { profileId: target.id, identity },
  ]);
  expect(unlinkUserChannelIdentity(source.id, identity, options)).toBe(true);
  expect(resolveUserChannelIdentity(identity, options)).toBeUndefined();
});

it("publishes link and unlink authority changes only after their transaction commits", () => {
  const options = stateOptions();
  const profile = ensureProfileForEmail("ada@example.test", options);
  const revision = readUserProfileAliasRevision();
  expect(() =>
    runOpenClawStateWriteTransaction(() => {
      linkUserChannelIdentity(profile.id, identity, options);
      expect(readUserProfileAliasRevision()).toBe(revision);
      throw new Error("rollback");
    }, options),
  ).toThrow("rollback");
  expect(readUserProfileAliasRevision()).toBe(revision);
  expect(resolveUserChannelIdentity(identity, options)).toBeUndefined();
  linkUserChannelIdentity(profile.id, identity, options);
  expect(readUserProfileAliasRevision()).toBe(revision + 1);
  linkUserChannelIdentity(profile.id, identity, options);
  expect(readUserProfileAliasRevision()).toBe(revision + 1);
  expect(() =>
    runOpenClawStateWriteTransaction(() => {
      unlinkUserChannelIdentity(profile.id, identity, options);
      throw new Error("rollback");
    }, options),
  ).toThrow("rollback");
  expect(readUserProfileAliasRevision()).toBe(revision + 1);
  expect(resolveUserChannelIdentity(identity, options)?.profileId).toBe(profile.id);
  unlinkUserChannelIdentity(profile.id, identity, options);
  expect(readUserProfileAliasRevision()).toBe(revision + 2);
});

it("rejects the shared owner and malformed identities without linking a person", async () => {
  const options = stateOptions();
  const owner = ensureGatewayOwnerProfile("Owner", options);
  const profile = ensureProfileForEmail("ada@example.test", options);
  expect(() => linkUserChannelIdentity(owner.id, identity, options)).toThrow("shared owner");
  expect(() => linkUserChannelIdentity("missing", identity, options)).toThrow(
    "user profile not found",
  );
  for (const senderId of ["", " trimmed ", "x".repeat(513)]) {
    expect(() => linkUserChannelIdentity(profile.id, { ...identity, senderId }, options)).toThrow(
      "invalid channel identity",
    );
  }
  expect(await listCanonicalUserChannelIdentities(profile.id, options)).toEqual([]);
});
