import { existsSync } from "node:fs";
import { StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/index.js";
import { observeMainThreadReads } from "../test-utils/main-thread-sql-spies.test-support.js";
import * as stateReads from "./openclaw-state-db-readonly.js";
import { withOpenClawStateDatabaseReadSnapshot as withSnapshot } from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { prepareUserProfileRolePolicyAuthority as roleAuthority } from "./user-channel-identity-operations.js";
import { setCanonicalUserPreferences as setPreferences } from "./user-preferences.js";
import { getUserPreferences, setUserPreferences } from "./user-preferences.test-support.js";
import {
  prepareUserProfileGitHubAttribution as prepareAttribution,
  readUserProfileGitHubCommand,
  resolveUserProfileGitHubAttribution as resolveAttribution,
} from "./user-profile-github-identity.js";
import {
  getUserProfileListItem as getProfile,
  readUserProfileSnapshotSync as readSnapshot,
} from "./user-profile-list-item.test-support.js";
import { getUserProfileDisplay } from "./user-profile-list.js";
import {
  readUserProfileDirectory as readDirectory,
  resolveCanonicalCachedGitHubIdentity as resolveIdentity,
} from "./user-profile-reads.js";
import { linkEmail, setAvatar, syncGitHubIdentity } from "./user-profile-writes.worker.js";
import { getProfileAvatar } from "./user-profiles-avatar.test-support.js";
import { useProfileDatabase } from "./user-profiles-fixture.test-support.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";
import { ensureProfileForEmail, ensureProfileForTailscaleIdentity } from "./user-profiles.js";
import { userProfileOperations } from "./user-profiles.worker.js";

const { options, hydrate, github } = useProfileDatabase("openclaw-multi-account-");

function syncEmailGitHubProfile(params: {
  accountId: number;
  canonicalLogin: string;
  email: string;
  name?: string;
}) {
  return github(params.accountId, params.canonicalLogin, {
    email: params.email,
    initialName: params.name,
  });
}

const createAccount = (accountId: number, canonicalLogin: string, email: string) =>
  syncEmailGitHubProfile({ accountId, canonicalLogin, email });
const consent = (id: string, enabled: boolean) =>
  setUserPreferences(id, { [GIT_COAUTHOR_PREFERENCE_KEY]: enabled }, options);
const readConsent = (id: string) => getUserPreferences(id, [GIT_COAUTHOR_PREFERENCE_KEY], options);
const attribution = async (id: string) => (await resolveAttribution([id], options)).get(id);

describe("multi-account people", () => {
  it("bounds directory materialization while preserving merged-profile filtering and account order", async () => {
    const database = openOpenClawStateDatabase(options);
    ensureUserProfilesSchema(options, database);
    const directory = (limit: number) => readDirectory(limit, options);
    expect(await directory(2)).toEqual({ profiles: [], truncated: false });

    const insertProfile = database.db.prepare(
      "INSERT INTO user_profiles (id, merged_into, created_at, updated_at) VALUES (?, ?, ?, 1)",
    );
    for (const id of ["c", "b", "a", "d"]) {
      insertProfile.run(id, null, id === "d" ? 2 : 1);
    }
    insertProfile.run("merged", "a", 0);
    database.db.exec(`
      INSERT INTO user_profile_emails (email, profile_id, binding_id, created_at)
        VALUES ('a@example.test', 'a', 'binding-a', 1), ('c@example.test', 'c', 'binding-c', 1);
      INSERT INTO user_profile_identities (provider, subject, profile_id, canonical_login, created_at)
        VALUES ('github', '12', 'a', 'person-work', 1),
               ('github', '11', 'a', 'person', 1),
               ('github', 'invalid', 'a', 'unverified', 1),
               ('github', '13', 'a', NULL, 1),
               ('github', '20', 'c', 'off-page', 1);
    `);

    const rowsRead: number[] = [];
    // oxlint-disable-next-line typescript/unbound-method -- Preserve the intercepted native receiver.
    const nativeAll = StatementSync.prototype.all;
    const reads = vi.spyOn(StatementSync.prototype, "all").mockImplementation(function (
      this: StatementSync,
      ...args
    ) {
      const rows = nativeAll.apply(this, args);
      if (/\bfrom "user_(?:profiles|profile_emails|profile_identities)"/iu.test(this.sourceSQL)) {
        rowsRead.push(rows.length);
      }
      return rows;
    });
    try {
      expect(
        userProfileOperations["userProfiles.directory"](
          { limit: 2 },
          {
            open: () => database,
            stateOptions: () => ({ ...options, env: process.env }),
          },
        ),
      ).toEqual({
        profiles: [
          { id: "a", logins: ["person", "person-work"] },
          { id: "b", logins: [] },
        ],
        truncated: true,
      });
      expect(rowsRead.length).toBeLessThanOrEqual(2);
      expect(rowsRead.every((count) => count <= 3)).toBe(true);
    } finally {
      reads.mockRestore();
    }
    expect(await directory(0)).toEqual({ profiles: [], truncated: true });
    expect(await directory(4)).toEqual({
      profiles: [
        { id: "a", logins: ["person", "person-work"] },
        { id: "b", logins: [] },
        { id: "c", logins: ["off-page"] },
        { id: "d", logins: [] },
      ],
      truncated: false,
    });
  });

  it("does not initialize missing profile storage during attribution reads", async () => {
    expect(await resolveAttribution(["missing-person"], options)).toEqual(new Map());
    expect(existsSync(options.path)).toBe(false);
    const { db } = openOpenClawStateDatabase(options);
    expect(await resolveAttribution(["missing-person"], options)).toEqual(new Map());
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'user_profiles'").get(),
    ).toBeUndefined();
  });

  it("reads public credit for merged aliases in one snapshot statement", () => {
    const person = createAccount(71, "person", "person@example.test");
    const alias = ensureProfileForEmail("alias@example.test", options);
    const unverified = ensureProfileForEmail("unverified@example.test", options);
    linkEmail("alias@example.test", person.id, options);
    consent(person.id, true);
    const { db } = openOpenClawStateDatabase(options);
    const reads = observeMainThreadReads();
    const transactions = vi.spyOn(db, "exec");
    try {
      expect(
        readUserProfileGitHubCommand(db, {
          type: "userProfiles.githubAttribution.resolve",
          profileIds: [person.id, alias.id, alias.id, unverified.id, "missing"],
        }),
      ).toEqual({
        type: "userProfiles.githubAttribution.resolve",
        identities: new Map([
          [person.id, { accountId: 71, login: "person" }],
          [alias.id, { accountId: 71, login: "person" }],
          [unverified.id, null],
        ]),
        canonicalProfileIds: expect.arrayContaining([person.id, unverified.id]),
      });
      expect(reads.count()).toBe(1);
      expect(transactions).not.toHaveBeenCalled();
    } finally {
      reads.restore();
      transactions.mockRestore();
    }
  });

  it("adds the nullable primary column to existing profiles without advancing the schema", async () => {
    let db = openOpenClawStateDatabase(options).db;
    db.exec(
      "CREATE TABLE user_profiles (id TEXT NOT NULL PRIMARY KEY, display_name TEXT, avatar BLOB, avatar_mime TEXT, avatar_sha256 TEXT, merged_into TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT",
    );
    db.exec(
      "CREATE TABLE user_profile_identities (provider TEXT NOT NULL, subject TEXT NOT NULL, profile_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (provider, subject)) STRICT",
    );
    db.prepare(
      "INSERT INTO user_profiles (id, display_name, created_at, updated_at) VALUES (?, ?, 1, 1)",
    ).run("legacy-person", "Saved Person Name");
    db.prepare(
      "INSERT INTO user_profile_identities (provider, subject, profile_id, created_at) VALUES ('github', '70', ?, 1)",
    ).run("legacy-person");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    // Decode the legacy shape before the schema owner makes it admissible for reopen.
    expect(
      readUserProfileGitHubCommand(db, {
        type: "userProfiles.githubAttribution.resolve",
        profileIds: ["legacy-person"],
      }),
    ).toMatchObject({ identities: new Map([["legacy-person", null]]) });
    db.exec("ALTER TABLE user_profile_identities ADD COLUMN canonical_login TEXT");
    db.prepare(
      "UPDATE user_profile_identities SET canonical_login = 'legacy' WHERE subject = '70'",
    ).run();
    expect(
      readUserProfileGitHubCommand(db, {
        type: "userProfiles.githubAttribution.resolve",
        profileIds: ["legacy-person"],
      }),
    ).toMatchObject({
      identities: new Map([["legacy-person", { accountId: 70, login: "legacy" }]]),
    });
    expect(db.prepare("PRAGMA table_info(user_profiles)").all()).not.toContainEqual(
      expect.objectContaining({ name: "primary_github_account_id" }),
    );
    expect(getProfile("legacy-person", options)).toMatchObject({
      displayName: "Saved Person Name",
      githubIdentity: { login: "legacy" },
    });
    const profile = createAccount(70, "legacy", "legacy@example.test");
    expect(profile.id).toBe("legacy-person");
    expect(
      db
        .prepare("SELECT primary_github_account_id FROM user_profiles WHERE id = ?")
        .get(profile.id),
    ).toEqual({ primary_github_account_id: 70 });
    expect(db.prepare("PRAGMA table_info(user_profiles)").all()).toContainEqual(
      expect.objectContaining({
        name: "primary_github_account_id",
        type: "INTEGER",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      }),
    );
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
    await closeOpenClawStateDatabaseAsync();
    db = openOpenClawStateDatabase(options).db;
    db.prepare("UPDATE user_profiles SET primary_github_account_id = 999 WHERE id = ?").run(
      profile.id,
    );
    expect(await attribution(profile.id)).toBeNull();
    db.prepare("UPDATE user_profiles SET primary_github_account_id = 70 WHERE id = ?").run(
      profile.id,
    );
    closeOpenClawStateDatabaseForTest();
    expect(getProfile(profile.id, options)).toMatchObject({
      displayName: "Saved Person Name",
      githubIdentity: { login: "legacy" },
    });
  });
  it("keeps both verified accounts on one person across merge and alternating sign-ins", async () => {
    const primary = {
      accountId: 71,
      canonicalLogin: "person",
      email: "personal@example.test",
      name: "One Person",
    };
    const secondary = {
      accountId: 72,
      canonicalLogin: "person-work",
      email: "work@example.test",
      name: "person",
    };
    const person = syncEmailGitHubProfile(primary);
    const work = syncEmailGitHubProfile(secondary);
    setAvatar(person.id, new Uint8Array([1, 2, 3]), "image/png", options);
    consent(person.id, false);
    const version = openOpenClawStateDatabase(options)
      .db.prepare("PRAGMA user_version")
      .get()?.user_version;
    const beforeMerge = await prepareAttribution([work.id], options);
    linkEmail(secondary.email, person.id, options);
    expect(beforeMerge.isCurrent()).toBe(false);
    closeOpenClawStateDatabaseForTest();
    await hydrate();
    for (const account of [secondary, primary, secondary]) {
      expect(syncEmailGitHubProfile(account)).toMatchObject({
        id: person.id,
        displayName: "One Person",
        githubIdentity: { login: "person" },
        hasAvatar: true,
      });
      expect(
        (await resolveIdentity({ accountId: account.accountId, email: account.email }, options))
          ?.profileId,
      ).toBe(person.id);
      expect(getUserProfileDisplay(work.id, options)).toMatchObject({
        id: person.id,
        displayName: "One Person",
        hasAvatar: true,
      });
      expect(getProfileAvatar(work.id, options)?.bytes).toEqual(new Uint8Array([1, 2, 3]));
      expect(readConsent(person.id)).toEqual({ [GIT_COAUTHOR_PREFERENCE_KEY]: false });
    }
    expect(
      readSnapshot(options).profiles.filter((profile) => profile.mergedInto === null),
    ).toHaveLength(1);
    expect(await readDirectory(10, options)).toEqual({
      profiles: [{ id: person.id, logins: ["person", "person-work"] }],
      truncated: false,
    });
    const signInAlias = ensureProfileForTailscaleIdentity(
      { login: `${secondary.canonicalLogin}@github` },
      options,
    );
    expect(signInAlias.id).not.toBe(person.id);
    expect(
      syncGitHubIdentity(
        {
          identity: { accountId: secondary.accountId, login: secondary.canonicalLogin },
          authenticationAlias: { kind: "github-login", login: secondary.canonicalLogin },
        },
        options,
      ),
    ).toMatchObject({ id: person.id, githubIdentity: { login: primary.canonicalLogin } });
    expect(getUserProfileDisplay(signInAlias.id, options).id).toBe(person.id);
    expect(await resolveIdentity({ accountId: 73, email: primary.email }, options)).toBeUndefined();
    expect((await resolveAttribution([person.id, work.id], options)).get(work.id)).toBeNull();
    consent(person.id, true);
    expect((await attribution(work.id))?.accountId).toBe(primary.accountId);
    await withSnapshot(async () => {
      consent(person.id, false);
      expect(await attribution(work.id)).toBeNull();
    }, options);
    consent(person.id, true);
    const preparedCredit = await prepareAttribution([work.id], options);
    const attributionRead = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    try {
      const credit = await resolveAttribution([work.id], options);
      const identity = credit.get(work.id);
      expect(identity?.accountId).toBe(primary.accountId);
      if (identity) {
        identity.login = "caller-edit";
      }
      expect(await attribution(work.id)).toEqual({
        accountId: primary.accountId,
        login: primary.canonicalLogin,
      });
      expect(attributionRead).not.toHaveBeenCalled();
    } finally {
      attributionRead.mockRestore();
    }
    expect(await setPreferences(work.id, { theme: "dark" }, options)).toMatchObject({ ok: true });
    expect(preparedCredit.isCurrent()).toBe(true);
    expect(
      await setPreferences(
        work.id,
        { [GIT_COAUTHOR_PREFERENCE_KEY]: false },
        { ...options, expectedEntries: { [GIT_COAUTHOR_PREFERENCE_KEY]: false } },
      ),
    ).toEqual({ ok: false, error: { code: "conflict" } });
    expect(preparedCredit.isCurrent()).toBe(true);
    expect(
      await setPreferences(work.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false }, options),
    ).toEqual({ ok: true, value: { profileId: person.id } });
    expect(preparedCredit.isCurrent()).toBe(false);
    expect(await resolveAttribution([person.id, work.id], options)).toEqual(
      new Map([
        [person.id, null],
        [work.id, null],
      ]),
    );
    expect(
      openOpenClawStateDatabase(options).db.prepare("PRAGMA user_version").get()?.user_version,
    ).toBe(version);
  });

  it("keeps an inherited primary through repeated merges regardless of account age", async () => {
    const older = createAccount(80, "older-work", "older@example.test");
    const primary = createAccount(81, "primary-person", "primary@example.test");
    consent(primary.id, false);
    setAvatar(primary.id, new Uint8Array([4, 5]), "image/png", options);
    linkEmail("older@example.test", primary.id, options);
    const target = ensureProfileForEmail("target@example.test", options);
    linkEmail("primary@example.test", target.id, options);
    linkEmail("older@example.test", target.id, options);
    expect(getProfile(older.id, options)).toMatchObject({
      id: target.id,
      githubIdentity: { login: "primary-person" },
    });
    expect(await roleAuthority(older.id, options)).toMatchObject({
      profileId: target.id,
      role: null,
      githubLogin: "primary-person",
    });
    expect(getProfileAvatar(older.id, options)?.bytes).toEqual(new Uint8Array([4, 5]));
    expect(await readDirectory(10, options)).toEqual({
      profiles: [{ id: target.id, logins: ["older-work", "primary-person"] }],
      truncated: false,
    });
    expect(readConsent(target.id)).toEqual({ [GIT_COAUTHOR_PREFERENCE_KEY]: false });
  });

  it("leaves ambiguous or invalid primary accounts out of public credit without breaking sign-in", async () => {
    const person = createAccount(90, "first", "first@example.test");
    createAccount(91, "second", "second@example.test");
    linkEmail("second@example.test", person.id, options);
    for (const primaryId of [null, 999]) {
      openOpenClawStateDatabase(options)
        .db.prepare("UPDATE user_profiles SET primary_github_account_id = ? WHERE id = ?")
        .run(primaryId, person.id);
      expect(createAccount(91, "second", "second@example.test")).toMatchObject({
        id: person.id,
        githubIdentity: null,
      });
      expect(await attribution(person.id)).toBeNull();
      expect(await roleAuthority(person.id, options)).toMatchObject({
        profileId: person.id,
        githubLogin: null,
      });
    }
  });
});
