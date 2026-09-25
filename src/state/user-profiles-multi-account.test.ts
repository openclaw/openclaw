import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withOpenClawStateDatabaseReadSnapshot } from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  getUserPreferences,
  setCanonicalUserPreferences,
  setUserPreferences,
} from "./user-preferences.js";
import {
  listUserProfileGitHubLogins,
  prepareUserProfileGitHubAttribution,
  resolveUserProfileGitHubAttribution,
} from "./user-profile-github-identity.js";
import { listUserProfilesSync } from "./user-profile-identity.read.js";
import { resolveCanonicalCachedGitHubIdentity } from "./user-profile-reads.js";
import {
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
  getProfileAvatar,
  getUserProfileDisplay,
  getUserProfileListItem,
  linkEmail,
  setAvatar,
  syncGitHubIdentity,
} from "./user-profiles.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});
function stateOptions() {
  return { path: join(tempDirs.make("openclaw-multi-account-"), "openclaw.sqlite") };
}

function syncTailscaleGitHubProfile(
  params: {
    accountId: number;
    canonicalLogin: string;
    login: string;
    name?: string;
    githubName?: string;
  },
  options: Parameters<typeof ensureProfileForTailscaleIdentity>[1],
) {
  return syncGitHubIdentity(
    {
      identity: {
        accountId: params.accountId,
        login: params.canonicalLogin,
        name: params.githubName,
      },
      authenticationAlias: { kind: "github-login", login: params.login },
      initialDisplayName: params.name,
    },
    options,
  );
}

function syncEmailGitHubProfile(
  params: { accountId: number; canonicalLogin: string; email: string; name?: string },
  options: Parameters<typeof ensureProfileForEmail>[1],
) {
  return syncGitHubIdentity(
    {
      identity: { accountId: params.accountId, login: params.canonicalLogin },
      authenticationAlias: { kind: "email", email: params.email },
      initialDisplayName: params.name,
    },
    options,
  );
}

