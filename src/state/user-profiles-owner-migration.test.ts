import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest as closeDatabase,
  openOpenClawStateDatabase as openDatabase,
  runOpenClawStateWriteTransaction as transaction,
} from "./openclaw-state-db.js";
import { readUserProfileAliasRevision as readRevision } from "./user-profile-events.js";
import { readUserProfileSnapshotSync as readSnapshot } from "./user-profile-list-item.test-support.js";
import { readUserProfileAliases as readAliases } from "./user-profile-list.js";
import { useProfileDatabase } from "./user-profiles-fixture.test-support.js";
import { repairMergedGatewayOwnerProfile } from "./user-profiles-owner-migration.js";
import { mergeOwnerIntoPerson, profileState } from "./user-profiles-owner.test-support.js";
import {
  ensureGatewayOwnerProfile as ensureOwner,
  ensureProfileForTailscaleIdentity as ensureProvider,
} from "./user-profiles.js";

const { options, hydrate, github } = useProfileDatabase("openclaw-owner-migration-");

const repair = (shouldRepair: boolean) =>
  repairMergedGatewayOwnerProfile({ ...options, shouldRepair });
const readProfile = (id: string) => readSnapshot(options).profiles.find((row) => row.id === id);
const unchanged = { repaired: false, changes: [], warnings: [] };

describe("Doctor gateway owner repair", () => {
  it.each(["tombstone", "person", "missing"])(
    "reports then repairs a merged owner with its identity targeting %s once",
    async (identityTarget) => {
      const owner = ensureOwner("Local Owner", options);
      const person = mergeOwnerIntoPerson(owner.id, options);
      github(10, "person", { email: "person@example.test" });
      const db = openDatabase(options).db;
      if (identityTarget === "person") {
        db.prepare(
          "UPDATE user_profile_identities SET profile_id = ? WHERE provider = 'gateway.local'",
        ).run(person.id);
      } else if (identityTarget === "missing") {
        db.prepare("DELETE FROM user_profile_identities WHERE provider = 'gateway.local'").run();
      }
      const personBefore = readProfile(person.id);
      const before = profileState(options);
      const aliasRevision = readRevision();
      await hydrate();
      expect(readAliases(owner.id, options)).toEqual(new Set([owner.id, person.id]));
      expect(readAliases(person.id, options)).toEqual(new Set([owner.id, person.id]));

      expect(repair(false)).toMatchObject({
        repaired: false,
        changes: [],
        warnings: [expect.stringContaining("openclaw doctor --fix")],
      });
      expect(profileState(options)).toEqual(before);
      expect(readRevision()).toBe(aliasRevision);
      expect(() =>
        transaction(() => {
          expect(repair(true).repaired).toBe(true);
          expect(readRevision()).toBe(aliasRevision);
          throw new Error("rollback owner repair");
        }, options),
      ).toThrow("rollback owner repair");
      expect(readRevision()).toBe(aliasRevision);
      expect(profileState(options)).toEqual(before);
      expect(repair(true)).toMatchObject({
        repaired: true,
        changes: [expect.stringContaining("gateway-owner")],
        warnings: [],
      });
      expect(readAliases(owner.id, options)).toEqual(new Set([owner.id]));
      expect(readRevision()).toBe(aliasRevision + 1);
      expect(readAliases(person.id, options)).toEqual(new Set([person.id]));
      const restored = ensureOwner("Host Renamed", options);
      expect(restored).toMatchObject({
        id: owner.id,
        mergedInto: null,
        displayName: "Local Owner",
      });
      expect(restored.updatedAt).toBeGreaterThan(1);
      expect(readProfile(person.id)).toEqual(personBefore);
      expect(
        db
          .prepare(
            "SELECT profile_id FROM user_profile_identities WHERE provider = 'gateway.local' AND subject = 'owner'",
          )
          .get(),
      ).toEqual({ profile_id: owner.id });
      const repairedState = profileState(options);
      expect(repair(true)).toEqual(unchanged);
      expect(readRevision()).toBe(aliasRevision + 1);
      closeDatabase();
      expect(profileState(options)).toEqual(repairedState);
    },
  );

  it.each([false, true])(
    "preserves an unmerged legacy owner and replaces a merged one (merged: %s)",
    (merged) => {
      const legacy = ensureProvider({ login: "legacy@other" }, options);
      if (merged) {
        mergeOwnerIntoPerson(legacy.id, options);
      }
      const db = openDatabase(options).db;
      db.prepare(
        "INSERT INTO user_profile_identities (provider, subject, profile_id, created_at) VALUES ('gateway.local', 'owner', ?, 1)",
      ).run(legacy.id);
      const before = profileState(options);
      const aliasRevision = readRevision();
      expect(repair(true).repaired).toBe(merged);
      if (!merged) {
        expect(profileState(options)).toEqual(before);
      } else {
        expect(
          db.prepare("SELECT merged_into FROM user_profiles WHERE id = ?").get(legacy.id),
        ).toEqual({
          merged_into: before.profiles.find((profile) => profile.id === legacy.id)?.merged_into,
        });
      }
      expect(ensureOwner("Local Owner", options).id).toBe(merged ? "gateway-owner" : legacy.id);
      expect(readRevision()).toBe(aliasRevision);
    },
  );

  it.each([false, true])(
    "does not create profile state on an unused Gateway (fix: %s)",
    (shouldRepair) => {
      const aliasRevision = readRevision();
      expect(repair(shouldRepair)).toEqual(unchanged);
      expect(existsSync(options.path)).toBe(false);
      expect(readRevision()).toBe(aliasRevision);
    },
  );
});
