import { existsSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import * as stateReads from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import {
  linkUserChannelIdentity,
  resolveUserChannelIdentity,
  unlinkUserChannelIdentity,
  userChannelIdentitySubject,
} from "./user-channel-identities.js";
import {
  changeCanonicalUserChannelIdentity,
  listCanonicalUserChannelIdentities,
  prepareUserChannelIdentityAuthority,
  prepareUserProfileRoleAuthority,
  prepareUserProfileRolePolicyAuthority,
  prepareUserProfileSelectionAuthority,
} from "./user-channel-identity-operations.js";
import { readProfileAuthority } from "./user-profile-authority.js";
import {
  captureUserProfileAuthorityRead,
  readUserProfileAliasRevision,
} from "./user-profile-events.js";
import {
  getUserProfileDisplay,
  readResidentUserProfileIdentity,
  prepareUserProfileCatalog,
} from "./user-profile-list.js";
import { prepareCurrentUserProfileAliases } from "./user-profile-reads.js";
import {
  linkCanonicalUserProfileEmail,
  mergeCanonicalUserProfiles,
  setCanonicalUserProfileDisplayName,
  setCanonicalUserProfileRole,
} from "./user-profile-writes.js";
import {
  linkEmail,
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "./user-profile-writes.worker.js";
import { userProfilesDb } from "./user-profiles-internal.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
} from "./user-profiles.js";
import type { UserChannelIdentity } from "./user-profiles.types.js";
import { useUserStateFixture } from "./user-state.test-support.js";

const releases: (() => void)[] = [];
const stateOptions = useUserStateFixture("openclaw-channel-identities-", () => {
  for (const release of releases.splice(0)) {
    release();
  }
});
let options: ReturnType<typeof stateOptions>;
beforeEach(() => {
  options = stateOptions();
});
async function retainCatalog() {
  releases.push((await prepareUserProfileCatalog(options)).release);
}
const prepareRole = (profileId: string, includeProfile = false) =>
  prepareUserProfileRoleAuthority(profileId, { ...options, includeProfile });
const setRole = (profileId: string, role: "admin" | "member", assertCurrent?: () => void) =>
  setCanonicalUserProfileRole(profileId, role, { ...options, assertCurrent });
function requireCurrent(current: boolean | undefined, message: string) {
  if (!current) {
    throw new Error(message);
  }
}

function expectCurrent(expected: boolean, ...guards: ({ isCurrent(): boolean } | undefined)[]) {
  expect(guards.map((guard) => guard?.isCurrent())).toEqual(guards.map(() => expected));
}
const identity: UserChannelIdentity = {
  channelId: "discord",
  accountId: "team-bot",
  senderId: "100000000000000001",
};
it.each(["email binding", "stale role reply"] as const)(
  "keeps revoked authority retired after an ABA change to %s",
  async (change) => {
    const source = ensureProfileForEmail("source@example.test", options);
    if (change === "stale role reply") {
      await setRole(source.id, "admin");
    } else {
      await linkCanonicalUserProfileEmail("retained@example.test", source.id, options);
    }
    await changeCanonicalUserChannelIdentity("link", source.id, identity, options);
    const selection = await prepareUserProfileSelectionAuthority(source.id, options);
    const admin = await prepareRole(source.id);
    const rolePolicy = await prepareUserProfileRolePolicyAuthority(source.id, options);
    const channel = await prepareUserChannelIdentityAuthority(identity, options);
    expectCurrent(true, selection, admin, rolePolicy, channel);

    const execute = stateReads.executeExistingOpenClawStateRead;
    if (change === "stale role reply") {
      vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementationOnce(
        async (...args) => {
          await setRole(source.id, "member");
          const reply = await execute(...args);
          expect(reply).toMatchObject({
            type: "userProfiles.catalog",
            profiles: expect.arrayContaining([
              [source.id, expect.objectContaining({ role: "member" })],
            ]),
          });
          await setRole(source.id, "admin");
          return reply;
        },
      );
    }
    if (change === "email binding") {
      const target = ensureProfileForEmail("target@example.test", options);
      await linkCanonicalUserProfileEmail("source@example.test", target.id, options);
      await linkCanonicalUserProfileEmail("source@example.test", source.id, options);
    }
    const prepared = await prepareRole(source.id, true);
    if (change === "stale role reply") {
      expect(prepared).toMatchObject({
        role: "admin",
        listItem: { id: source.id, role: "admin", emails: ["source@example.test"] },
      });
    }
    expect(prepared?.isCurrent()).toBe(true);
    await retainCatalog();
    expect(readResidentUserProfileIdentity(source.id, options)?.profileId).toBe(source.id);
    expectCurrent(false, admin, rolePolicy, channel);
    expectCurrent(true, selection);
    expect((await prepareUserChannelIdentityAuthority(identity, options))?.isCurrent()).toBe(true);
  },
);

it("does not create state or identity tables while resolving absent links", async () => {
  expect(await prepareUserChannelIdentityAuthority(identity, options)).toBeUndefined();
  expect(await prepareUserProfileRolePolicyAuthority("absent", options)).toBeUndefined();
  expect(await listCanonicalUserChannelIdentities("absent", options)).toEqual([]);
  expect(resolveUserChannelIdentity(identity, options)).toBeUndefined();
  expect(existsSync(options.path)).toBe(false);
  const { db } = openOpenClawStateDatabase(options);
  expect(await prepareUserProfileRolePolicyAuthority("absent", options)).toBeUndefined();
  expect(resolveUserChannelIdentity(identity, options)).toBeUndefined();
  expect(await listCanonicalUserChannelIdentities("absent", options)).toEqual([]);
  expect(tableExists(db, "user_profiles")).toBe(false);
  expect(tableExists(db, "user_profile_identities")).toBe(false);
});

it("serves profile authority from committed catalog facts without another worker read", async () => {
  const source = ensureProfileForEmail("source@example.test", options);
  const target = ensureProfileForEmail("target@example.test", options);
  await setRole(source.id, "admin");
  await retainCatalog();
  const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  const original = await prepareRole(source.id, true);
  expect(original).toMatchObject({
    profileId: source.id,
    role: "admin",
    listItem: { emails: ["source@example.test"] },
  });
  const aliases = await prepareCurrentUserProfileAliases(source.id, options);
  expect(aliases.aliases).toEqual(new Set([source.id]));
  expect(original?.isCurrent()).toBe(true);
  expect(reads).not.toHaveBeenCalled();

  await setRole(source.id, "member");
  await setCanonicalUserProfileDisplayName(source.id, "Current name", options);
  expect(original?.isCurrent()).toBe(false);
  reads.mockClear();
  const current = await prepareRole(source.id);
  expect(current).toMatchObject({
    profileId: source.id,
    role: "member",
    display: { id: source.id, displayName: "Current name" },
  });
  expect(current?.isCurrent()).toBe(true);
  expect(reads).not.toHaveBeenCalled();

  await mergeCanonicalUserProfiles(source.id, target.id, options);
  expect(current?.isCurrent()).toBe(false);
  expect(() => aliases.assertCurrent()).toThrow();
  reads.mockClear();
  const merged = await prepareRole(source.id, true);
  expect(merged).toMatchObject({
    profileId: target.id,
    aliases: [target.id, source.id],
    display: { id: target.id },
  });
  expect(merged?.isCurrent()).toBe(true);
  expect(merged?.listItem?.emails).toEqual(["source@example.test", "target@example.test"]);
  expect((await prepareCurrentUserProfileAliases(source.id, options)).aliases).toEqual(
    new Set([target.id, source.id]),
  );
  expect(reads).not.toHaveBeenCalled();
});

it("releases an expired commit fence before retrying a channel identity change", async () => {
  const profile = ensureProfileForEmail("owner@example.test", options);
  linkUserChannelIdentity(profile.id, identity, options);
  const context = captureOpenClawStateWorkerContext(options);
  const authority = await captureUserProfileAuthorityRead(
    context.admission,
    userChannelIdentitySubject(identity),
  );
  const settled = authority.transferSettled([]);
  let expired = false;
  probe.admission(operationAdmission, (request, grant, admit) => {
    if (request.stage !== "commit" || expired) {
      admit(request, grant);
      return;
    }
    expired = true;
    const clock = vi.spyOn(process.hrtime, "bigint");
    try {
      admit(request, (beforeRelease) =>
        grant(() => {
          beforeRelease?.();
          expect(readProfileAuthority(settled)).toBe("pending");
          // Expire the real shared decision after fencing, without delaying the native worker.
          clock.mockReturnValue(process.hrtime.bigint() + 2_000_000_000n);
        }),
      );
    } finally {
      clock.mockRestore();
    }
    expect(readProfileAuthority(settled)).toBe("current");
  });
  await expect(
    changeCanonicalUserChannelIdentity("unlink", profile.id, identity, options),
  ).resolves.toEqual({ kind: "unlinked", removed: true });
  expect(expired).toBe(true);
  expect(resolveUserChannelIdentity(identity, options)).toBeUndefined();
  expect(readProfileAuthority(settled)).toBe("current");
});

it("revokes the exact prepared binding before worker commit acknowledgement", async () => {
  const otherOptions = stateOptions();
  const ada = ensureProfileForEmail("ada@example.test", options);
  const grace = ensureProfileForEmail("grace@example.test", options);
  const other = ensureProfileForEmail("other@example.test", otherOptions);
  setUserProfileRole(ada.id, "admin", options);
  linkUserChannelIdentity(ada.id, identity, options);
  const prepared = await prepareUserChannelIdentityAuthority(identity, options);
  expect(prepared?.linked.profileId).toBe(ada.id);
  const { db } = openOpenClawStateDatabase(options);
  await retainCatalog();
  const queries = vi.spyOn(db, "prepare");
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
  let observedCommitGrant = false;
  const admissionSpy = probe.admission(operationAdmission, (request, grant, admit) => {
    admit(request, (beforeRelease) =>
      grant(() => {
        beforeRelease?.();
        if (request.stage === "commit") {
          observedCommitGrant = true;
          // This executes before the worker receives permission to COMMIT.
          expect(prepared?.isCurrent()).toBe(false);
        }
      }),
    );
  });
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

  const admin = await prepareRole(ada.id);
  const rolePolicy = await prepareUserProfileRolePolicyAuthority(ada.id, options);
  const selectedSource = await prepareUserProfileSelectionAuthority(ada.id, options);
  const selectedTarget = await prepareUserProfileSelectionAuthority(grace.id, options);
  expect(admin?.role).toBe("admin");
  expect(rolePolicy).toMatchObject({ profileId: ada.id, role: "admin" });
  expectCurrent(true, rolePolicy, selectedSource, selectedTarget);
  let mutation: "demote" | "reject" | "rollback" | "recover" | "merge" = "demote";
  let actorCurrent = true;
  let rejectedBeforeAdmission = false;
  let rollbackGranted = false;
  let pendingRole: ReturnType<typeof prepareRole> | undefined;
  let pendingSelection: ReturnType<typeof prepareUserProfileSelectionAuthority> | undefined;
  const mutationAdmissionSpy = probe.admission(operationAdmission, (request, grant, admit) => {
    if (request.stage === "commit" && mutation === "reject") {
      actorCurrent = false;
      rejectedBeforeAdmission = true;
    }
    admit(request, () => {
      if (request.stage === "commit" && mutation === "rollback") {
        rollbackGranted = true;
      } else if (request.stage === "commit" && mutation === "demote") {
        queries.mockClear();
        expectCurrent(false, admin, rolePolicy);
        expect(selectedSource?.isCurrent()).toBe(true);
        expect(queries).not.toHaveBeenCalled();
        pendingRole = prepareRole(ada.id);
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
  });
  try {
    await expect(
      setRole(ada.id, "member", () =>
        requireCurrent(admin?.isCurrent(), "Administrative authority was revoked"),
      ),
    ).resolves.toMatchObject({ id: ada.id, role: "member" });
    expectCurrent(false, admin, rolePolicy);
    expect(await prepareUserProfileRolePolicyAuthority(ada.id, options)).toMatchObject({
      profileId: ada.id,
      role: "member",
    });
    expect(selectedSource?.isCurrent()).toBe(true);
    expect(pendingRole).toBeDefined();
    await expect(pendingRole).resolves.toMatchObject({ profileId: ada.id, role: "member" });

    setUserProfileRole(ada.id, "admin", options);
    mutation = "reject";
    await expect(
      setRole(ada.id, "member", () => requireCurrent(actorCurrent, "Original actor was revoked")),
    ).rejects.toThrow("Original actor was revoked");
    expect(rejectedBeforeAdmission).toBe(true);
    expect((await prepareRole(ada.id))?.role).toBe("admin");

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
      await expect(setRole(ada.id, "member")).rejects.toThrow(/FOREIGN KEY constraint failed/i);
      expect(rollbackGranted).toBe(true);
      expect(resolveUserChannelIdentity(identity, options)?.role).toBe("admin");
      queries.mockClear();
      expect(readResidentUserProfileIdentity(ada.id, options)?.role).toBe("admin");
      expect(getUserProfileDisplay(ada.id, options)).toEqual(beforeRollback);
      expect(queries).not.toHaveBeenCalled();
      const afterRollback = await prepareRole(ada.id);
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
    await expect(setRole(ada.id, "member")).resolves.toMatchObject({
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
  const reopened = await prepareUserChannelIdentityAuthority(identity, options);
  expect(reopened?.isCurrent()).toBe(true);
  expect(latest?.isCurrent()).toBe(false);
});

it.each([false, true])(
  "commits account-scoped links and refuses conflicting assignments (merged=%s)",
  async (merged) => {
    const ada = ensureProfileForEmail("ada@example.test", options);
    const grace = ensureProfileForEmail("grace@example.test", options);
    const intruder = ensureProfileForEmail("intruder@example.test", options);
    setUserProfileRole(ada.id, "admin", options);
    setUserProfileRole(grace.id, "member", options);
    const revision = readUserProfileAliasRevision();
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        linkUserChannelIdentity(ada.id, identity, options);
        expect(readUserProfileAliasRevision()).toBe(revision);
        throw new Error("rollback");
      }, options),
    ).toThrow("rollback");
    expect(readUserProfileAliasRevision()).toBe(revision);
    expect(resolveUserChannelIdentity(identity, options)).toBeUndefined();
    const link = { profileId: ada.id, identity };
    expect(linkUserChannelIdentity(ada.id, identity, options)).toEqual(link);
    expect(readUserProfileAliasRevision()).toBe(revision + 1);
    expect(linkUserChannelIdentity(ada.id, identity, options)).toEqual(link);
    expect(readUserProfileAliasRevision()).toBe(revision + 1);
    if (merged) {
      linkEmail("ada@example.test", grace.id, options);
    }
    const profileId = merged ? grace.id : ada.id;
    await closeOpenClawStateDatabaseAsync();
    expect(resolveUserChannelIdentity(identity, options)).toMatchObject({
      profileId,
      role: merged ? "member" : "admin",
      emails: merged ? ["ada@example.test", "grace@example.test"] : ["ada@example.test"],
      loginIdentities: merged ? ["ada@example.test", "grace@example.test"] : ["ada@example.test"],
    });
    expect(await listCanonicalUserChannelIdentities(ada.id, options)).toEqual([
      { profileId, identity },
    ]);
    expect(() => linkUserChannelIdentity(intruder.id, identity, options)).toThrow(
      "linked to another profile",
    );
    expect(() => unlinkUserChannelIdentity(intruder.id, identity, options)).toThrow(
      "linked to another profile",
    );
    for (const other of [
      { ...identity, accountId: "personal-bot" },
      { ...identity, channelId: "another-channel" },
    ]) {
      expect(resolveUserChannelIdentity(other, options)).toBeUndefined();
      linkUserChannelIdentity(intruder.id, other, options);
      expect(resolveUserChannelIdentity(other, options)?.profileId).toBe(intruder.id);
    }
    const beforeUnlink = readUserProfileAliasRevision();
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        unlinkUserChannelIdentity(ada.id, identity, options);
        throw new Error("rollback");
      }, options),
    ).toThrow("rollback");
    expect(readUserProfileAliasRevision()).toBe(beforeUnlink);
    expect(resolveUserChannelIdentity(identity, options)?.profileId).toBe(profileId);
    expect(unlinkUserChannelIdentity(ada.id, identity, options)).toBe(true);
    expect(readUserProfileAliasRevision()).toBe(beforeUnlink + 1);
    expect(unlinkUserChannelIdentity(ada.id, identity, options)).toBe(false);
    expect(resolveUserChannelIdentity(identity, options)).toBeUndefined();
  },
);

it("reads current roles and only canonical login identities, including the current verified GitHub login", () => {
  const sync = (accountId: number, login: string, byEmail = true) =>
    syncGitHubIdentity(
      {
        identity: { accountId, login },
        authenticationAlias: byEmail
          ? { kind: "email", email: "ada@example.test" }
          : { kind: "github-login", login },
      },
      options,
    );
  const passkey = ensureProfileForTailscaleIdentity({ login: "ada@passkey" }, options);
  linkEmail("ada@example.test", passkey.id, options);
  const profile = sync(123, "old-login");
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
      .values(
        (
          [
            ["123", "retired-login"],
            ["456", null],
          ] as const
        ).map(([subject, canonical_login]) => ({
          provider: "github-attribution",
          subject,
          profile_id: profile.id,
          canonical_login,
          created_at: 1,
        })),
      ),
  );
  sync(123, "new-login", false);
  expect(resolveUserChannelIdentity(identity, options)).toMatchObject({
    profileId: profile.id,
    role: "admin",
    emails: ["ada@example.test", "old-login@github"],
    githubLogin: "new-login",
    loginIdentities: ["ada@example.test", "ada@passkey", "new-login@github"],
  });
  setUserProfileRole(profile.id, "member", options);
  expect(resolveUserChannelIdentity(identity, options)?.role).toBe("member");
  sync(789, "new-person");
  expect(resolveUserChannelIdentity(identity, options)).toMatchObject({
    profileId: profile.id,
    role: "member",
    emails: ["old-login@github"],
    loginIdentities: ["ada@passkey", "new-login@github"],
  });
});

it("rejects the shared owner and malformed identities without linking a person", async () => {
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
