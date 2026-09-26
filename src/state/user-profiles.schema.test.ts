import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  linkUserChannelIdentity,
  authorizeUserChannelIdentityInDatabase,
  publishUserChannelPolicyInDatabase,
  resolveUserChannelAuthorizationPolicy,
  configuredCommandOwnerPolicyFingerprint,
} from "./user-channel-identities.js";
import { prepareConfiguredCommandOwnerAuthority } from "./user-channel-identity-operations.js";
import {
  listUserProfilesSync,
  readUserProfileEmailBindings,
} from "./user-profile-identity.read.js";
import { readUserProfileIdentity, retainUserProfileCatalog } from "./user-profile-list.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";
import {
  ensureProfileForEmail,
  getUserProfileDisplay,
  getUserProfileListItem,
  getUserProfileRole,
  resolveUserProfileId,
  setUserProfileRole,
} from "./user-profiles.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function stateOptions() {
  const directory = tempDirs.make("openclaw-user-profile-schema-");
  return { path: join(directory, "openclaw.sqlite") };
}

function createLegacyProfileDatabase(options: ReturnType<typeof stateOptions>) {
  const database = openOpenClawStateDatabase(options).db;
  database.exec(`
    CREATE TABLE user_profiles (
      id TEXT NOT NULL PRIMARY KEY,
      display_name TEXT,
      avatar BLOB,
      avatar_mime TEXT,
      avatar_sha256 TEXT,
      merged_into TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
  `);
  return database;
}

function createLegacyEmailDatabase(options: ReturnType<typeof stateOptions>) {
  const database = createLegacyProfileDatabase(options);
  database.exec(`
    CREATE TABLE user_profile_emails (
      email TEXT NOT NULL PRIMARY KEY,
      profile_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO user_profiles (id, created_at, updated_at)
      VALUES ('legacy-one', 1, 2), ('legacy-two', 3, 4);
    INSERT INTO user_profile_emails (email, profile_id, created_at)
      VALUES ('one@example.test', 'legacy-one', 5), ('two@example.test', 'legacy-two', 6);
  `);
  return database;
}

function readUserProfileEmailBindingIds(
  profileId: string,
  options: ReturnType<typeof stateOptions>,
): string[] {
  ensureUserProfilesSchema(options);
  return readUserProfileEmailBindings(openOpenClawStateDatabase(options).db, profileId)
    .map(({ bindingId }) => {
      if (bindingId === null) {
        throw new Error("Test alias binding was not initialized");
      }
      return bindingId;
    })
    .toSorted();
}

describe("user profile email binding schema", () => {
  it("initializes legacy aliases once without changing their ownership, timestamps, or version", () => {
    const options = stateOptions();
    const database = createLegacyEmailDatabase(options);
    const before = database
      .prepare("SELECT email, profile_id, created_at FROM user_profile_emails ORDER BY email")
      .all();
    const versionBefore = database.prepare("PRAGMA user_version").get()?.user_version;
    const first = readUserProfileEmailBindingIds("legacy-one", options);
    const second = readUserProfileEmailBindingIds("legacy-two", options);
    expect(first).toEqual([expect.any(String)]);
    expect(second).toEqual([expect.any(String)]);
    expect(new Set([...first, ...second]).size).toBe(2);
    expect(
      database
        .prepare("SELECT email, profile_id, created_at FROM user_profile_emails ORDER BY email")
        .all(),
    ).toEqual(before);
    expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(versionBefore);
    expect(database.prepare("PRAGMA table_info(user_profile_emails)").all()).toContainEqual(
      expect.objectContaining({
        name: "binding_id",
        type: "TEXT",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      }),
    );
    closeOpenClawStateDatabaseForTest();
    expect(readUserProfileEmailBindingIds("legacy-one", options)).toEqual(first);
    expect(readUserProfileEmailBindingIds("legacy-two", options)).toEqual(second);
  });

  it.each(["outer", "savepoint"] as const)(
    "retries alias initialization after a %s migration rollback",
    (scope) => {
      const options = stateOptions();
      const database = createLegacyEmailDatabase(options);
      let rolledBackBindings: string[] | undefined;
      const rollBackBindings = () =>
        runOpenClawStateWriteTransaction(() => {
          rolledBackBindings = readUserProfileEmailBindingIds("legacy-one", options);
          expect(rolledBackBindings).toEqual([expect.any(String)]);
          throw new Error("roll back alias bindings");
        }, options);
      if (scope === "outer") {
        expect(rollBackBindings).toThrow("roll back alias bindings");
      } else {
        runOpenClawStateWriteTransaction(() => {
          expect(rollBackBindings).toThrow("roll back alias bindings");
          expect(tableHasColumn(database, "user_profile_emails", "binding_id")).toBe(false);
        }, options);
      }
      expect(tableHasColumn(database, "user_profile_emails", "binding_id")).toBe(false);
      const bindings = readUserProfileEmailBindingIds("legacy-one", options);
      expect(bindings).toEqual([expect.any(String)]);
      expect(bindings).not.toEqual(rolledBackBindings);
      closeOpenClawStateDatabaseForTest();
      expect(readUserProfileEmailBindingIds("legacy-one", options)).toEqual(bindings);
    },
  );
});

