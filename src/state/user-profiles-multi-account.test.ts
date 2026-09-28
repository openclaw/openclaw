import { existsSync } from "node:fs";
import { join } from "node:path";
import { StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  prepareUserProfileGitHubAttribution,
  resolveUserProfileGitHubAttribution,
} from "./user-profile-github-identity.js";
import { listUserProfilesSync } from "./user-profile-identity.read.js";
import { resolveCanonicalCachedGitHubIdentity } from "./user-profile-reads.js";
import { getProfileAvatar } from "./user-profiles-avatar.test-support.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";
import {
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
  getUserProfileDisplay,
  getUserProfileListItem,
  linkEmail,
  setAvatar,
  syncGitHubIdentity,
} from "./user-profiles.js";
import { executeUserProfileCommand } from "./user-profiles.worker.js";

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
  it("bounds directory materialization while preserving merged-profile filtering and account order", () => {
    const options = stateOptions();
    const database = openOpenClawStateDatabase(options);
    ensureUserProfilesSchema(options, database);
    const directory = (limit: number) =>
      executeUserProfileCommand({ type: "userProfiles.directory", input: { limit } }, options);
    expect(directory(2)).toEqual({ profiles: [], truncated: false });

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
      expect(directory(2)).toEqual({
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
    expect(directory(0)).toEqual({ profiles: [], truncated: true });
    expect(directory(4)).toEqual({
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
    expect(
      executeUserProfileCommand({ type: "userProfiles.directory", input: { limit: 10 } }, options),
    ).toEqual({
      profiles: [{ id: person.id, logins: ["person", "person-work"] }],
      truncated: false,
    });
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
    expect(
      executeUserProfileCommand({ type: "userProfiles.directory", input: { limit: 10 } }, options),
    ).toEqual({
      profiles: [{ id: target.id, logins: ["older-work", "primary-person"] }],
      truncated: false,
    });
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
