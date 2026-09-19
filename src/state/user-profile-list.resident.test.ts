import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqliteQueries from "../infra/kysely-sync.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPath } from "./openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { onUserProfilesChanged } from "./user-profile-events.js";
import {
  getUserProfileDisplay,
  getUserProfileDisplays,
  readUserProfileAliases,
  readUserProfileIdentity,
  resolveUserProfileReference,
  retainUserProfileCatalog,
  retainUserProfilePublication,
} from "./user-profile-list.js";
import { selectProfileDisplayEntries } from "./user-profiles-internal.js";
import { writeUserProfileRole } from "./user-profiles-role.kernel.js";
import {
  ensureProfileForEmail,
  linkEmail,
  setAvatar,
  setDisplayName,
  syncGitHubIdentity,
} from "./user-profiles.js";
import { seedUserProfileRole } from "./user-profiles.test-support.js";

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

function publicationFixture(resident = true) {
  const options = fixture();
  const profile = ensureProfileForEmail("publication@example.test", options);
  const { db } = openOpenClawStateDatabase(options);
  const identity = readDatabasePathIdentitySync(options.path);
  const stored = () => selectProfileDisplayEntries(db, [profile.id])[0]?.[1];
  const original = stored()!;
  if (resident) {
    releases.push(retainUserProfileCatalog(options));
  }
  const commit = (
    role: string | null,
    settled: Promise<SqliteWorkerOperationSettlement> = Promise.resolve({ kind: "completed" }),
  ) =>
    runOpenClawStateWriteTransaction(() => {
      const publication = retainUserProfilePublication(identity, stored()!, settled);
      releases.push(publication.release);
      // Model admitted worker commits whose host receipts are still pending.
      writeUserProfileRole(db, profile.id, role, original.updated_at);
      return { publication, committed: stored()! };
    }, options);
  return { options, profile, db, original, stored, commit };
}

