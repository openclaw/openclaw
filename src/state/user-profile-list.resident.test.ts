import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
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
import {
  getUserProfileDisplay,
  getUserProfileDisplays,
  prepareUserProfileCatalog,
  prepareUserProfileIdentity,
  readUserProfileAliases,
  readUserProfileIdentity,
  readResidentUserProfileAliases,
  captureResidentUserProfileAccess,
  isUserProfileCatalogReady,
  resolveUserProfileReference,
} from "./user-profile-list.js";
import {
  linkEmail,
  setAvatar,
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "./user-profile-writes.worker.js";
import { migrateLegacyTailscaleProfileIdentities } from "./user-profiles-tailscale-migration.js";
import { ensureProfileForEmail } from "./user-profiles.js";

const roots = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    for (const release of releases.splice(0)) {
      release();
    }
    vi.restoreAllMocks();
    for (const pathname of paths.splice(0)) {
      closeOpenClawStateDatabaseByPath(pathname);
    }
    cleanup();
  });
});
const paths: string[] = [];
const releases: (() => void)[] = [];
function fixture() {
  const pathname = path.join(roots.make("resident-profiles-"), "openclaw.sqlite");
  paths.push(pathname);
  return { path: pathname };
}

describe("resident profile display and reference catalog", () => {
  it("prepares first physical admission after a retained absent catalog without native hydration", async () => {
    const options = fixture();
    const absent = await prepareUserProfileCatalog(options);
    releases.push(absent.release);
    expect(isUserProfileCatalogReady(options)).toBe(true);
    expect(fs.existsSync(options.path)).toBe(false);
    const profile = ensureProfileForEmail("appeared@example.test", options);
    expect(isUserProfileCatalogReady(options)).toBe(false);
    const database = openOpenClawStateDatabase(options);
    await database.walMaintenance.stop();
    const native = vi.spyOn(database.db, "prepare");
    const current = await prepareUserProfileCatalog(options);
    releases.push(current.release);
    expect(current.readCurrentIdentity(profile.id)?.profileId).toBe(profile.id);
    expect(getUserProfileDisplay(profile.id, options).displayName).toBe("appeared");
    expect(isUserProfileCatalogReady(options)).toBe(true);
    expect(native).not.toHaveBeenCalled();
  });

  it("reads current batch identities through merges and refuses unsettled authority without host SQL", async () => {
    const options = fixture();
    const alias = ensureProfileForEmail("alias@example.test", options);
    const target = ensureProfileForEmail("target@example.test", options);
    const catalog = await prepareUserProfileCatalog(options);
    releases.push(catalog.release);
    const access = captureResidentUserProfileAccess(alias.id, options);
    expect(catalog.readCurrentIdentity(alias.id)?.profileId).toBe(alias.id);
    linkEmail("alias@example.test", target.id, options);
    setUserProfileRole(target.id, "reader", options);
    const admission = captureOpenClawStateWorkerContext(options).admission;
    const native = vi.spyOn(openOpenClawStateDatabase(options).db, "prepare");
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
      expect(() => captureResidentUserProfileAccess(alias.id, options)).toThrow("has not settled");
      mutation.settle(true);
      expect(() => access.assertCurrent()).not.toThrow();
    }
    expect(catalog.readCurrentIdentity("missing")).toBeUndefined();
    catalog.release();
    expect(() => catalog.readCurrentIdentity(target.id)).toThrow("user profile not found");
    expect(native).not.toHaveBeenCalled();
  });

  it.each(["email", "github", "delete"] as const)(
    "keeps prepared binding checks current through %s changes without host SQL",
    async (producer) => {
      const options = fixture();
      const email = producer === "delete" ? "source@github" : "source@example.test";
      const first = ensureProfileForEmail(email, options);
      linkEmail("retained@example.test", first.id, options);
      const target = ensureProfileForEmail("target@example.test", options);
      if (producer === "github") {
        syncGitHubIdentity(
          {
            identity: { accountId: 40, login: "first-account" },
            authenticationAlias: { kind: "email", email },
          },
          options,
        );
      }
      const prepared = await prepareUserProfileIdentity(first.id, options);
      releases.push(prepared.release);
      const bindings = prepared.emailBindingIds;
      const selected = await prepareUserProfileIdentity(first.id, options, [email, email]);
      releases.push(selected.release);
      const selectedBindings = selected.emailBindingIds;
      expect(selectedBindings).toHaveLength(1);
      const retained = await prepareUserProfileIdentity(first.id, options, [
        "retained@example.test",
      ]);
      releases.push(retained.release);
      const retainedBindings = retained.emailBindingIds;
      if (producer === "email") {
        for (const unavailableEmail of ["missing@example.test", "target@example.test"]) {
          const unavailable = await prepareUserProfileIdentity(first.id, options, [
            email,
            unavailableEmail,
          ]);
          try {
            expect(() => unavailable.emailBindingIds).toThrow("user profile not found");
          } finally {
            unavailable.release();
          }
        }
      }
      const native = vi.spyOn(openOpenClawStateDatabase(options).db, "prepare");
      const current = prepared.readCurrentFacts(bindings);
      expect(selected.readCurrentFacts(selectedBindings)).toEqual(current);
      expect(retained.readCurrentFacts(retainedBindings)).toEqual(current);
      expect(current.profile).toEqual({
        profileId: first.id,
        emails: [email, "retained@example.test"].toSorted(),
        ...(producer === "github" ? { githubAccountIds: [40] } : {}),
        assignedRole: null,
        githubLogin: producer === "github" ? "first-account" : null,
      });
      expect(captureResidentUserProfileAccess(first.id, options).readCurrentFacts()).toEqual(
        current.profile,
      );
      expect(current.aliases).toEqual(new Set([first.id]));
      expect(prepared.readCurrentProfile()).toEqual({
        profileId: first.id,
        assignedRole: null,
        githubLogin: producer === "github" ? "first-account" : null,
      });
      expect(native).not.toHaveBeenCalled();
      native.mockRestore();
      setDisplayName(first.id, "Cosmetic update", options);
      linkEmail("later@example.test", first.id, options);
      expect(prepared.readCurrentFacts().profile.emails).toEqual(
        [email, "retained@example.test", "later@example.test"].toSorted(),
      );
      linkEmail("later@example.test", target.id, options);
      setUserProfileRole(first.id, "reader", options);
      expect(prepared.readCurrentProfile()).toEqual({
        profileId: first.id,
        assignedRole: "reader",
        githubLogin: producer === "github" ? "first-account" : null,
      });
      prepared.readCurrentFacts(bindings);
      if (producer === "email") {
        linkEmail(email, target.id, options);
        linkEmail(email, first.id, options);
      } else if (producer === "github") {
        syncGitHubIdentity(
          {
            identity: { accountId: 41, login: "second-account" },
            authenticationAlias: { kind: "email", email },
          },
          options,
        );
      } else {
        migrateLegacyTailscaleProfileIdentities(options);
        linkEmail(email, first.id, options);
      }
      const after = vi.spyOn(openOpenClawStateDatabase(options).db, "prepare");
      expect(prepared.readCurrentFacts().profile).toEqual({
        profileId: first.id,
        emails: (producer === "github"
          ? ["retained@example.test"]
          : [email, "retained@example.test"]
        ).toSorted(),
        ...(producer === "github" ? { githubAccountIds: [40] } : {}),
        assignedRole: "reader",
        githubLogin: producer === "github" ? "first-account" : null,
      });
      expect(() => prepared.readCurrentFacts(bindings)).toThrow("user profile not found");
      expect(() => selected.readCurrentFacts(selectedBindings)).toThrow("user profile not found");
      expect(retained.readCurrentFacts(retainedBindings)).toEqual(prepared.readCurrentFacts());
      expect(after).not.toHaveBeenCalled();
    },
  );

  it.each(["worker", "native"] as const)(
    "retires %s catalogs on physical replacement and prepares the new store off-thread",
    async (admission) => {
      const options = fixture();
      if (admission === "native") {
        releases.push((await prepareUserProfileCatalog(options)).release);
        expect(resolveUserProfileReference("deadbeef", options)).toEqual({
          ok: true,
          value: undefined,
        });
        expect(fs.existsSync(options.path)).toBe(false);
      }
      const prior = ensureProfileForEmail("prior@example.test", options);
      const prepared = await prepareUserProfileIdentity(prior.id, options);
      releases.push(prepared.release);
      const access = captureResidentUserProfileAccess(prior.id, options);
      expect(access.readCurrentFacts().profileId).toBe(prior.id);
      expect(getUserProfileDisplay(prior.id, options).displayName).toBe("prior");
      await closeOpenClawStateDatabaseByPathAsync(options.path);
      fs.renameSync(options.path, `${options.path}.old`);
      const replacement = fixture();
      const current = ensureProfileForEmail("current@example.test", replacement);
      await closeOpenClawStateDatabaseByPathAsync(replacement.path);
      fs.renameSync(replacement.path, options.path);
      expect(() => prepared.readCurrentFacts()).toThrow();
      expect(() => prepared.readCurrentProfile()).toThrow();
      const seen = vi.fn(() => isUserProfileCatalogReady(options));
      releases.push(onUserProfilesChanged(seen));
      if (admission === "native") {
        openOpenClawStateDatabase(options);
        expect(seen.mock.results.map((result) => result.value)).toEqual([false]);
      }
      expect(() => access.assertCurrent()).toThrow();
      const next = await prepareUserProfileIdentity(current.id, options);
      releases.push(next.release);
      expect(next.emailBindingIds).toEqual([expect.any(String)]);
      expect(next.readCurrentFacts().profile).toEqual({
        profileId: current.id,
        emails: ["current@example.test"],
        assignedRole: null,
        githubLogin: null,
      });
      expect(() => next.readCurrentFacts(next.emailBindingIds)).not.toThrow();
      const missing = await prepareUserProfileIdentity(prior.id, options);
      releases.push(missing.release);
      expect(() => missing.readCurrentFacts()).toThrow("user profile not found");
      expect(() => missing.readCurrentProfile()).toThrow("user profile not found");
      const native = vi.spyOn(openOpenClawStateDatabase(options).db, "prepare");
      expect(resolveUserProfileReference(prior.id, options)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(getUserProfileDisplay(current.id, options).displayName).toBe("current");
      expect(native).not.toHaveBeenCalled();
    },
  );

  it.each(["email", "github"])(
    "publishes committed %s merge chains and cosmetics before session observers without clean SQL",
    async (producer) => {
      const options = fixture();
      const first = ensureProfileForEmail("first@example.test", options);
      const second = ensureProfileForEmail("second@example.test", options);
      const third = ensureProfileForEmail("third@example.test", options);
      const identity = { accountId: 41, login: "target-profile" };
      if (producer === "github") {
        syncGitHubIdentity(
          { identity, authenticationAlias: { kind: "email", email: "second@example.test" } },
          options,
        );
      }
      releases.push((await prepareUserProfileCatalog(options)).release);
      const merge = () =>
        producer === "email"
          ? linkEmail("first@example.test", second.id, options)
          : syncGitHubIdentity(
              { identity, authenticationAlias: { kind: "email", email: "first@example.test" } },
              options,
            );
      const seen = vi.fn(() => readResidentUserProfileAliases(second.id, options));
      releases.push(sessionChanges.subscribe(seen));
      expect(() =>
        runOpenClawStateWriteTransaction(() => {
          merge();
          setDisplayName(second.id, "Rolled back", options);
          setUserProfileRole(second.id, "rolled-back-role", options);
          expect(readUserProfileIdentity(second.id, options)?.role).toBeNull();
          expect(getUserProfileDisplay(first.id, options).id).toBe(first.id);
          expect(seen).not.toHaveBeenCalled();
          throw new Error("rollback");
        }, options),
      ).toThrow("rollback");
      expect(seen).not.toHaveBeenCalled();
      expect(readUserProfileIdentity(second.id, options)?.role).toBeNull();
      merge();
      expect(seen.mock.results.at(-1)?.value).toEqual(new Set([first.id, second.id]));
      linkEmail("first@example.test", third.id, options);
      linkEmail("second@example.test", third.id, options);
      const head = resolveUserProfileReference(first.id, options);
      expect(head.ok).toBe(true);
      if (!head.ok || !head.value) {
        throw new Error("missing merge head");
      }
      const headProfileId = head.value;
      setDisplayName(first.id, "Current person", options);
      setUserProfileRole(first.id, "reader", options);
      expect(setAvatar(first.id, new Uint8Array([1, 2]), "image/png", options).ok).toBe(true);
      const native = vi.spyOn(openOpenClawStateDatabase(options).db, "prepare");
      for (const id of [first.id, second.id, head.value]) {
        expect(getUserProfileDisplay(id, options)).toMatchObject({
          id: head.value,
          displayName: "Current person",
          hasAvatar: true,
          avatarRevision: expect.stringMatching(/-png$/),
        });
        expect(readUserProfileIdentity(id, options)).toMatchObject({
          profileId: head.value,
          role: "reader",
        });
        expect(resolveUserProfileReference(id, options)).toEqual(head);
        expect(resolveUserProfileReference(id.replaceAll("-", ""), options)).toEqual(head);
        expect(readUserProfileAliases(id, options)).toContain(first.id);
      }
      expect([
        ...getUserProfileDisplays([first.id, second.id, head.value, "missing"], options).values(),
      ]).toEqual(Array.from({ length: 3 }, () => getUserProfileDisplay(headProfileId, options)));
      expect(native).not.toHaveBeenCalled();
    },
  );

  it("reads only display columns for one-hop aliases and native text keys without creating missing storage", () => {
    const options = fixture();
    expect(getUserProfileDisplays(["missing"], options).size).toBe(0);
    expect(fs.existsSync(options.path)).toBe(false);
    const target = ensureProfileForEmail("target@example.test", options);
    const alias = ensureProfileForEmail("alias@example.test", options);
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
    const displays = getUserProfileDisplays(ids, options);
    expect(displays.size).toBe(3);
    for (const id of ids.slice(0, -1)) {
      expect(displays.get(id)).toEqual(getUserProfileDisplay(id, options));
    }
    expect(displays.get(alias.id)?.id).toBe(target.id);
    expect(displays.get(dangling.id)?.id).toBe(dangling.id);
    expect(displays.get(requestedId)?.id).toBe(boundId);

    const nonStrictOptions = fixture();
    const nonStrictDb = openOpenClawStateDatabase(nonStrictOptions).db;
    nonStrictDb.exec(`
      CREATE TABLE user_profiles (
        id TEXT PRIMARY KEY, display_name TEXT, avatar BLOB, avatar_mime TEXT,
        avatar_sha256 TEXT, merged_into TEXT, updated_at INTEGER
      );
    `);
    const blobId = new Uint8Array([1, 2, 3]);
    nonStrictDb
      .prepare(
        "INSERT INTO user_profiles (id, display_name, merged_into, updated_at) VALUES (?, ?, ?, 1)",
      )
      .run(blobId, "Native BLOB target", null);
    nonStrictDb
      .prepare(
        "INSERT INTO user_profiles (id, display_name, merged_into, updated_at) VALUES (?, ?, ?, 1)",
      )
      .run("blob-alias", "Alias", blobId);
    expect(getUserProfileDisplays(["blob-alias"], nonStrictOptions).get("blob-alias")).toEqual(
      getUserProfileDisplay("blob-alias", nonStrictOptions),
    );
    expect(getUserProfileDisplay("blob-alias", nonStrictOptions).displayName).toBe(
      "Native BLOB target",
    );
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
    releases.push((await prepareUserProfileCatalog(options)).release);
    const native = vi.spyOn(db, "prepare");
    expect(resolveUserProfileReference(prefix, options)).toEqual({ ok: false, error: "ambiguous" });
    expect(resolveUserProfileReference(visible.id, options)).toEqual({
      ok: true,
      value: visible.id,
    });
    expect(
      resolveUserProfileReference(prefix, { ...options, allowedProfileIds: new Set([visible.id]) }),
    ).toEqual({ ok: true, value: visible.id });
    expect(native).not.toHaveBeenCalled();
  });

  it("tracks committed changes in every database already open before catalog admission", async () => {
    const firstOptions = fixture();
    const secondOptions = fixture();
    const first = ensureProfileForEmail("first-open@example.test", firstOptions);
    const second = ensureProfileForEmail("second-open@example.test", secondOptions);
    const target = ensureProfileForEmail("merge-target@example.test", secondOptions);
    releases.push(
      (await prepareUserProfileCatalog(firstOptions)).release,
      (await prepareUserProfileCatalog(secondOptions)).release,
    );
    const seen = vi.fn(() => getUserProfileDisplay(second.id, secondOptions));
    releases.push(onUserProfilesChanged(seen));
    setDisplayName(first.id, "First current", firstOptions);
    linkEmail("second-open@example.test", target.id, secondOptions);
    setDisplayName(second.id, "Second current", secondOptions);
    expect(seen.mock.results.at(-1)?.value).toMatchObject({
      id: target.id,
      displayName: "Second current",
    });

    const nativeReads = [firstOptions, secondOptions].map((options) =>
      vi.spyOn(openOpenClawStateDatabase(options).db, "prepare"),
    );
    expect(getUserProfileDisplay(first.id, firstOptions).displayName).toBe("First current");
    expect(getUserProfileDisplay(second.id, secondOptions)).toMatchObject({
      id: target.id,
      displayName: "Second current",
    });
    expect(readUserProfileAliases(second.id, secondOptions)).toEqual(
      new Set([second.id, target.id]),
    );
    for (const native of nativeReads) {
      expect(native).not.toHaveBeenCalled();
    }
  });

  it("shares committed profile facts and one hydration across symlink and canonical locators", async () => {
    const canonical = fixture();
    const source = ensureProfileForEmail("alias-source@example.test", canonical);
    const target = ensureProfileForEmail("alias-target@example.test", canonical);
    setUserProfileRole(source.id, "reader", canonical);
    closeOpenClawStateDatabaseByPath(canonical.path);
    const alias = { path: path.join(roots.make("resident-profile-alias-"), "alias.sqlite") };
    paths.push(alias.path);
    fs.symlinkSync(canonical.path, alias.path);
    const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    releases.push(
      (await prepareUserProfileCatalog(alias)).release,
      (await prepareUserProfileCatalog(canonical)).release,
    );
    const release = (await prepareUserProfileCatalog(canonical)).release;
    releases.push(release);
    release();
    release();
    expect(reads.mock.calls.map(([, command]) => command.type)).toEqual(["userProfiles.catalog"]);
    reads.mockClear();
    const { db } = openOpenClawStateDatabase(canonical);
    expect(reads).not.toHaveBeenCalled();
    const reopened = vi.spyOn(db, "prepare");
    expect(getUserProfileDisplay(source.id, canonical).displayName).toBe("alias-source");
    expect(readUserProfileIdentity(source.id, canonical)?.role).toBe("reader");
    expect(reopened).not.toHaveBeenCalled();
    reopened.mockRestore();
    setDisplayName(source.id, "Through alias", alias);
    expect(getUserProfileDisplay(source.id, alias).displayName).toBe("Through alias");
    expect(getUserProfileDisplay(source.id, canonical).displayName).toBe("Through alias");
    linkEmail("alias-source@example.test", target.id, canonical);
    setDisplayName(source.id, "Through canonical", canonical);
    expect(reads).not.toHaveBeenCalled();
    reads.mockClear();
    const native = vi.spyOn(openOpenClawStateDatabase(canonical).db, "prepare");
    for (const options of [alias, canonical]) {
      expect(getUserProfileDisplay(source.id, options)).toMatchObject({
        id: target.id,
        displayName: "Through canonical",
      });
      expect(resolveUserProfileReference(source.id, options)).toEqual({
        ok: true,
        value: target.id,
      });
      expect(readUserProfileAliases(source.id, options)).toEqual(new Set([source.id, target.id]));
      expect(readResidentUserProfileAliases(source.id, options)).toEqual(
        new Set([source.id, target.id]),
      );
    }
    expect(reads).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
    native.mockRestore();

    const oldIdentity = await prepareUserProfileIdentity(target.id, alias);
    releases.push(oldIdentity.release);
    await closeOpenClawStateDatabaseByPathAsync(alias.path);
    await closeOpenClawStateDatabaseByPathAsync(canonical.path);
    fs.renameSync(canonical.path, `${canonical.path}.old`);
    const replacement = fixture();
    const nextSource = ensureProfileForEmail("next-source@example.test", replacement);
    const nextTarget = ensureProfileForEmail("next-target@example.test", replacement);
    await closeOpenClawStateDatabaseByPathAsync(replacement.path);
    fs.renameSync(replacement.path, canonical.path);
    openOpenClawStateDatabase(canonical);
    expect(() => oldIdentity.readCurrentFacts()).toThrow();
    reads.mockClear();
    releases.push(
      (await prepareUserProfileCatalog(canonical)).release,
      (await prepareUserProfileCatalog(alias)).release,
    );
    expect(reads.mock.calls.map(([, command]) => command.type)).toEqual(["userProfiles.catalog"]);
    reads.mockClear();
    linkEmail("next-source@example.test", nextTarget.id, canonical);
    setDisplayName(nextSource.id, "Replacement person", canonical);
    setUserProfileRole(nextTarget.id, "reader", alias);
    const currentNative = vi.spyOn(openOpenClawStateDatabase(canonical).db, "prepare");
    for (const options of [canonical, alias]) {
      expect(getUserProfileDisplay(nextSource.id, options)).toMatchObject({
        id: nextTarget.id,
        displayName: "Replacement person",
      });
      expect(readUserProfileIdentity(nextSource.id, options)).toMatchObject({
        profileId: nextTarget.id,
        role: "reader",
        aliases: new Set([nextSource.id, nextTarget.id]),
      });
      expect(
        captureResidentUserProfileAccess(nextSource.id, options).readCurrentFacts(),
      ).toMatchObject({
        profileId: nextTarget.id,
        emails: ["next-source@example.test", "next-target@example.test"],
      });
    }
    expect(reads).not.toHaveBeenCalled();
    expect(currentNative).not.toHaveBeenCalled();
  });
});
