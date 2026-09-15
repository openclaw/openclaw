import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  ensureProfileForEmail,
  getUserProfileDisplay,
  getUserProfileListItem,
  getUserProfileRole,
  listProfiles,
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

describe("user profile role schema", () => {
  it("lazily adds a downgrade-safe nullable role without changing the schema version", () => {
    const options = stateOptions();
    const database = createLegacyProfileDatabase(options);
    const versionBefore = database.prepare("PRAGMA user_version").get()?.user_version;
    const profile = ensureProfileForEmail("ada@example.com", options);

    expect(tableHasColumn(database, "user_profiles", "role")).toBe(false);
    expect(getUserProfileListItem(profile.id, options)).not.toHaveProperty("role");
    expect(getUserProfileDisplay(profile.id, options)).toMatchObject({
      id: profile.id,
      hasAvatar: false,
    });
    expect(listProfiles(options)[0]).not.toHaveProperty("role");
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