describe("resident profile display and reference catalog", () => {
  it.each(["worker recovery", "repeated worker ABA", "native ABA"] as const)(
    "fences older profile receipts after equal-descriptor %s",
    async (source) => {
      const { options, profile, original, stored, commit } = publicationFixture();
      const first = commit("first");
      const second = commit(source === "repeated worker ABA" ? null : "second");
      const third = commit(source === "repeated worker ABA" ? "second" : null);
      const fourth = source === "repeated worker ABA" ? commit(null) : undefined;
      if (source === "native ABA") {
        // Equal millisecond timestamps must not erase a native publication's custody.
        const clock = vi.spyOn(Date, "now").mockReturnValue(original.updated_at);
        try {
          seedUserProfileRole(profile.id, "native", options);
          seedUserProfileRole(profile.id, null, options);
        } finally {
          clock.mockRestore();
        }
      }
      const prepared = await first.publication.prepareRecoveryRead();
      const recovered = stored();
      expect(recovered).toEqual(original);
      expect(prepared.publish(recovered)).toBe(true);
      expect(readUserProfileIdentity(profile.id, options)?.role).toBeNull();
      second.publication.publishCommitted(second.committed);
      expect(readUserProfileIdentity(profile.id, options)?.role).toBeNull();
      third.publication.publishCommitted(third.committed);
      expect(readUserProfileIdentity(profile.id, options)?.role).toBeNull();
      fourth?.publication.publishCommitted(fourth.committed);
      expect(stored()).toEqual(original);
    },
  );

  it.each(["committed late catalog", "rolled back", "unrelated profile"] as const)(
    "preserves native publication ordering when an edit is %s",
    (scenario) => {
      const { options, profile, original, stored, commit } = publicationFixture(
        scenario !== "committed late catalog",
      );
      const first = commit("first");
      const clock = vi.spyOn(Date, "now").mockReturnValue(original.updated_at);
      try {
        if (scenario === "committed late catalog") {
          seedUserProfileRole(profile.id, "native", options);
          seedUserProfileRole(profile.id, null, options);
          expect(stored()).toEqual(original);
          releases.push(retainUserProfileCatalog(options));
        } else if (scenario === "rolled back") {
          expect(() =>
            runOpenClawStateWriteTransaction(() => {
              seedUserProfileRole(profile.id, "native", options);
              throw new Error("synthetic native rollback");
            }, options),
          ).toThrow("synthetic native rollback");
        } else {
          const other = ensureProfileForEmail("other-publication@example.test", options);
          seedUserProfileRole(other.id, "native", options);
        }
      } finally {
        clock.mockRestore();
      }
      first.publication.publishCommitted(first.committed);
      expect(readUserProfileIdentity(profile.id, options)?.role).toBe(
        scenario === "committed late catalog" ? null : "first",
      );
    },
  );

  it("joins a profile write admitted while recovery awaits earlier native settlement", async () => {
    const { options, profile, stored, commit } = publicationFixture();
    const earlier = createDeferredCore<SqliteWorkerOperationSettlement>();
    const later = createDeferredCore<SqliteWorkerOperationSettlement>();
    const first = commit("first", earlier.promise);
    commit("second", earlier.promise);
    const preparing = first.publication.prepareRecoveryRead();
    const third = commit("third", later.promise);
    earlier.resolve({ kind: "completed" });
    const ready = vi.fn();
    void preparing.then(ready);
    // Drain the ready continuations while the third native outcome remains unresolved.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(ready).not.toHaveBeenCalled();
    expect(readUserProfileIdentity(profile.id, options)?.role).toBeNull();
    later.resolve({ kind: "completed" });
    const prepared = await preparing;
    expect(prepared.publish(stored())).toBe(true);
    first.publication.publishCommitted(first.committed);
    third.publication.publishCommitted(third.committed);
    expect(readUserProfileIdentity(profile.id, options)?.role).toBe("third");
  });

  it.each(["admission", "catalog"] as const)(
    "retries a recovery snapshot after a new %s without publishing stale data",
    async (change) => {
      const { options, profile, stored, commit } = publicationFixture();
      const first = commit("first");
      const prepared = await first.publication.prepareRecoveryRead();
      const snapshot = stored();
      let alias: { path: string } | undefined;
      if (change === "admission") {
        commit("second");
      } else {
        alias = { path: path.join(roots.make("recovery-profile-alias-"), "alias.sqlite") };
        paths.push(alias.path);
        fs.symlinkSync(options.path, alias.path);
        releases.push(retainUserProfileCatalog(alias));
      }
      const seen = vi.fn();
      releases.push(onUserProfilesChanged(seen));
      expect(prepared.publish(snapshot)).toBe(false);
      expect(seen).not.toHaveBeenCalled();
      expect(readUserProfileIdentity(profile.id, options)?.role).toBeNull();
      const fresh = await first.publication.prepareRecoveryRead();
      expect(fresh.publish(stored())).toBe(true);
      expect(readUserProfileIdentity(profile.id, options)?.role).toBe(
        change === "admission" ? "second" : "first",
      );
      if (alias) {
        expect(readUserProfileIdentity(profile.id, alias)?.role).toBe("first");
      }
    },
  );

  it("keeps recovered receipts fenced when their first catalog appears after recovery", async () => {
    const { options, profile, stored, commit } = publicationFixture(false);
    const first = commit("first");
    commit(null);
    const prepared = await first.publication.prepareRecoveryRead();
    expect(prepared.publish(stored())).toBe(true);
    releases.push(retainUserProfileCatalog(options));
    first.publication.publishCommitted(first.committed);
    expect(readUserProfileIdentity(profile.id, options)?.role).toBeNull();
  });

  it("keeps a recovered absent row fenced against an older receipt", async () => {
    const { options, profile, db, stored, commit } = publicationFixture(false);
    const first = commit("first");
    runOpenClawStateWriteTransaction(() => {
      db.prepare("DELETE FROM user_profiles WHERE id = ?").run(profile.id);
    }, options);
    releases.push(retainUserProfileCatalog(options));
    const prepared = await first.publication.prepareRecoveryRead();
    expect(stored()).toBeUndefined();
    expect(prepared.publish(stored())).toBe(true);
    first.publication.publishCommitted(first.committed);
    expect(readUserProfileIdentity(profile.id, options)).toBeUndefined();
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
          seedUserProfileRole(second.id, "rolled-back-role", options);
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
      seedUserProfileRole(first.id, "reader", options);
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
    seedUserProfileRole(person.id, "reader", options);
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
