import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqliteQueries from "../infra/kysely-sync.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseByPathAsync,
} from "./openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { onUserProfilesChanged } from "./user-profile-events.js";
import {
  getUserProfileDisplay,
  getUserProfileDisplays,
  prepareUserProfileIdentity,
  readUserProfileAliases,
  readUserProfileIdentity,
  resolveUserProfileReference,
  retainUserProfileCatalog,
} from "./user-profile-list.js";
import { migrateLegacyTailscaleProfileIdentities } from "./user-profiles-tailscale-migration.js";
import {
  ensureProfileForEmail,
  linkEmail,
  setAvatar,
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "./user-profiles.js";

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
      const native = vi.spyOn(openOpenClawStateDatabase(options).db, "prepare");
      const current = prepared.readCurrentFacts(bindings);
      expect(current.profile).toEqual({
        profileId: first.id,
        emails: [email, "retained@example.test"].toSorted(),
        assignedRole: null,
      });
      expect(current.aliases).toEqual(new Set([first.id]));
      expect(native).not.toHaveBeenCalled();
      native.mockRestore();
      setDisplayName(first.id, "Cosmetic update", options);
      linkEmail("later@example.test", first.id, options);
      expect(prepared.readCurrentFacts().profile.emails).toEqual(
        [email, "retained@example.test", "later@example.test"].toSorted(),
      );
      linkEmail("later@example.test", target.id, options);
      setUserProfileRole(first.id, "reader", options);
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
        assignedRole: "reader",
      });
      expect(() => prepared.readCurrentFacts(bindings)).toThrow("user profile not found");
      expect(after).not.toHaveBeenCalled();
    },
  );

  it("refuses an old prepared identity after physical replacement and prepares the new store off-thread", async () => {
    const options = fixture();
    const prior = ensureProfileForEmail("prior@example.test", options);
    const prepared = await prepareUserProfileIdentity(prior.id, options);
    releases.push(prepared.release);
    await closeOpenClawStateDatabaseByPathAsync(options.path);
    fs.renameSync(options.path, `${options.path}.old`);
    const replacement = fixture();
    const current = ensureProfileForEmail("current@example.test", replacement);
    await closeOpenClawStateDatabaseByPathAsync(replacement.path);
    fs.renameSync(replacement.path, options.path);
    expect(() => prepared.readCurrentFacts()).toThrow();
    const next = await prepareUserProfileIdentity(current.id, options);
    releases.push(next.release);
    expect(next.emailBindingIds).toEqual([expect.any(String)]);
    expect(next.readCurrentFacts().profile).toEqual({
      profileId: current.id,
      emails: ["current@example.test"],
      assignedRole: null,
    });
    expect(() => next.readCurrentFacts(next.emailBindingIds)).not.toThrow();
    const missing = await prepareUserProfileIdentity(prior.id, options);
    releases.push(missing.release);
    expect(() => missing.readCurrentFacts()).toThrow("user profile not found");
  });

  it.each(["email", "github"])(
    "publishes committed %s merge chains and cosmetics before session observers without clean SQL",
    (producer) => {
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
      releases.push(retainUserProfileCatalog(options));
      const merge = () =>
        producer === "email"
          ? linkEmail("first@example.test", second.id, options)
          : syncGitHubIdentity(
              { identity, authenticationAlias: { kind: "email", email: "first@example.test" } },
              options,
            );
      const seen = vi.fn(() => readUserProfileAliases(second.id, options));
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

  it("keeps dormant ambiguity and exact-ID precedence inside the allowed visibility scope", () => {
    const options = fixture();
    const visible = ensureProfileForEmail("visible@example.test", options);
    const prefix = visible.id.slice(0, 8);
    const dormant = `${prefix}-ffff-ffff-ffff-ffffffffffff`;
    const { db } = openOpenClawStateDatabase(options);
    db.prepare(
      "INSERT INTO user_profiles (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run(dormant, "Dormant person", 1, 1);
    releases.push(retainUserProfileCatalog(options));
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

  it("shares one physical-store admission across readers and a later writer handle", () => {
    const options = fixture();
    const person = ensureProfileForEmail("reader@example.test", options);
    setUserProfileRole(person.id, "reader", options);
    closeOpenClawStateDatabaseByPath(options.path);
    const release = retainUserProfileCatalog(options);
    releases.push(release, retainUserProfileCatalog(options));
    release();
    release();
    // Ordinary writer reopen must reuse the already hydrated physical database.
    const reads = vi.spyOn(sqliteQueries, "executeSqliteQuerySync");
    const { db } = openOpenClawStateDatabase(options);
    expect(
      reads.mock.calls
        .map(([, query]) => query.compile().sql)
        .filter((sql) => sql.includes('from "user_profiles"')),
    ).toEqual([]);
    const native = vi.spyOn(db, "prepare");
    expect(getUserProfileDisplay(person.id, options).displayName).toBe("reader");
    expect(readUserProfileIdentity(person.id, options)?.role).toBe("reader");
    expect(native).not.toHaveBeenCalled();
    native.mockRestore();
    setDisplayName(person.id, "Current reader", options);
    expect(getUserProfileDisplay(person.id, options).displayName).toBe("Current reader");
  });

  it("tracks committed changes in every database already open before catalog admission", () => {
    const firstOptions = fixture();
    const secondOptions = fixture();
    const first = ensureProfileForEmail("first-open@example.test", firstOptions);
    const second = ensureProfileForEmail("second-open@example.test", secondOptions);
    const target = ensureProfileForEmail("merge-target@example.test", secondOptions);
    releases.push(retainUserProfileCatalog(firstOptions), retainUserProfileCatalog(secondOptions));
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

  it("shares committed profile facts and one hydration across symlink and canonical locators", () => {
    const canonical = fixture();
    const source = ensureProfileForEmail("alias-source@example.test", canonical);
    const target = ensureProfileForEmail("alias-target@example.test", canonical);
    closeOpenClawStateDatabaseByPath(canonical.path);
    const alias = { path: path.join(roots.make("resident-profile-alias-"), "alias.sqlite") };
    paths.push(alias.path);
    fs.symlinkSync(canonical.path, alias.path);
    const reads = vi.spyOn(sqliteQueries, "executeSqliteQuerySync");
    releases.push(retainUserProfileCatalog(alias), retainUserProfileCatalog(canonical));
    setDisplayName(source.id, "Through alias", alias);
    expect(getUserProfileDisplay(source.id, alias).displayName).toBe("Through alias");
    expect(getUserProfileDisplay(source.id, canonical).displayName).toBe("Through alias");
    linkEmail("alias-source@example.test", target.id, canonical);
    setDisplayName(source.id, "Through canonical", canonical);
    const scans = reads.mock.calls
      .map(([, query]) => query.compile().sql)
      .filter((sql) => sql.includes('from "user_profiles"') && !sql.includes("where"));
    expect(scans).toHaveLength(1);
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
    }
    expect(reads).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });

  it("does not create missing storage and admits a replacement without retaining old profiles", () => {
    const options = fixture();
    releases.push(retainUserProfileCatalog(options));
    expect(resolveUserProfileReference("deadbeef", options)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(fs.existsSync(options.path)).toBe(false);
    const prior = ensureProfileForEmail("prior@example.test", options);
    expect(getUserProfileDisplay(prior.id, options).displayName).toBe("prior");
    closeOpenClawStateDatabaseByPath(options.path);
    fs.renameSync(options.path, `${options.path}.old`);
    const replacement = fixture();
    const current = ensureProfileForEmail("current@example.test", replacement);
    closeOpenClawStateDatabaseByPath(replacement.path);
    fs.renameSync(replacement.path, options.path);
    const seen = vi.fn(() => getUserProfileDisplay(current.id, options).displayName);
    releases.push(onUserProfilesChanged(seen));
    openOpenClawStateDatabase(options);
    expect(seen.mock.results.map((result) => result.value)).toEqual(["current"]);
    const native = vi.spyOn(openOpenClawStateDatabase(options).db, "prepare");
    expect(resolveUserProfileReference(prior.id, options)).toEqual({ ok: true, value: undefined });
    expect(getUserProfileDisplay(current.id, options).displayName).toBe("current");
    expect(native).not.toHaveBeenCalled();
  });
});
