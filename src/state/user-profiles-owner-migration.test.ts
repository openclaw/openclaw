import { existsSync } from "node:fs";
import { expect, it } from "vitest";
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
const identity = "user_profile_identities WHERE provider = 'gateway.local'";
function expectState(state: ReturnType<typeof profileState>, revision: number) {
  expect(profileState(options)).toEqual(state);
  expect(readRevision()).toBe(revision);
}

it.each(["tombstone", "person", "missing"])("repairs owner once (%s)", async (target) => {
  const owner = ensureOwner("Local Owner", options);
  const person = mergeOwnerIntoPerson(owner.id, options);
  github(10, "person", { email: "person@example.test" });
  const db = openDatabase(options).db;
  if (target === "person") {
    db.prepare(
      `UPDATE user_profile_identities SET profile_id = ? WHERE provider = 'gateway.local'`,
    ).run(person.id);
  } else if (target === "missing") {
    db.prepare(`DELETE FROM ${identity}`).run();
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
  expectState(before, aliasRevision);
  expect(() =>
    transaction(() => {
      expect(repair(true).repaired).toBe(true);
      expect(readRevision()).toBe(aliasRevision);
      throw new Error("rollback owner repair");
    }, options),
  ).toThrow("rollback owner repair");
  expectState(before, aliasRevision);
  expect(repair(true)).toMatchObject({
    repaired: true,
    changes: [expect.stringContaining("gateway-owner")],
    warnings: [],
  });
  expect(readAliases(owner.id, options)).toEqual(new Set([owner.id]));
  expect(readRevision()).toBe(aliasRevision + 1);
  expect(readAliases(person.id, options)).toEqual(new Set([person.id]));
  const restored = ensureOwner("Host Renamed", options);
  expect(restored).toMatchObject({ id: owner.id, mergedInto: null, displayName: "Local Owner" });
  expect(restored.updatedAt).toBeGreaterThan(1);
  expect(readProfile(person.id)).toEqual(personBefore);
  expect(db.prepare(`SELECT profile_id FROM ${identity} AND subject = 'owner'`).get()).toEqual({
    profile_id: owner.id,
  });
  const repairedState = profileState(options);
  expect(repair(true)).toEqual(unchanged);
  expect(readRevision()).toBe(aliasRevision + 1);
  closeDatabase();
  expect(profileState(options)).toEqual(repairedState);
});

it.each([false, true])("preserves legacy owner unless merged (%s)", (merged) => {
  const legacy = ensureProvider({ login: "legacy@other" }, options);
  if (merged) {
    mergeOwnerIntoPerson(legacy.id, options);
  }
  const db = openDatabase(options).db;
  db.prepare(
    "INSERT INTO user_profile_identities (provider, subject, profile_id, created_at) VALUES ('gateway.local', 'owner', ?, 1)",
  ).run(legacy.id);
  const before = profileState(options);
  const mergedInto = readProfile(legacy.id)?.mergedInto;
  const aliasRevision = readRevision();
  expect(repair(true).repaired).toBe(merged);
  if (!merged) {
    expect(profileState(options)).toEqual(before);
  } else {
    expect(readProfile(legacy.id)?.mergedInto).toEqual(mergedInto);
  }
  expect(ensureOwner("Local Owner", options).id).toBe(merged ? "gateway-owner" : legacy.id);
  expect(readRevision()).toBe(aliasRevision);
});

it.each([false, true])("does not create unused profile state (fix: %s)", (shouldRepair) => {
  const aliasRevision = readRevision();
  expect(repair(shouldRepair)).toEqual(unchanged);
  expect(existsSync(options.path)).toBe(false);
  expect(readRevision()).toBe(aliasRevision);
});
