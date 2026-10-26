import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/index.js";
import { withOpenClawStateDatabaseReadSnapshot as withSnapshot } from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync as closeAsync,
  closeOpenClawStateDatabaseForTest as closeDatabase,
  openOpenClawStateDatabase as openDatabase,
} from "./openclaw-state-db.js";
import { prepareUserProfileRolePolicyAuthority as roleAuthority } from "./user-channel-identity-operations.js";
import { setCanonicalUserPreferences as setPreferences } from "./user-preferences.js";
import { getUserPreferences, setUserPreferences } from "./user-preferences.test-support.js";
import {
  prepareUserProfileGitHubAttribution as prepareAttribution,
  readUserProfileGitHubCommand as readGitHub,
  resolveUserProfileGitHubAttribution as resolveAttribution,
} from "./user-profile-github-identity.js";
import { getUserProfileListItem as getProfile } from "./user-profile-list-item.test-support.js";
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

const { options, hydrate, github } = useProfileDatabase("openclaw-multi-account-");

const createAccount = (accountId: number, login: string, email: string, initialName?: string) =>
  github(accountId, login, { email, initialName });
const accountFixture = (accountId: number, login: string, email: string, name: string) => ({
  accountId,
  login,
  email,
  signIn: () => createAccount(accountId, login, email, name),
});
const consent = (id: string, enabled: boolean) =>
  setUserPreferences(id, { [GIT_COAUTHOR_PREFERENCE_KEY]: enabled }, options);
const readConsent = (id: string) => getUserPreferences(id, [GIT_COAUTHOR_PREFERENCE_KEY], options);
const publicCredit = (enabled: boolean) => ({ [GIT_COAUTHOR_PREFERENCE_KEY]: enabled });
const attribution = async (id: string) => (await resolveAttribution([id], options)).get(id);
const schemaVersion = () =>
  openDatabase(options).db.prepare("PRAGMA user_version").get()?.user_version;
const readCredit = (db: Parameters<typeof readGitHub>[0], profileIds: string[]) =>
  readGitHub(db, { type: "userProfiles.githubAttribution.resolve", profileIds });
const directoryRow = (id: string, ...logins: string[]) => ({ id, logins });
const legacyPerson = { displayName: "Saved Person Name", githubIdentity: { login: "legacy" } };

