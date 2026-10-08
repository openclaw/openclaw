import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { constants } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { admitSqliteSchema, runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { createDeferredCore } from "../shared/deferred.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import * as stateDatabase from "./openclaw-state-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { getUserPreferences, setUserPreferences } from "./user-preferences.test-support.js";
import { onUserProfilesChanged, readUserProfileVersion } from "./user-profile-events.js";
import { readUserProfileSnapshotSync } from "./user-profile-identity.read.js";
import {
  linkEmail,
  setAvatar,
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "./user-profile-writes.worker.js";
import { getProfileAvatar } from "./user-profiles-avatar.test-support.js";
import {
  inspectProfileAvatarInDatabase,
  selectProfileDisplayEntries,
  selectResolvedUserProfileMetadataById,
} from "./user-profiles-internal.js";
import { migrateLegacyTailscaleProfileIdentities } from "./user-profiles-tailscale-migration.js";
import {
  adoptTailscaleProfileAvatar,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
  getUserProfileDisplay,
  getUserProfileListItem,
  getUserProfileRole,
} from "./user-profiles.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

let options: { path: string };
beforeEach(() => {
  options = { path: join(tempDirs.make("openclaw-user-profiles-"), "openclaw.sqlite") };
});

function github(
  accountId: number,
  login: string,
  fields: { alias?: string; email?: string; name?: string; initialName?: string } = {},
) {
  return syncGitHubIdentity(
    {
      identity: { accountId, login, name: fields.name },
      authenticationAlias:
        fields.email === undefined
          ? { kind: "github-login", login: fields.alias ?? login }
          : { kind: "email", email: fields.email },
      initialDisplayName: fields.initialName,
    },
    options,
  );
}

const avatarUrl = "https://avatars.example.test/profile";
function avatarResponse() {
  const bytes = readFileSync(join(process.cwd(), "ui/public/favicon-32.png"));
  return new Response(Uint8Array.from(bytes).buffer, { headers: { "content-type": "image/png" } });
}

describe("user profiles", () => {
  it("publishes profile changes only after the owning transaction commits", () => {
    const profile = ensureProfileForEmail("publication@example.test", options);
    const changed = vi.fn();
    const stop = onUserProfilesChanged(changed);
    const before = readUserProfileVersion();
    try {
      expect(() =>
        runOpenClawStateWriteTransaction(() => {
          setDisplayName(profile.id, "Rolled back", options);
          expect(changed).not.toHaveBeenCalled();
          throw new Error("rollback");
        }, options),
      ).toThrow("rollback");
      expect(readUserProfileVersion()).toBe(before);
      expect(getUserProfileDisplay(profile.id, options).displayName).not.toBe("Rolled back");
      runOpenClawStateWriteTransaction(() => {
        expect(setDisplayName(profile.id, "Committed", options)).toMatchObject({
          id: profile.id,
          displayName: "Committed",
        });
        expect(changed).not.toHaveBeenCalled();
      }, options);
      expect(changed).toHaveBeenCalledOnce();
      expect(readUserProfileVersion()).toBe(before + 1);
    } finally {
      stop();
    }
  });

  it.each([false, true])(
    "display lookup leaves absent storage absent (database exists: %s)",
    (exists) => {
      const database = exists ? openOpenClawStateDatabase(options).db : undefined;
      expect(() => getUserProfileDisplay("missing-profile", options)).toThrow(
        "user profile not found",
      );
      if (database) {
        expect(tableExists(database, "user_profiles")).toBe(false);
      } else {
        expect(existsSync(options.path)).toBe(false);
      }
    },
  );

  it.each(["email", "provider"])("reuses a %s profile created during writer admission", (kind) => {
    ensureProfileForEmail("schema-ready@example.test", options);
    const ensure =
      kind === "email"
        ? () => ensureProfileForEmail("racing@example.test", options)
        : () => ensureProfileForTailscaleIdentity({ login: "racing@github" }, options);
    const original = stateDatabase.runOpenClawStateWriteTransaction;
    let competing: ReturnType<typeof ensureProfileForEmail> | undefined;
    vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction").mockImplementationOnce(
      (operation, databaseOptions, transactionOptions) => {
        competing = ensure();
        return original(operation, databaseOptions, transactionOptions);
      },
    );
    expect(ensure()).toEqual(competing);
    expect(competing).toBeDefined();
    expect(readUserProfileSnapshotSync(options).profiles).toHaveLength(2);
  });

  it("preserves a custom name saved while waiting to adopt a provider name", () => {
    const profile = ensureProfileForTailscaleIdentity({ login: "racing@github" }, options);
    const original = stateDatabase.runOpenClawStateWriteTransaction;
    vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction").mockImplementationOnce(
      (operation, databaseOptions, transactionOptions) => {
        setDisplayName(profile.id, "User Chosen", options);
        return original(operation, databaseOptions, transactionOptions);
      },
    );
    expect(
      ensureProfileForTailscaleIdentity({ login: "racing@github", name: "Provider Name" }, options),
    ).toMatchObject({ id: profile.id, displayName: "User Chosen" });
  });

  it("publishes a normalized provider subject only once", () => {
    const identity = { login: "ada@github" };
    const profile = ensureProfileForTailscaleIdentity(identity, options);
    const db = openOpenClawStateDatabase(options).db;
    db.prepare("UPDATE user_profile_identities SET subject = ? WHERE provider = ?").run(
      "ada",
      "github",
    );
    const version = readUserProfileVersion();
    expect(ensureProfileForTailscaleIdentity(identity, options)).toEqual(profile);
    expect(readUserProfileVersion()).toBe(version + 1);
    expect(db.prepare("SELECT subject FROM user_profile_identities").all()).toEqual([
      { subject: "login:ada" },
    ]);
    expect(ensureProfileForTailscaleIdentity(identity, options)).toEqual(profile);
    expect(readUserProfileVersion()).toBe(version + 1);
  });

  it("assigns and clears roles through the canonical merge head", () => {
    const source = ensureProfileForEmail("source@example.com", options);
    const target = ensureProfileForEmail("target@example.com", options);
    linkEmail("source@example.com", target.id, options);
    const version = readUserProfileVersion();
    expect(setUserProfileRole(source.id, "maintainer", options)).toMatchObject({
      id: target.id,
      role: "maintainer",
    });
    expect(readUserProfileVersion()).toBe(version + 1);
    expect(getUserProfileRole(source.id, options)).toBe("maintainer");
    expect(readUserProfileSnapshotSync(options).profiles).toContainEqual(
      expect.objectContaining({ id: target.id, role: "maintainer" }),
    );
    const cleared = setUserProfileRole(source.id, null, options);
    expect(readUserProfileVersion()).toBe(version + 2);
    expect(cleared).toMatchObject({ id: target.id });
    expect(cleared).not.toHaveProperty("role");
    expect(getUserProfileRole(target.id, options)).toBeNull();
  });

  it.each(["unadmitted", "admitted", "authorizer"] as const)(
    "preserves metadata and display reads on a %s handle across role schema changes",
    (mode) => {
      const profile = ensureProfileForEmail("reader@example.test", options);
      setUserProfileRole(profile.id, "maintainer", options);
      expect(setAvatar(profile.id, new Uint8Array([1, 2, 3]), "image/png", options).ok).toBe(true);
      const reader = openNodeSqliteDatabase(options.path, { readOnly: true });
      enableNodeSqliteKyselyStatementCache(reader);
      if (mode !== "unadmitted") {
        admitSqliteSchema(reader);
      }
      if (mode === "authorizer") {
        reader.setAuthorizer((action, table, column) =>
          action === constants.SQLITE_READ && table === "user_profiles" && column === "role"
            ? constants.SQLITE_IGNORE
            : constants.SQLITE_OK,
        );
      }
      try {
        const role = mode === "authorizer" ? null : "maintainer";
        expect(selectResolvedUserProfileMetadataById(reader, profile.id)).toMatchObject({
          id: profile.id,
          role,
        });
        expect(selectProfileDisplayEntries(reader, [profile.id])).toMatchObject([
          [
            profile.id,
            { id: profile.id, ...(mode === "authorizer" ? {} : { role }), has_avatar: 1 },
          ],
        ]);
        if (mode === "admitted") {
          expect(inspectProfileAvatarInDatabase(reader, profile.id)).toMatchObject({
            profile: { id: profile.id, role },
            hasAvatar: true,
            avatar: { byteLength: 3 },
          });
        } else {
          expect(() => inspectProfileAvatarInDatabase(reader, profile.id)).toThrow(
            "Profile avatar reads require admitted schema facts",
          );
        }
        openOpenClawStateDatabase(options).db.exec("ALTER TABLE user_profiles DROP COLUMN role");
        runSqliteReadOperationSync(reader, () => {
          expect(selectResolvedUserProfileMetadataById(reader, profile.id)).not.toHaveProperty(
            "role",
          );
          expect(selectProfileDisplayEntries(reader, [profile.id])[0]?.[1]).not.toHaveProperty(
            "role",
          );
          if (mode === "admitted") {
            expect(inspectProfileAvatarInDatabase(reader, profile.id)).toMatchObject({
              profile: { id: profile.id },
              hasAvatar: true,
              avatar: { byteLength: 3 },
            });
          }
        });
      } finally {
        reader.close();
      }
    },
  );

  it("keeps ensured writer projections available when an authorizer denies schema probes and unrelated columns", () => {
    const profile = ensureProfileForEmail("authorized-reader@example.test", options);
    setUserProfileRole(profile.id, "maintainer", options);
    const db = openOpenClawStateDatabase(options).db;
    db.setAuthorizer((action, table, column) =>
      action === constants.SQLITE_PRAGMA ||
      (action === constants.SQLITE_READ &&
        table === "user_profiles" &&
        column === "primary_github_account_id")
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    try {
      expect(selectResolvedUserProfileMetadataById(db, profile.id)).toMatchObject({
        id: profile.id,
        role: "maintainer",
      });
      expect(selectProfileDisplayEntries(db, [profile.id])).toMatchObject([
        [profile.id, { id: profile.id, role: "maintainer" }],
      ]);
    } finally {
      db.setAuthorizer(null);
    }
  });

  it("keeps immutable owners isolated when a numeric GitHub login is renamed and reused", () => {
    const accountA = github(10, "10", { initialName: "Account A" });
    setDisplayName(accountA.id, "Account A Custom", options);
    expect(setAvatar(accountA.id, new Uint8Array([1, 2, 3]), "image/png", options).ok).toBe(true);
    expect(
      setUserPreferences(
        accountA.id,
        { theme: "claw", [GIT_COAUTHOR_PREFERENCE_KEY]: true },
        options,
      ),
    ).toMatchObject({ ok: true });
    const renamed = github(10, "new-login", {
      initialName: "Provider Renamed A",
      name: "GitHub Renamed",
    });
    expect(github(10, "new-login")).toEqual(renamed);
    const accountB = github(20, "10", { initialName: "Account B" });
    expect(renamed.id).toBe(accountA.id);
    expect(accountB).toMatchObject({
      displayName: "Account B",
      githubIdentity: { login: "10" },
      hasAvatar: false,
    });
    expect(accountB.id).not.toBe(accountA.id);
    expect(getUserPreferences(accountB.id, undefined, options)).toEqual({});
    expect(ensureProfileForTailscaleIdentity({ login: "10@github" }, options).id).toBe(accountB.id);
    expect(getUserProfileListItem(accountA.id, options)).toMatchObject({
      displayName: "Account A Custom",
      githubIdentity: { login: "new-login" },
      hasAvatar: true,
    });
    expect(getProfileAvatar(accountA.id, options)?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(getUserPreferences(accountA.id, undefined, options)).toEqual({
      theme: "claw",
      [GIT_COAUTHOR_PREFERENCE_KEY]: true,
    });
  });

  it.each([null, "Ada"])("persists GitHub names on the surviving merge head: %s", (saved) => {
    const target = github(10, "Ada", { alias: "ada" });
    setDisplayName(target.id, saved, options);
    const source = ensureProfileForEmail("alias@example.com", options);
    setDisplayName(source.id, "Source Custom", options);
    const updated = github(10, "Ada", {
      name: "Ada Lovelace",
      email: "alias@example.com",
    });
    expect(updated).toMatchObject({ id: target.id, displayName: "Ada Lovelace" });
    closeOpenClawStateDatabaseForTest();
    expect(getUserProfileDisplay(source.id, options)).toMatchObject({
      id: target.id,
      displayName: "Ada Lovelace",
    });
    expect(ensureProfileForEmail("alias@example.com", options).id).toBe(target.id);
  });

  it("moves a reused Cloudflare email without exposing the prior verified owner", () => {
    const email = "shared@example.test";
    const accountA = github(10, "account-a", { email, initialName: "Account A" });
    setDisplayName(accountA.id, "Account A Custom", options);
    expect(setUserPreferences(accountA.id, { theme: "claw" }, options)).toMatchObject({
      ok: true,
    });
    const accountB = github(20, "account-b", { email, initialName: "Account B" });
    expect(accountB).toMatchObject({
      displayName: "Account B",
      emails: [email],
      githubIdentity: { login: "account-b" },
    });
    expect(accountB.id).not.toBe(accountA.id);
    expect(ensureProfileForEmail(email, options).id).toBe(accountB.id);
    expect(getUserProfileListItem(accountA.id, options)).toMatchObject({
      displayName: "Account A Custom",
      emails: [],
      githubIdentity: { login: "account-a" },
    });
    expect(getUserPreferences(accountA.id, undefined, options)).toEqual({ theme: "claw" });
    expect(getUserPreferences(accountB.id, undefined, options)).toEqual({});
  });

  it("keeps retired GitHub attribution rows inert during verified sync", () => {
    const matching = ensureProfileForTailscaleIdentity({ login: "ada@github" }, options);
    const mismatched = ensureProfileForTailscaleIdentity({ login: "grace@github" }, options);
    const db = openOpenClawStateDatabase(options).db;
    const insert = db.prepare(
      "INSERT INTO user_profile_identities (provider, subject, profile_id, canonical_login, created_at) VALUES ('github-attribution', ?, ?, ?, 1)",
    );
    insert.run("10", matching.id, "ada");
    insert.run("99", mismatched.id, "wrong-account");
    expect(github(10, "ada")).toMatchObject({ githubIdentity: { login: "ada" } });
    github(11, "grace");
    expect(getUserPreferences(matching.id, [GIT_COAUTHOR_PREFERENCE_KEY], options)).toEqual({});
    expect(getUserPreferences(mismatched.id, [GIT_COAUTHOR_PREFERENCE_KEY], options)).toEqual({});
  });

  it("keeps co-author consent with the verified account that survives an email merge", () => {
    const discarded = github(10, "discarded", { email: "discarded@example.com" });
    const established = github(11, "established", { email: "established@example.com" });
    setUserPreferences(discarded.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true }, options);
    expect(
      linkEmail("discarded@example.com", established.id, options).githubIdentity,
    ).toMatchObject({ login: "established" });
    expect(getUserPreferences(established.id, [GIT_COAUTHOR_PREFERENCE_KEY], options)).toEqual({});
    const carrying = github(12, "carrying", { email: "carrying@example.com" });
    const unverified = ensureProfileForEmail("unverified@example.com", options);
    setUserPreferences(carrying.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true }, options);
    expect(linkEmail("carrying@example.com", unverified.id, options).githubIdentity).toMatchObject({
      login: "carrying",
    });
    expect(getUserPreferences(unverified.id, [GIT_COAUTHOR_PREFERENCE_KEY], options)).toEqual({
      [GIT_COAUTHOR_PREFERENCE_KEY]: true,
    });
  });

  it("adopts a Tailscale name into a blank slot and preserves later custom edits", () => {
    const profile = ensureProfileForTailscaleIdentity(
      { login: "ada@github", name: "Ada Provider" },
      options,
    );
    setDisplayName(profile.id, " \t ", options);
    const version = readUserProfileVersion();
    expect(
      ensureProfileForTailscaleIdentity({ login: "ada@github", name: "Ada Adopted" }, options),
    ).toMatchObject({ displayName: "Ada Adopted" });
    expect(readUserProfileVersion()).toBe(version + 1);
    setDisplayName(profile.id, "User Chosen", options);
    expect(
      ensureProfileForTailscaleIdentity({ login: "ada@github", name: "Provider Changed" }, options),
    ).toMatchObject({ displayName: "User Chosen" });
    expect(readUserProfileVersion()).toBe(version + 2);
  });

  it("updates all profiles whose aliases change", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(100);
    const source = ensureProfileForEmail("source@example.com", options);
    now.mockReturnValue(200);
    const target = ensureProfileForEmail("target@example.com", options);
    now.mockReturnValue(300);
    linkEmail("source-alias@example.com", source.id, options);
    now.mockReturnValue(400);
    expect(linkEmail("source@example.com", target.id, options)).toMatchObject({
      id: target.id,
      updatedAt: 400,
      emails: ["source@example.com", "target@example.com"],
    });
    expect(readUserProfileSnapshotSync(options).profiles).toContainEqual(
      expect.objectContaining({
        id: source.id,
        updatedAt: 400,
        emails: ["source-alias@example.com"],
      }),
    );
  });

  it("bounds generated display names without splitting Unicode", () => {
    const profile = ensureProfileForEmail(`${"a".repeat(255)}😀@example.com`, options);
    expect(profile.displayName).toBe("a".repeat(255));
  });

  it("adopts a bounded PNG Tailscale avatar", async () => {
    const initial = ensureProfileForTailscaleIdentity(
      { login: "avatar@github", name: "Avatar User" },
      options,
    );
    const bytes = new Uint8Array(await avatarResponse().arrayBuffer());
    const version = readUserProfileVersion();
    const profile = await adoptTailscaleProfileAvatar(initial.id, avatarUrl, options, {
      fetchImpl: vi.fn(async () => avatarResponse()),
    });
    expect(profile.avatarMime).toBe("image/png");
    expect(readUserProfileVersion()).toBe(version + 1);
    const stored = getProfileAvatar(profile.id, options);
    expect(stored).toMatchObject({
      mime: "image/png",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(stored?.bytes).toEqual(bytes);
  });

  it.each([
    {
      name: "oversized",
      headers: new Headers({
        "content-length": String(512 * 1024 + 1),
        "content-type": "image/png",
      }),
    },
    { name: "wrong-type", headers: new Headers({ "content-type": "text/plain" }) },
  ])("keeps the avatar empty after a $name fetch", async ({ headers }) => {
    const initial = ensureProfileForTailscaleIdentity(
      { login: "avatar-failure@github", name: "Still Authenticated" },
      options,
    );
    const fetchImpl = vi.fn(async () => new Response("not an image", { headers }));
    const profile = await adoptTailscaleProfileAvatar(initial.id, avatarUrl, options, {
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalled();
    expect(profile).toMatchObject({ displayName: "Still Authenticated", avatarMime: null });
    expect(getProfileAvatar(profile.id, options)).toBeUndefined();
  });

  it("preserves a user avatar written while provider bytes are in flight", async () => {
    const entered = createDeferredCore();
    const response = createDeferredCore<Response>();
    const profile = ensureProfileForTailscaleIdentity(
      { login: "avatar-race@github", name: "Race User" },
      options,
    );
    const pending = adoptTailscaleProfileAvatar(profile.id, avatarUrl, options, {
      fetchImpl: vi.fn(async () => {
        entered.resolve();
        return response.promise;
      }),
    });
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Avatar adoption did not enter its fetch");
        }),
      ]);
      expect(setAvatar(profile.id, new Uint8Array([9, 8, 7]), "image/png", options).ok).toBe(true);
      const version = readUserProfileVersion();
      response.resolve(avatarResponse());
      await pending;
      expect(readUserProfileVersion()).toBe(version);
      expect(getProfileAvatar(profile.id, options)?.bytes).toEqual(new Uint8Array([9, 8, 7]));
    } finally {
      response.resolve(new Response("unavailable", { status: 503 }));
      await Promise.allSettled([pending]);
    }
  });

  it("migrates legacy provider logins while preserving profiles and real emails", () => {
    const provider = ensureProfileForEmail("user@github", options);
    const email = ensureProfileForEmail("person@gmail.com", options);
    setDisplayName(provider.id, "User Chosen", options);
    expect(setAvatar(provider.id, new Uint8Array([9, 8, 7]), "image/png", options).ok).toBe(true);
    expect(migrateLegacyTailscaleProfileIdentities(options)).toEqual({
      changes: ["Moved 1 legacy Tailscale provider identity out of user profile email aliases."],
      warnings: [],
    });
    expect(migrateLegacyTailscaleProfileIdentities(options)).toEqual({ changes: [], warnings: [] });
    const db = openOpenClawStateDatabase(options).db;
    expect(
      db.prepare("SELECT provider, subject, profile_id FROM user_profile_identities").all(),
    ).toEqual([{ provider: "github", subject: "login:user", profile_id: provider.id }]);
    expect(db.prepare("SELECT email, profile_id FROM user_profile_emails").all()).toEqual([
      { email: "person@gmail.com", profile_id: email.id },
    ]);
    expect(getUserProfileDisplay(provider.id, options).displayName).toBe("User Chosen");
    expect(getProfileAvatar(provider.id, options)?.bytes).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("rejects oversized and unsupported avatar uploads", () => {
    const profile = ensureProfileForEmail("ada@example.com", options);
    expect(setAvatar(profile.id, new Uint8Array(512 * 1024 + 1), "image/png", options)).toEqual({
      ok: false,
      error: { code: "avatar_too_large", maxBytes: 512 * 1024 },
    });
    expect(setAvatar(profile.id, new Uint8Array([1]), "image/gif", options)).toEqual({
      ok: false,
      error: { code: "unsupported_avatar_mime", mime: "image/gif" },
    });
  });
});