describe("user profile role schema", () => {
  it("lazily adds a downgrade-safe nullable role without changing the schema version", () => {
    const options = stateOptions();
    const database = createLegacyProfileDatabase(options);
    const versionBefore = database.prepare("PRAGMA user_version").get()?.user_version;
    const profile = ensureProfileForEmail("ada@example.com", options);
    const release = retainUserProfileCatalog(options);
    try {
      expect(readUserProfileIdentity(profile.id, options)?.role).toBeNull();

      expect(tableHasColumn(database, "user_profiles", "role")).toBe(false);
      expect(getUserProfileListItem(profile.id, options)).not.toHaveProperty("role");
      expect(getUserProfileDisplay(profile.id, options)).toMatchObject({
        id: profile.id,
        hasAvatar: false,
      });
      expect(listUserProfilesSync(options)[0]).not.toHaveProperty("role");
      expect(tableHasColumn(database, "user_profiles", "role")).toBe(false);
      expect(getUserProfileRole(profile.id, options)).toBeNull();
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(versionBefore);
      expect(database.prepare("PRAGMA table_info(user_profiles)").all()).toContainEqual(
        expect.objectContaining({
          name: "role",
          type: "TEXT",
          notnull: 0,
          dflt_value: null,
          pk: 0,
        }),
      );

      setUserProfileRole(profile.id, "maintainer", options);
      expect(readUserProfileIdentity(profile.id, options)?.role).toBe("maintainer");
      database
        .prepare("UPDATE user_profiles SET display_name = ? WHERE id = ?")
        .run("Older Reader", profile.id);
      database
        .prepare("INSERT INTO user_profiles (id, created_at, updated_at) VALUES (?, ?, ?)")
        .run("older-profile", 1, 1);
      closeOpenClawStateDatabaseForTest();

      expect(getUserProfileRole(profile.id, options)).toBe("maintainer");
      expect(getUserProfileRole("older-profile", options)).toBeNull();
      expect(getUserProfileListItem(profile.id, options)).toMatchObject({
        displayName: "Older Reader",
        role: "maintainer",
      });
    } finally {
      release();
    }
  });

  it.each(["outer", "savepoint"] as const)(
    "keeps legacy profile reads working after a %s role migration rollback",
    (scope) => {
      const options = stateOptions();
      const database = createLegacyProfileDatabase(options);
      const profile = ensureProfileForEmail("rollback@example.test", options);
      const assertRestored = () => {
        expect(tableHasColumn(database, "user_profiles", "role")).toBe(false);
        expect(resolveUserProfileId(profile.id, options)).toBe(profile.id);
        expect(getUserProfileListItem(profile.id, options)).not.toHaveProperty("role");
        expect(listUserProfilesSync(options)[0]).not.toHaveProperty("role");
      };
      const rollBackRole = () =>
        runOpenClawStateWriteTransaction(() => {
          expect(setUserProfileRole(profile.id, "maintainer", options)).toMatchObject({
            id: profile.id,
            role: "maintainer",
          });
          throw new Error("roll back role migration");
        }, options);
      if (scope === "outer") {
        expect(rollBackRole).toThrow("roll back role migration");
      } else {
        runOpenClawStateWriteTransaction(() => {
          expect(rollBackRole).toThrow("roll back role migration");
          assertRestored();
        }, options);
      }
      assertRestored();
      expect(setUserProfileRole(profile.id, "maintainer", options)).toMatchObject({
        id: profile.id,
        role: "maintainer",
      });
    },
  );
});