describe("multi-account people", () => {
  it("bounds the directory while preserving merged-profile filtering and account order", async () => {
    const database = openDatabase(options);
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
      INSERT INTO user_profile_identities (provider, subject, profile_id, canonical_login, created_at)
        VALUES ('github', '12', 'a', 'person-work', 1),
               ('github', '11', 'a', 'person', 1),
               ('github', 'invalid', 'a', 'unverified', 1),
               ('github', '13', 'a', NULL, 1),
               ('github', '20', 'c', 'off-page', 1);
    `);

    expect(await directory(2)).toEqual({
      profiles: [directoryRow("a", "person", "person-work"), directoryRow("b")],
      truncated: true,
    });
    expect(await directory(0)).toEqual({ profiles: [], truncated: true });
    expect(await directory(4)).toEqual({
      profiles: [
        directoryRow("a", "person", "person-work"),
        directoryRow("b"),
        directoryRow("c", "off-page"),
        directoryRow("d"),
      ],
      truncated: false,
    });
  });

  it("does not initialize missing profile storage during attribution reads", async () => {
    expect(await resolveAttribution(["missing-person"], options)).toEqual(new Map());
    expect(existsSync(options.path)).toBe(false);
    const { db } = openDatabase(options);
    expect(await resolveAttribution(["missing-person"], options)).toEqual(new Map());
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'user_profiles'").get(),
    ).toBeUndefined();
  });

  it("adds the nullable primary column to existing profiles without advancing the schema", async () => {
    const db = openDatabase(options).db;
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
    const version = schemaVersion();
    // Decode the legacy shape before the schema owner makes it admissible for reopen.
    expect(readCredit(db, ["legacy-person"])).toMatchObject({
      identities: new Map([["legacy-person", null]]),
    });
    db.exec("ALTER TABLE user_profile_identities ADD COLUMN canonical_login TEXT");
    db.prepare(
      "UPDATE user_profile_identities SET canonical_login = 'legacy' WHERE subject = '70'",
    ).run();
    expect(readCredit(db, ["legacy-person"])).toMatchObject({
      identities: new Map([["legacy-person", { accountId: 70, login: "legacy" }]]),
    });
    expect(db.prepare("PRAGMA table_info(user_profiles)").all()).not.toContainEqual(
      expect.objectContaining({ name: "primary_github_account_id" }),
    );
    expect(getProfile("legacy-person", options)).toMatchObject(legacyPerson);
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
    expect(schemaVersion()).toBe(version);
    await closeAsync();
    expect(getProfile(profile.id, options)).toMatchObject(legacyPerson);
  });
  it("keeps both verified accounts on one person across merge and alternating sign-ins", async () => {
    const primary = accountFixture(71, "person", "personal@example.test", "One Person");
    const secondary = accountFixture(72, "person-work", "work@example.test", "person");
    const person = primary.signIn();
    const work = secondary.signIn();
    setAvatar(person.id, new Uint8Array([1, 2, 3]), "image/png", options);
    consent(person.id, false);
    const version = schemaVersion();
    const beforeMerge = await prepareAttribution([work.id], options);
    linkEmail(secondary.email, person.id, options);
    expect(beforeMerge.isCurrent()).toBe(false);
    closeDatabase();
    await hydrate();
    const display = { id: person.id, displayName: "One Person", hasAvatar: true };
    for (const account of [secondary, primary, secondary]) {
      expect(account.signIn()).toMatchObject({
        ...display,
        githubIdentity: { login: "person" },
      });
      expect(
        (await resolveIdentity({ accountId: account.accountId, email: account.email }, options))
          ?.profileId,
      ).toBe(person.id);
      expect(getUserProfileDisplay(work.id, options)).toMatchObject(display);
      expect(getProfileAvatar(work.id, options)?.bytes).toEqual(new Uint8Array([1, 2, 3]));
      expect(readConsent(person.id)).toEqual(publicCredit(false));
    }
    expect(await readDirectory(10, options)).toEqual({
      profiles: [directoryRow(person.id, "person", "person-work")],
      truncated: false,
    });
    const signInAlias = ensureProfileForTailscaleIdentity(
      { login: `${secondary.login}@github` },
      options,
    );
    expect(signInAlias.id).not.toBe(person.id);
    expect(
      syncGitHubIdentity(
        {
          identity: { accountId: secondary.accountId, login: secondary.login },
          authenticationAlias: { kind: "github-login", login: secondary.login },
        },
        options,
      ),
    ).toMatchObject({ id: person.id, githubIdentity: { login: primary.login } });
    expect(getUserProfileDisplay(signInAlias.id, options).id).toBe(person.id);
    expect(await resolveIdentity({ accountId: 73, email: primary.email }, options)).toBeUndefined();
    expect((await resolveAttribution([person.id, work.id], options)).get(work.id)).toBeNull();
    consent(person.id, true);
    const unverified = ensureProfileForEmail("unverified@example.test", options);
    const identity = { accountId: primary.accountId, login: primary.login };
    expect(
      await resolveAttribution([person.id, work.id, work.id, unverified.id, "missing"], options),
    ).toEqual(
      new Map([
        [person.id, identity],
        [work.id, identity],
        [unverified.id, null],
      ]),
    );
    await withSnapshot(async () => {
      consent(person.id, false);
      expect(await attribution(work.id)).toBeNull();
    }, options);
    consent(person.id, true);
    const preparedCredit = await prepareAttribution([work.id], options);
    const credit = await attribution(work.id);
    expect(credit?.accountId).toBe(primary.accountId);
    if (credit) {
      credit.login = "caller-edit";
    }
    expect(await attribution(work.id)).toEqual(identity);
    expect(await setPreferences(work.id, { theme: "dark" }, options)).toMatchObject({ ok: true });
    expect(preparedCredit.isCurrent()).toBe(true);
    expect(
      await setPreferences(work.id, publicCredit(false), {
        ...options,
        expectedEntries: publicCredit(false),
      }),
    ).toEqual({ ok: false, error: { code: "conflict" } });
    expect(preparedCredit.isCurrent()).toBe(true);
    expect(await setPreferences(work.id, publicCredit(false), options)).toEqual({
      ok: true,
      value: { profileId: person.id },
    });
    expect(preparedCredit.isCurrent()).toBe(false);
    expect(await resolveAttribution([person.id, work.id], options)).toEqual(
      new Map([
        [person.id, null],
        [work.id, null],
      ]),
    );
    expect(schemaVersion()).toBe(version);
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
      profiles: [directoryRow(target.id, "older-work", "primary-person")],
      truncated: false,
    });
    expect(readConsent(target.id)).toEqual(publicCredit(false));
  });

  it("leaves ambiguous or invalid primary accounts out of public credit without breaking sign-in", async () => {
    const person = createAccount(90, "first", "first@example.test");
    createAccount(91, "second", "second@example.test");
    linkEmail("second@example.test", person.id, options);
    for (const primaryId of [null, 999]) {
      openDatabase(options)
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
