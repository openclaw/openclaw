import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { readUserProfileVersion } from "./user-profile-events.js";
import { readUserProfileSnapshotSync } from "./user-profile-identity.read.js";
import {
  linkEmail,
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "./user-profile-writes.worker.js";
import { mergeOwnerIntoPerson, profileState } from "./user-profiles-owner.test-support.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
} from "./user-profiles.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function stateOptions() {
  return { path: join(tempDirs.make("openclaw-user-profiles-owner-"), "openclaw.sqlite") };
}

function fixture() {
  const options = stateOptions();
  const owner = ensureGatewayOwnerProfile("Local Owner", options);
  const db = openOpenClawStateDatabase(options).db;
  return { options, owner, db };
}

function ownerReference(kind: "merged owner" | "tombstone", state: ReturnType<typeof fixture>) {
  if (kind === "merged owner") {
    mergeOwnerIntoPerson(state.owner.id, state.options);
    return state.owner.id;
  }
  state.db
    .prepare(
      "INSERT INTO user_profiles (id, merged_into, created_at, updated_at) VALUES (?, ?, 1, 1)",
    )
    .run("retired-owner-alias", state.owner.id);
  return "retired-owner-alias";
}

function expectUnchanged(
  operation: () => unknown,
  options: ReturnType<typeof fixture>["options"],
  code: "merge" | "role" | "repair-required",
) {
  const before = profileState(options);
  expect(operation).toThrow(expect.objectContaining({ name: "UserProfileOwnerError", code }));
  expect(profileState(options)).toEqual(before);
}

describe("gateway owner profiles", () => {
  it.each(["merged owner", "tombstone"] as const)("rejects linking to the %s", (kind) => {
    const state = fixture();
    const target = ownerReference(kind, state);
    expectUnchanged(
      () => linkEmail("person@example.test", target, state.options),
      state.options,
      "merge",
    );
  });

  it("rejects moving an owner's email to a person", () => {
    const { options, owner, db } = fixture();
    const person = ensureProfileForEmail("person@example.test", options);
    db.prepare(
      "INSERT INTO user_profile_emails (email, profile_id, created_at) VALUES (?, ?, 1)",
    ).run("old-owner@example.test", owner.id);
    expectUnchanged(
      () => linkEmail("old-owner@example.test", person.id, options),
      options,
      "merge",
    );
  });

  it.each(["merged owner", "tombstone"] as const)("rejects assigning a role to the %s", (kind) => {
    const state = fixture();
    const target = ownerReference(kind, state);
    expectUnchanged(
      () => setUserProfileRole(target, "guest", state.options),
      state.options,
      "role",
    );
  });

  it("rejects verified GitHub sign-in through an old merged-owner email", () => {
    const { options, owner, db } = fixture();
    const identity = { accountId: 10, login: "person" };
    syncGitHubIdentity(
      { identity, authenticationAlias: { kind: "github-login", login: "person" } },
      options,
    );
    db.prepare(
      "INSERT INTO user_profile_emails (email, profile_id, created_at) VALUES (?, ?, 1)",
    ).run("old-owner@example.test", owner.id);
    mergeOwnerIntoPerson(owner.id, options);
    expectUnchanged(
      () =>
        syncGitHubIdentity(
          {
            identity,
            authenticationAlias: { kind: "email", email: "old-owner@example.test" },
          },
          options,
        ),
      options,
      "merge",
    );
    expectUnchanged(
      () =>
        ensureProfileForEmail("old-owner@example.test", {
          ...options,
          expectedGitHubAccountId: identity.accountId,
        }),
      options,
      "merge",
    );
  });

  it("rejects personal sign-in through an old merged-owner GitHub identity", () => {
    const { options, owner, db } = fixture();
    db.prepare(
      "INSERT INTO user_profile_identities (provider, subject, profile_id, canonical_login, created_at) VALUES ('github', '10', ?, 'person', 1)",
    ).run(owner.id);
    mergeOwnerIntoPerson(owner.id, options);
    expectUnchanged(
      () =>
        syncGitHubIdentity(
          {
            identity: { accountId: 10, login: "person" },
            authenticationAlias: { kind: "email", email: "person@example.test" },
          },
          options,
        ),
      options,
      "merge",
    );
  });

  it.each(["owner", "identity", "misdirected"])("requires Doctor for a damaged %s", (kind) => {
    const { options, owner, db } = fixture();
    if (kind === "owner") {
      mergeOwnerIntoPerson(owner.id, options);
    } else {
      const legacy = ensureProfileForTailscaleIdentity({ login: "legacy@other" }, options);
      if (kind === "identity") {
        mergeOwnerIntoPerson(legacy.id, options);
      }
      db.prepare(
        "UPDATE user_profile_identities SET profile_id = ? WHERE provider = 'gateway.local'",
      ).run(legacy.id);
    }
    expectUnchanged(
      () => ensureGatewayOwnerProfile("Host Renamed", options),
      options,
      "repair-required",
    );
    expect(() => ensureGatewayOwnerProfile("Host Renamed", options)).toThrow(
      "openclaw doctor --fix",
    );
  });

  it("keeps one email-less owner and its edits across database reopen", () => {
    const { options, owner } = fixture();
    expect(ensureGatewayOwnerProfile("Host Renamed", options)).toEqual(owner);
    setDisplayName(owner.id, "User Chosen", options);
    closeOpenClawStateDatabaseForTest();
    ensureGatewayOwnerProfile("Host Renamed", options);
    expect(readUserProfileSnapshotSync(options).profiles).toEqual([
      expect.objectContaining({ id: "gateway-owner", emails: [], displayName: "User Chosen" }),
    ]);
    const reopened = openOpenClawStateDatabase(options).db;
    reopened.prepare("DELETE FROM user_profile_identities WHERE provider = 'gateway.local'").run();
    expect(ensureGatewayOwnerProfile(null, options).id).toBe(owner.id);
  });

  it("publishes a new owner only after the outer transaction commits", () => {
    const options = stateOptions();
    ensureProfileForEmail("person@example.test", options);
    const version = readUserProfileVersion();
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        ensureGatewayOwnerProfile("Local Owner", options);
        expect(readUserProfileVersion()).toBe(version);
        throw new Error("rollback owner");
      }, options),
    ).toThrow("rollback owner");
    expect(readUserProfileVersion()).toBe(version);
    expect(
      readUserProfileSnapshotSync(options).profiles.some(
        (profile) => profile.id === "gateway-owner",
      ),
    ).toBe(false);
    runOpenClawStateWriteTransaction(() => {
      ensureGatewayOwnerProfile("Local Owner", options);
      expect(readUserProfileVersion()).toBe(version);
    }, options);
    expect(readUserProfileVersion()).toBe(version + 1);
  });

  it.each(["owner@gateway", "owner@gateway.local"])(
    "keeps the gateway owner separate from Tailscale login %s",
    (login) => {
      const { options, owner } = fixture();
      const external = ensureProfileForTailscaleIdentity({ login, name: "External User" }, options);
      expect(external.id).not.toBe(owner.id);
      expect(ensureGatewayOwnerProfile(null, options)).toEqual(owner);
    },
  );

  it("leaves an unavailable owner name unset and bounds a later seed", () => {
    const options = stateOptions();
    const owner = ensureGatewayOwnerProfile(null, options);
    expect(owner.displayName).toBeNull();
    expect(ensureGatewayOwnerProfile(" \t ", options)).toEqual(owner);
    expect(ensureGatewayOwnerProfile(`${"a".repeat(255)}🤖`, options)).toMatchObject({
      id: owner.id,
      displayName: "a".repeat(255),
    });
  });
});