it.each([false, true])(
  "upgrades channel links without granting legacy recovery custody (deferred: %s)",
  async (deferred) => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("upgrade@example.test", options);
    const identity = { channelId: "discord", accountId: "team", senderId: "100" };
    linkUserChannelIdentity(profile.id, identity, options);
    const runId = "ed099411-cfbd-4304-a6b7-d3e504a48505";
    if (deferred) {
      createUpdateRun({ runId, trigger: "cli", before: { version: "2026.9.2" } }, options);
    }
    closeOpenClawStateDatabaseForTest();
    const legacy = new DatabaseSync(options.path);
    legacy.exec(`
    DROP INDEX idx_user_profile_identities_authorization;
    ALTER TABLE user_profile_identities DROP COLUMN authorization_id;
    ALTER TABLE user_profile_identities DROP COLUMN authorization_basis_json;
    PRAGMA user_version = 18;
    UPDATE schema_meta SET schema_version = 18;
  `);
    const before = legacy.prepare("SELECT * FROM user_profile_identities").all();
    legacy.close();
    let db = openOpenClawStateDatabase(options).db;
    expect(db.prepare("SELECT * FROM user_profile_identities").all()).toEqual(
      before.map((row) =>
        Object.assign(row, {
          authorization_id: null,
          authorization_basis_json: null,
        }),
      ),
    );
    const policy = resolveUserChannelAuthorizationPolicy({
      roles: {
        default: "admin",
        definitions: {
          admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
        },
      },
    });
    const owners = [identity.senderId];
    // Config activation publishes once; the update watcher can publish v19 later without a reload.
    runOpenClawStateWriteTransaction(({ db: writer }) => {
      publishUserChannelPolicyInDatabase(
        writer,
        policy,
        configuredCommandOwnerPolicyFingerprint(owners),
      );
    }, options);
    const mint = () =>
      runOpenClawStateWriteTransaction(({ db: writer }) => {
        return authorizeUserChannelIdentityInDatabase(writer, {
          identity,
          profileId: profile.id,
          policy,
          grant: null,
        });
      }, options);
    if (deferred) {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 18 });
      expect(mint()).toBeUndefined();
      expect(await prepareConfiguredCommandOwnerAuthority(owners, options)).toBeUndefined();
      db.prepare(
        "UPDATE update_runs SET status = 'succeeded', phase = 'finished', finished_at_ms = ? WHERE run_id = ?",
      ).run(Date.now() - 300_001, runId);
      closeOpenClawStateDatabaseForTest();
      db = openOpenClawStateDatabase(options).db;
    }
    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    const reference = mint();
    expect(reference).toEqual({ version: 1, id: expect.any(String) });
    const configured = await prepareConfiguredCommandOwnerAuthority(owners, options);
    expect(configured?.recoveryReference).toEqual({ version: 2, id: expect.any(String) });
    closeOpenClawStateDatabaseForTest();
    expect(mint()).toEqual(reference);
    expect(
      (await prepareConfiguredCommandOwnerAuthority(owners, options))?.recoveryReference,
    ).toEqual(configured?.recoveryReference);
  },
);