describe("multi-account people", () => {
  it("does not initialize missing profile storage during attribution reads", async () => {
    const options = stateOptions();
    expect(await resolveUserProfileGitHubAttribution(["missing-person"], options)).toEqual(
      new Map(),
    );
    expect(existsSync(options.path)).toBe(false);
    const { db } = openOpenClawStateDatabase(options);
    expect(await resolveUserProfileGitHubAttribution(["missing-person"], options)).toEqual(
      new Map(),
    );
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'user_profiles'").get(),
    ).toBeUndefined();
  });

  it("adds the nullable primary column to existing profiles without advancing the schema", async () => {
    const options = stateOptions();
    const db = openOpenClawStateDatabase(options).db;
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
    expect(
      (await resolveUserProfileGitHubAttribution(["legacy-person"], options)).get("legacy-person"),
    ).toBeNull();
    db.exec("ALTER TABLE user_profile_identities ADD COLUMN canonical_login TEXT");
    db.prepare(
      "UPDATE user_profile_identities SET canonical_login = 'legacy' WHERE subject = '70'",
    ).run();
    expect(
      (await resolveUserProfileGitHubAttribution(["legacy-person"], options)).get("legacy-person"),
    ).toEqual({ accountId: 70, login: "legacy" });
    expect(db.prepare("PRAGMA table_info(user_profiles)").all()).not.toContainEqual(
      expect.objectContaining({ name: "primary_github_account_id" }),
    );
    expect(getUserProfileListItem("legacy-person", options)).toMatchObject({
      displayName: "Saved Person Name",
      githubIdentity: { login: "legacy" },
    });
    const profile = syncEmailGitHubProfile(
      { accountId: 70, canonicalLogin: "legacy", email: "legacy@example.test" },
      options,
    );
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
    db.prepare("UPDATE user_profiles SET primary_github_account_id = 999 WHERE id = ?").run(
      profile.id,
    );
    expect(
      (await resolveUserProfileGitHubAttribution([profile.id], options)).get(profile.id),
    ).toBeNull();
    db.prepare("UPDATE user_profiles SET primary_github_account_id = 70 WHERE id = ?").run(
      profile.id,
    );
    closeOpenClawStateDatabaseForTest();
    expect(getUserProfileListItem(profile.id, options)).toMatchObject({
      displayName: "Saved Person Name",
      githubIdentity: { login: "legacy" },
    });
  });
  it("keeps both verified accounts on one person across merge and alternating sign-ins", async () => {
    const options = stateOptions();
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
    const person = syncEmailGitHubProfile(primary, options);
    const work = syncEmailGitHubProfile(secondary, options);
    setAvatar(person.id, new Uint8Array([1, 2, 3]), "image/png", options);
    setUserPreferences(person.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false }, options);
    const version = openOpenClawStateDatabase(options)
      .db.prepare("PRAGMA user_version")
      .get()?.user_version;
    const beforeMerge = await prepareUserProfileGitHubAttribution([work.id], options);
    linkEmail(secondary.email, person.id, options);
    expect(beforeMerge.isCurrent()).toBe(false);
    closeOpenClawStateDatabaseForTest();
    for (const account of [secondary, primary, secondary]) {
      expect(syncEmailGitHubProfile(account, options)).toMatchObject({
        id: person.id,
        displayName: "One Person",
        githubIdentity: { login: "person" },
        hasAvatar: true,
      });
      expect(
        (
          await resolveCanonicalCachedGitHubIdentity(
            { accountId: account.accountId, email: account.email },
            options,
          )
        )?.profileId,
      ).toBe(person.id);
      expect(getUserProfileDisplay(work.id, options)).toMatchObject({
        id: person.id,
        displayName: "One Person",
        hasAvatar: true,
      });
      expect(getProfileAvatar(work.id, options)?.bytes).toEqual(new Uint8Array([1, 2, 3]));
      expect(getUserPreferences(person.id, [GIT_COAUTHOR_PREFERENCE_KEY], options)).toEqual({
        [GIT_COAUTHOR_PREFERENCE_KEY]: false,
      });
    }
    expect(
      listUserProfilesSync(options).filter((profile) => profile.mergedInto === null),
    ).toHaveLength(1);
    expect(listUserProfileGitHubLogins(options).get(person.id)?.toSorted()).toEqual([
      "person",
      "person-work",
    ]);
    const signInAlias = ensureProfileForTailscaleIdentity(
      { login: `${secondary.canonicalLogin}@github` },
      options,
    );
    expect(signInAlias.id).not.toBe(person.id);
    expect(
      syncTailscaleGitHubProfile(
        {
          accountId: secondary.accountId,
          canonicalLogin: secondary.canonicalLogin,
          login: secondary.canonicalLogin,
        },
        options,
      ),
    ).toMatchObject({ id: person.id, githubIdentity: { login: primary.canonicalLogin } });
    expect(getUserProfileDisplay(signInAlias.id, options).id).toBe(person.id);
    expect(
      await resolveCanonicalCachedGitHubIdentity({ accountId: 73, email: primary.email }, options),
    ).toBeUndefined();
    expect(
      (await resolveUserProfileGitHubAttribution([person.id, work.id], options)).get(work.id),
    ).toBeNull();
    setUserPreferences(person.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true }, options);
    expect(
      (await resolveUserProfileGitHubAttribution([work.id], options)).get(work.id)?.accountId,
    ).toBe(primary.accountId);
    await withOpenClawStateDatabaseReadSnapshot(async () => {
      setUserPreferences(person.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false }, options);
      expect(
        (await resolveUserProfileGitHubAttribution([work.id], options)).get(work.id),
      ).toBeNull();
    }, options);
    setUserPreferences(person.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true }, options);
    const preparedCredit = await prepareUserProfileGitHubAttribution([work.id], options);
    expect(await setCanonicalUserPreferences(work.id, { theme: "dark" }, options)).toMatchObject({
      ok: true,
    });
    expect(preparedCredit.isCurrent()).toBe(true);
    expect(
      await setCanonicalUserPreferences(
        work.id,
        { [GIT_COAUTHOR_PREFERENCE_KEY]: false },
        { ...options, expectedEntries: { [GIT_COAUTHOR_PREFERENCE_KEY]: false } },
      ),
    ).toEqual({ ok: false, error: { code: "conflict" } });
    expect(preparedCredit.isCurrent()).toBe(true);
    expect(
      await setCanonicalUserPreferences(work.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false }, options),
    ).toEqual({ ok: true, value: { profileId: person.id } });
    expect(preparedCredit.isCurrent()).toBe(false);
    expect((await resolveUserProfileGitHubAttribution([work.id], options)).get(work.id)).toBeNull();
    expect(
      openOpenClawStateDatabase(options).db.prepare("PRAGMA user_version").get()?.user_version,
    ).toBe(version);
  });

  it("keeps an inherited primary through repeated merges regardless of account age", () => {
    const options = stateOptions();
    const older = syncEmailGitHubProfile(
      { accountId: 80, canonicalLogin: "older-work", email: "older@example.test" },
      options,
    );
    const primary = syncEmailGitHubProfile(
      { accountId: 81, canonicalLogin: "primary-person", email: "primary@example.test" },
      options,
    );
    setUserPreferences(primary.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false }, options);
    setAvatar(primary.id, new Uint8Array([4, 5]), "image/png", options);
    linkEmail("older@example.test", primary.id, options);
    const target = ensureProfileForEmail("target@example.test", options);
    linkEmail("primary@example.test", target.id, options);
    linkEmail("older@example.test", target.id, options);
    expect(getUserProfileListItem(older.id, options)).toMatchObject({
      id: target.id,
      githubIdentity: { login: "primary-person" },
    });
    expect(getProfileAvatar(older.id, options)?.bytes).toEqual(new Uint8Array([4, 5]));
    expect(listUserProfileGitHubLogins(options).get(target.id)?.toSorted()).toEqual([
      "older-work",
      "primary-person",
    ]);
    expect(getUserPreferences(target.id, [GIT_COAUTHOR_PREFERENCE_KEY], options)).toEqual({
      [GIT_COAUTHOR_PREFERENCE_KEY]: false,
    });
  });

  it("leaves ambiguous or invalid primary accounts out of public credit without breaking sign-in", async () => {
    const options = stateOptions();
    const person = syncEmailGitHubProfile(
      { accountId: 90, canonicalLogin: "first", email: "first@example.test" },
      options,
    );
    syncEmailGitHubProfile(
      { accountId: 91, canonicalLogin: "second", email: "second@example.test" },
      options,
    );
    linkEmail("second@example.test", person.id, options);
    for (const primaryId of [null, 999]) {
      openOpenClawStateDatabase(options)
        .db.prepare("UPDATE user_profiles SET primary_github_account_id = ? WHERE id = ?")
        .run(primaryId, person.id);
      expect(
        syncEmailGitHubProfile(
          { accountId: 91, canonicalLogin: "second", email: "second@example.test" },
          options,
        ),
      ).toMatchObject({ id: person.id, githubIdentity: null });
      expect(
        (await resolveUserProfileGitHubAttribution([person.id], options)).get(person.id),
      ).toBeNull();
    }
  });
});
