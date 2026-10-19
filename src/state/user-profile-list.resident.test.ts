import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseByPathAsync,
} from "./openclaw-state-db-cache.js";
import * as stateReads from "./openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { fenceUserProfileMutationAuthority, onUserProfilesChanged } from "./user-profile-events.js";
import * as profiles from "./user-profile-list.js";
import { getUserProfileDisplaysNative } from "./user-profile-list.native.js";
import {
  linkEmail,
  setAvatar,
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "./user-profile-writes.worker.js";
import { migrateLegacyTailscaleProfileIdentities } from "./user-profiles-tailscale-migration.js";
import { ensureProfileForEmail } from "./user-profiles.js";
import { useUserStateFixture } from "./user-state.test-support.js";

const releases: (() => void)[] = [];
const newFixture = useUserStateFixture("resident-profiles-", () => {
  for (const release of releases.splice(0)) {
    release();
  }
});
type Options = ReturnType<typeof newFixture>;
function fixture(filename?: string) {
  const options = newFixture(filename);
  return {
    ...options,
    display: (id: string) => profiles.getUserProfileDisplay(id, options),
    identity: (id: string) => profiles.readResidentUserProfileIdentity(id, options),
    aliases: (id: string) => profiles.readUserProfileAliases(id, options),
    residentAliases: (id: string) => profiles.readResidentUserProfileAliases(id, options),
    access: (id: string) => profiles.captureResidentUserProfileAccess(id, options),
    resolve: (id: string) => profiles.resolveUserProfileReference(id, options),
  };
}

async function prepareIdentity(...args: Parameters<typeof profiles.prepareUserProfileIdentity>) {
  const prepared = await profiles.prepareUserProfileIdentity(...args);
  releases.push(prepared.release);
  return prepared;
}

async function prepareCatalog(options: Options) {
  const catalog = await profiles.prepareUserProfileCatalog(options);
  releases.push(catalog.release);
  return catalog;
}

function syncAccount(options: Options, email: string, accountId: number, login: string) {
  return syncGitHubIdentity(
    {
      identity: { accountId, login },
      authenticationAlias: { kind: "email", email },
    },
    options,
  );
}

const spyOnQueries = (options: Options) =>
  vi.spyOn(openOpenClawStateDatabase(options).db, "prepare");
type CreatedProfiles<Names extends string[]> = {
  [Index in keyof Names]: ReturnType<typeof ensureProfileForEmail>;
};
function createProfiles<Names extends string[]>(
  options: Options,
  ...names: Names
): CreatedProfiles<Names>;
function createProfiles(options: Options, ...names: string[]) {
  return names.map((name) => ensureProfileForEmail(`${name}@example.test`, options));
}
async function replaceStore<Names extends string[]>(
  options: Options,
  ...names: Names
): Promise<CreatedProfiles<Names>>;
async function replaceStore(options: Options, ...names: string[]) {
  await closeOpenClawStateDatabaseByPathAsync(options.path);
  fs.renameSync(options.path, `${options.path}.old`);
  const replacement = fixture();
  const created = createProfiles(replacement, ...names);
  await closeOpenClawStateDatabaseByPathAsync(replacement.path);
  fs.renameSync(replacement.path, options.path);
  return created;
}

describe("resident profile display and reference catalog", () => {
  it("does not join hydration from before a committed profile change", async () => {
    const options = fixture();
    const profile = ensureProfileForEmail("changing@example.test", options);
    const fetched = createDeferredCore();
    const resume = createDeferredCore();
    const execute = stateReads.executeExistingOpenClawStateRead;
    vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementationOnce(
      async (...args) => {
        const reply = await execute(...args);
        fetched.resolve();
        await resume.promise;
        return reply;
      },
    );
    const before = profiles.prepareUserProfileCatalog(options);
    await fetched.promise;
    setUserProfileRole(profile.id, "reader", options);
    const after = profiles.prepareUserProfileCatalog(options);
    resume.resolve();
    const current = await after;
    releases.push(current.release, (await before).release);
    expect(current.readCurrentIdentity(profile.id)?.role).toBe("reader");
  });

  it("never opens native storage from an unprepared runtime read", async () => {
    const options = fixture();
    const profile = ensureProfileForEmail("cold@example.test", options);
    const native = vi.spyOn(stateReads, "withExistingOpenClawStateDatabaseReadOnly");
    const queries = spyOnQueries(options);
    expect(profiles.readUserProfileIdentity(profile.id, options)).toBeUndefined();
    expect(options.aliases(profile.id)).toEqual(new Set([profile.id]));
    expect(profiles.hasMultipleSessionSharingIdentities(options)).toBe(false);
    expect(() => options.display(profile.id)).toThrow("user profile not found");
    expect(native).not.toHaveBeenCalled();
    expect(queries).not.toHaveBeenCalled();

    await prepareCatalog(options);
    expect(options.display(profile.id).displayName).toBe("cold");
    queries.mockClear();
    setDisplayName(profile.id, "Current", options);
    queries.mockClear();
    expect(options.display(profile.id).displayName).toBe("Current");
    expect(queries).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });

  it("prepares first physical admission after a retained absent catalog without native hydration", async () => {
    const options = fixture();
    const absent = await prepareCatalog(options);
    expect(profiles.isUserProfileCatalogReady(options.path)).toBe(true);
    expect(fs.existsSync(options.path)).toBe(false);
    const profile = ensureProfileForEmail("appeared@example.test", options);
    expect(profiles.isUserProfileCatalogReady(options.path)).toBe(false);
    const database = openOpenClawStateDatabase(options);
    await database.walMaintenance.stop();
    const native = vi.spyOn(database.db, "prepare");
    const current = await prepareCatalog(options);
    expect(current.readCurrentIdentity(profile.id)?.profileId).toBe(profile.id);
    expect(options.display(profile.id).displayName).toBe("appeared");
    expect(profiles.isUserProfileCatalogReady(options.path)).toBe(true);
    expect(native).not.toHaveBeenCalled();
    absent.release();
    expect(profiles.isUserProfileCatalogReady(options.path)).toBe(true);
    current.release();
    expect(profiles.isUserProfileCatalogReady(options.path)).toBe(false);
  });

  it("reads current batch identities through merges and refuses unsettled authority without host SQL", async () => {
    const options = fixture();
    const [alias, target] = createProfiles(options, "alias", "target");
    const catalog = await prepareCatalog(options);
    expect(profiles.hasMultipleResidentSessionSharingIdentities(options)).toBe(true);
    const access = options.access(alias.id);
    expect(catalog.readCurrentIdentity(alias.id)?.profileId).toBe(alias.id);
    linkEmail("alias@example.test", target.id, options);
    setUserProfileRole(target.id, "reader", options);
    const admission = captureOpenClawStateWorkerContext(options).admission;
    const native = spyOnQueries(options);
    expect(profiles.readResidentUserProfileId(alias.id, options)).toBe(target.id);
    expect(options.identity(alias.id)?.role).toBe("reader");
    expect(options.residentAliases(target.id)).toEqual(new Set([alias.id, target.id]));
    expect(profiles.getResidentUserProfileDisplay(alias.id, options).id).toBe(target.id);
    expect(profiles.hasMultipleResidentSessionSharingIdentities(options)).toBe(false);
    for (const id of [alias.id, target.id]) {
      expect(catalog.readCurrentIdentity(id)).toEqual({
        profileId: target.id,
        role: "reader",
        githubLogin: null,
        aliases: new Set([alias.id, target.id]),
      });
      const mutation = fenceUserProfileMutationAuthority(admission, {
        profiles: [id],
        identities: [],
        channels: [],
      });
      expect(() => catalog.readCurrentIdentity(alias.id)).toThrow("has not settled");
      expect(() => access.assertCurrent()).toThrow("has not settled");
      expect(() => options.access(alias.id)).toThrow("has not settled");
      mutation.settle(true);
      expect(() => access.assertCurrent()).not.toThrow();
    }
    expect(catalog.readCurrentIdentity("missing")).toBeUndefined();
    catalog.release();
    expect(() => catalog.readCurrentIdentity(target.id)).toThrow("user profile not found");
    expect(native).not.toHaveBeenCalled();
  });

  it.each(["email", "github", "delete"] as const)(
    "invalidates %s bindings without host SQL",
    async (producer) => {
      const options = fixture();
      const email = producer === "delete" ? "source@github" : "source@example.test";
      const first = ensureProfileForEmail(email, options);
      linkEmail("retained@example.test", first.id, options);
      const target = ensureProfileForEmail("target@example.test", options);
      if (producer === "github") {
        syncAccount(options, email, 40, "first-account");
      }
      const prepared = await prepareIdentity(first.id, options);
      const bindings = prepared.emailBindingIds;
      const selected = await prepareIdentity(first.id, options, [email, email]);
      const selectedBindings = selected.emailBindingIds;
      expect(selectedBindings).toHaveLength(1);
      const retained = await prepareIdentity(first.id, options, ["retained@example.test"]);
      const retainedBindings = retained.emailBindingIds;
      if (producer === "email") {
        for (const unavailableEmail of ["missing@example.test", "target@example.test"]) {
          const unavailable = await prepareIdentity(first.id, options, [email, unavailableEmail]);
          expect(() => unavailable.emailBindingIds).toThrow("user profile not found");
          unavailable.release();
        }
      }
      const native = spyOnQueries(options);
      const current = prepared.readCurrentFacts(bindings);
      expect(selected.readCurrentFacts(selectedBindings)).toEqual(current);
      expect(retained.readCurrentFacts(retainedBindings)).toEqual(current);
      const profile = {
        profileId: first.id,
        emails: [email, "retained@example.test"].toSorted(),
        ...(producer === "github" ? { githubAccountIds: [40] } : {}),
        assignedRole: null,
        githubLogin: producer === "github" ? "first-account" : null,
      };
      const summary = { profileId: first.id, assignedRole: null, githubLogin: profile.githubLogin };
      expect(current.profile).toEqual(profile);
      expect(options.access(first.id).readCurrentFacts()).toEqual(current.profile);
      expect(current.aliases).toEqual(new Set([first.id]));
      expect(prepared.readCurrentProfile()).toEqual(summary);
      expect(native).not.toHaveBeenCalled();
      native.mockRestore();
      setDisplayName(first.id, "Cosmetic update", options);
      linkEmail("later@example.test", first.id, options);
      expect(prepared.readCurrentFacts().profile.emails).toEqual(
        [email, "retained@example.test", "later@example.test"].toSorted(),
      );
      linkEmail("later@example.test", target.id, options);
      setUserProfileRole(first.id, "reader", options);
      expect(prepared.readCurrentProfile()).toEqual({ ...summary, assignedRole: "reader" });
      prepared.readCurrentFacts(bindings);
      if (producer === "email") {
        linkEmail(email, target.id, options);
        linkEmail(email, first.id, options);
      } else if (producer === "github") {
        syncAccount(options, email, 41, "second-account");
      } else {
        migrateLegacyTailscaleProfileIdentities(options);
        linkEmail(email, first.id, options);
      }
      const after = spyOnQueries(options);
      expect(prepared.readCurrentFacts().profile).toEqual({
        ...profile,
        emails: (producer === "github"
          ? ["retained@example.test"]
          : [email, "retained@example.test"]
        ).toSorted(),
        assignedRole: "reader",
      });
      expect(() => prepared.readCurrentFacts(bindings)).toThrow("user profile not found");
      expect(() => selected.readCurrentFacts(selectedBindings)).toThrow("user profile not found");
      expect(retained.readCurrentFacts(retainedBindings)).toEqual(prepared.readCurrentFacts());
      expect(after).not.toHaveBeenCalled();
    },
  );

  it.each(["worker", "native"] as const)(
    "retires replaced %s catalogs and hydrates off-thread",
    async (admission) => {
      const options = fixture();
      if (admission === "native") {
        await prepareCatalog(options);
        expect(options.resolve("deadbeef")).toEqual({ ok: true, value: undefined });
        expect(fs.existsSync(options.path)).toBe(false);
      }
      const prior = ensureProfileForEmail("prior@example.test", options);
      const prepared = await prepareIdentity(prior.id, options);
      const access = options.access(prior.id);
      expect(access.readCurrentFacts().profileId).toBe(prior.id);
      expect(options.display(prior.id).displayName).toBe("prior");
      const [current] = await replaceStore(options, "current");
      expect(() => prepared.readCurrentFacts()).toThrow();
      expect(() => prepared.readCurrentProfile()).toThrow();
      const seen = vi.fn(() => profiles.isUserProfileCatalogReady(options.path));
      releases.push(onUserProfilesChanged(seen));
      if (admission === "native") {
        openOpenClawStateDatabase(options);
        expect(seen.mock.results.map((result) => result.value)).toEqual([false]);
      }
      expect(() => access.assertCurrent()).toThrow();
      const next = await prepareIdentity(current.id, options);
      expect(next.emailBindingIds).toEqual([expect.any(String)]);
      expect(next.readCurrentFacts().profile).toEqual({
        profileId: current.id,
        emails: ["current@example.test"],
        assignedRole: null,
        githubLogin: null,
      });
      expect(() => next.readCurrentFacts(next.emailBindingIds)).not.toThrow();
      const missing = await prepareIdentity(prior.id, options);
      expect(() => missing.readCurrentFacts()).toThrow("user profile not found");
      expect(() => missing.readCurrentProfile()).toThrow("user profile not found");
      const native = spyOnQueries(options);
      expect(options.resolve(prior.id)).toEqual({ ok: true, value: undefined });
      expect(options.display(current.id).displayName).toBe("current");
      expect(native).not.toHaveBeenCalled();
    },
  );

  it.each(["email", "github"])(
    "publishes %s merges before observers without SQL",
    async (producer) => {
      const options = fixture();
      const [first, second, third] = createProfiles(options, "first", "second", "third");
      if (producer === "github") {
        syncAccount(options, "second@example.test", 41, "target-profile");
      }
      await prepareCatalog(options);
      const merge = () =>
        producer === "email"
          ? linkEmail("first@example.test", second.id, options)
          : syncAccount(options, "first@example.test", 41, "target-profile");
      const seen = vi.fn(() => options.residentAliases(second.id));
      releases.push(sessionChanges.subscribe(seen));
      expect(() =>
        runOpenClawStateWriteTransaction(() => {
          merge();
          setDisplayName(second.id, "Rolled back", options);
          setUserProfileRole(second.id, "rolled-back-role", options);
          expect(options.identity(second.id)?.role).toBeNull();
          expect(options.display(first.id).id).toBe(first.id);
          expect(seen).not.toHaveBeenCalled();
          throw new Error("rollback");
        }, options),
      ).toThrow("rollback");
      expect(seen).not.toHaveBeenCalled();
      expect(options.identity(second.id)?.role).toBeNull();
      merge();
      expect(seen.mock.results.at(-1)?.value).toEqual(new Set([first.id, second.id]));
      linkEmail("first@example.test", third.id, options);
      linkEmail("second@example.test", third.id, options);
      const head = { ok: true, value: third.id };
      expect(options.resolve(first.id)).toEqual(head);
      setDisplayName(first.id, "Current person", options);
      setUserProfileRole(first.id, "reader", options);
      expect(setAvatar(first.id, new Uint8Array([1, 2]), "image/png", options).ok).toBe(true);
      const native = spyOnQueries(options);
      for (const id of [first.id, second.id, third.id]) {
        expect(options.display(id)).toMatchObject({
          id: third.id,
          displayName: "Current person",
          hasAvatar: true,
          avatarRevision: expect.stringMatching(/-png$/),
        });
        expect(options.identity(id)).toMatchObject({
          profileId: third.id,
          role: "reader",
        });
        expect(options.resolve(id)).toEqual(head);
        expect(options.resolve(id.replaceAll("-", ""))).toEqual(head);
        expect(options.aliases(id)).toContain(first.id);
      }
      expect(native).not.toHaveBeenCalled();
    },
  );

  it("keeps native display reads bounded for one-hop aliases and text keys without creating missing storage", () => {
    const options = fixture();
    expect(getUserProfileDisplaysNative(["missing"], options).size).toBe(0);
    expect(fs.existsSync(options.path)).toBe(false);
    const [target, alias] = createProfiles(options, "target", "alias");
    linkEmail("alias@example.test", target.id, options);
    const dangling = ensureProfileForEmail("dangling@example.test", options);
    const { db } = openOpenClawStateDatabase(options);
    db.prepare("UPDATE user_profiles SET merged_into = ? WHERE id = ?").run("missing", dangling.id);
    db.prepare("UPDATE user_profiles SET created_at = ? WHERE id = ?").run(
      9223372036854775807n,
      target.id,
    );
    const boundId = "text-\ufffd\0suffix";
    const requestedId = "text-\ud800\0suffix";
    db.prepare(
      "INSERT INTO user_profiles (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run(boundId, "Native text", 1, 1);
    const ids = [alias.id, dangling.id, requestedId, "missing"];
    const displays = getUserProfileDisplaysNative(ids, options);
    expect(displays.size).toBe(3);
    expect(displays.get(alias.id)).toMatchObject({ id: target.id, displayName: "target" });
    expect(displays.get(dangling.id)).toMatchObject({ id: dangling.id, displayName: "dangling" });
    expect(displays.get(requestedId)).toMatchObject({ id: boundId, displayName: "Native text" });

    const nonStrictOptions = fixture();
    const nonStrictDb = openOpenClawStateDatabase(nonStrictOptions).db;
    nonStrictDb.exec(`
      CREATE TABLE user_profiles (
        id TEXT PRIMARY KEY, display_name TEXT, avatar BLOB, avatar_mime TEXT,
        avatar_sha256 TEXT, merged_into TEXT, updated_at INTEGER
      );
    `);
    const blobId = new Uint8Array([1, 2, 3]);
    const insert = nonStrictDb.prepare(
      "INSERT INTO user_profiles (id, display_name, merged_into, updated_at) VALUES (?, ?, ?, 1)",
    );
    insert.run(blobId, "Native BLOB target", null);
    insert.run("blob-alias", "Alias", blobId);
    expect(
      getUserProfileDisplaysNative(["blob-alias"], nonStrictOptions).get("blob-alias"),
    ).toMatchObject({ displayName: "Native BLOB target" });
  });

  it("keeps dormant ambiguity and exact-ID precedence inside the allowed visibility scope", async () => {
    const options = fixture();
    const visible = ensureProfileForEmail("visible@example.test", options);
    const prefix = visible.id.slice(0, 8);
    const dormant = `${prefix}-ffff-ffff-ffff-ffffffffffff`;
    const { db } = openOpenClawStateDatabase(options);
    db.prepare(
      "INSERT INTO user_profiles (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run(dormant, "Dormant person", 1, 1);
    await prepareCatalog(options);
    const native = vi.spyOn(db, "prepare");
    expect(options.resolve(prefix)).toEqual({ ok: false, error: "ambiguous" });
    expect(options.resolve(visible.id)).toEqual({ ok: true, value: visible.id });
    expect(
      profiles.resolveUserProfileReference(prefix, {
        ...options,
        allowedProfileIds: new Set([visible.id]),
      }),
    ).toEqual({ ok: true, value: visible.id });
    expect(native).not.toHaveBeenCalled();
  });

  it("tracks committed changes in every database already open before catalog admission", async () => {
    const firstOptions = fixture();
    const secondOptions = fixture();
    const first = ensureProfileForEmail("first-open@example.test", firstOptions);
    const second = ensureProfileForEmail("second-open@example.test", secondOptions);
    const target = ensureProfileForEmail("merge-target@example.test", secondOptions);
    await prepareCatalog(firstOptions);
    await prepareCatalog(secondOptions);
    const seen = vi.fn(() => secondOptions.display(second.id));
    releases.push(onUserProfilesChanged(seen));
    setDisplayName(first.id, "First current", firstOptions);
    linkEmail("second-open@example.test", target.id, secondOptions);
    setDisplayName(second.id, "Second current", secondOptions);
    expect(seen.mock.results.at(-1)?.value).toMatchObject({
      id: target.id,
      displayName: "Second current",
    });

    const nativeReads = [firstOptions, secondOptions].map(spyOnQueries);
    expect(firstOptions.display(first.id).displayName).toBe("First current");
    expect(secondOptions.display(second.id)).toMatchObject({
      id: target.id,
      displayName: "Second current",
    });
    expect(secondOptions.aliases(second.id)).toEqual(new Set([second.id, target.id]));
    for (const native of nativeReads) {
      expect(native).not.toHaveBeenCalled();
    }
  });

  it("shares one hydration per database across concurrent symlink and canonical readers", async () => {
    const canonical = fixture();
    const [source, target] = createProfiles(canonical, "alias-source", "alias-target");
    setUserProfileRole(source.id, "reader", canonical);
    closeOpenClawStateDatabaseByPath(canonical.path);
    const alias = fixture("alias.sqlite");
    fs.symlinkSync(canonical.path, alias.path);
    const other = fixture();
    const privateProfile = ensureProfileForEmail("private@example.test", other);
    const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const readers = await Promise.all(
      Array.from({ length: 50 }, (_, index) => [
        profiles.prepareUserProfileCatalog(index % 2 ? alias : canonical),
        profiles.prepareUserProfileCatalog(other),
      ]).flat(),
    );
    releases.push(...readers.map((reader) => reader.release));
    for (const [index, reader] of readers.entries()) {
      expect(reader.readCurrentIdentity(source.id)?.profileId).toBe(
        index % 2 ? undefined : source.id,
      );
      expect(reader.readCurrentIdentity(privateProfile.id)?.profileId).toBe(
        index % 2 ? privateProfile.id : undefined,
      );
    }
    const { release } = await prepareCatalog(canonical);
    release();
    release();
    expect(reads.mock.calls.map(([, command]) => command.type)).toEqual([
      "userProfiles.catalog",
      "userProfiles.catalog",
    ]);
    reads.mockClear();
    const { db } = openOpenClawStateDatabase(canonical);
    expect(reads).not.toHaveBeenCalled();
    const reopened = vi.spyOn(db, "prepare");
    expect(canonical.display(source.id).displayName).toBe("alias-source");
    expect(canonical.identity(source.id)?.role).toBe("reader");
    expect(reopened).not.toHaveBeenCalled();
    reopened.mockRestore();
    setDisplayName(source.id, "Through alias", alias);
    expect(alias.display(source.id).displayName).toBe("Through alias");
    expect(canonical.display(source.id).displayName).toBe("Through alias");
    linkEmail("alias-source@example.test", target.id, canonical);
    setDisplayName(source.id, "Through canonical", canonical);
    expect(reads).not.toHaveBeenCalled();
    reads.mockClear();
    const native = spyOnQueries(canonical);
    for (const options of [alias, canonical]) {
      expect(options.display(source.id)).toMatchObject({
        id: target.id,
        displayName: "Through canonical",
      });
      expect(options.resolve(source.id)).toEqual({ ok: true, value: target.id });
      expect(options.aliases(source.id)).toEqual(new Set([source.id, target.id]));
      expect(options.residentAliases(source.id)).toEqual(new Set([source.id, target.id]));
    }
    expect(reads).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
    native.mockRestore();

    const oldIdentity = await prepareIdentity(target.id, alias);
    await closeOpenClawStateDatabaseByPathAsync(alias.path);
    const [nextSource, nextTarget] = await replaceStore(canonical, "next-source", "next-target");
    openOpenClawStateDatabase(canonical);
    expect(() => oldIdentity.readCurrentFacts()).toThrow();
    reads.mockClear();
    await prepareCatalog(canonical);
    await prepareCatalog(alias);
    expect(reads.mock.calls.map(([, command]) => command.type)).toEqual(["userProfiles.catalog"]);
    reads.mockClear();
    linkEmail("next-source@example.test", nextTarget.id, canonical);
    setDisplayName(nextSource.id, "Replacement person", canonical);
    setUserProfileRole(nextTarget.id, "reader", alias);
    const currentNative = spyOnQueries(canonical);
    for (const options of [canonical, alias]) {
      expect(options.display(nextSource.id)).toMatchObject({
        id: nextTarget.id,
        displayName: "Replacement person",
      });
      expect(options.identity(nextSource.id)).toMatchObject({
        profileId: nextTarget.id,
        role: "reader",
        aliases: new Set([nextSource.id, nextTarget.id]),
      });
      expect(options.access(nextSource.id).readCurrentFacts()).toMatchObject({
        profileId: nextTarget.id,
        emails: ["next-source@example.test", "next-target@example.test"],
      });
    }
    expect(reads).not.toHaveBeenCalled();
    expect(currentNative).not.toHaveBeenCalled();
  });
});
