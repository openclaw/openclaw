import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseByPath } from "./openclaw-state-db-cache.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  onUserProfilesChanged,
  readUserProfileAliasRevision,
  readUserProfileVersion,
} from "./user-profile-events.js";
import { readUserProfileEmailBindings } from "./user-profile-identity.read.js";
import { readUserProfileSnapshotSync } from "./user-profile-list-item.test-support.js";
import { prepareUserProfileCatalog, readUserProfileAliases } from "./user-profile-list.js";
import { linkEmail, setAvatar, setDisplayName } from "./user-profile-writes.worker.js";
import { useProfileDatabase } from "./user-profiles-fixture.test-support.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";
import { migrateLegacyTailscaleProfileIdentities } from "./user-profiles-tailscale-migration.js";
import { ensureProfileForEmail } from "./user-profiles.js";

const { options, tempDirs, hydrate, github } = useProfileDatabase("profile-aliases-");

function bindingIds(profileId: string): string[] {
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

const f = {
  options,
  profile: (email: string) => ensureProfileForEmail(email, options),
  bindings: bindingIds,
  aliases: (id: string) => readUserProfileAliases(id, options),
  link: (email: string, id: string) => linkEmail(email, id, options),
  github: (email: string, identity = { accountId: 123, login: "verified-profile" }) =>
    github(identity.accountId, identity.login, { email }),
  transaction: (operation: () => void) => runOpenClawStateWriteTransaction(operation, options),
  catalog: hydrate,
};

function expectRenewed(actual: string[], retained: string[], retired: string[], added = 1) {
  expect(actual).toHaveLength(retained.length + added);
  expect(actual).toEqual(expect.arrayContaining(retained));
  expect(new Set(actual).size).toBe(actual.length);
  for (const binding of retired) {
    expect(actual).not.toContain(binding);
  }
}

describe("profile alias reader lifecycle", () => {
  it.each(["email", "github"])(
    "publishes committed %s merges, not rollbacks or canonical no-ops",
    async (producer) => {
      const source = f.profile("source@aliases.test");
      const target = f.profile("target@aliases.test");
      if (producer === "github") {
        f.link("source-other@aliases.test", source.id);
        f.github("target@aliases.test");
      }
      const sourceBindings = f.bindings(source.id);
      const targetBindings = f.bindings(target.id);
      await f.catalog();
      const merge = () =>
        producer === "email"
          ? f.link("source@aliases.test", target.id)
          : f.github("source@aliases.test");
      const read = () => f.aliases(target.id);
      expect(read()).toEqual(new Set([target.id]));
      const aliasRevision = readUserProfileAliasRevision();
      const profileVersion = readUserProfileVersion();
      const published = vi.fn(() => ({
        aliases: read(),
        aliasRevision: readUserProfileAliasRevision(),
      }));
      const stop = onUserProfilesChanged(published);
      const expectUnpublished = () => {
        expect(read()).toEqual(new Set([target.id]));
        expect(readUserProfileAliasRevision()).toBe(aliasRevision);
        expect(published).not.toHaveBeenCalled();
      };
      const expectRollback = () => {
        expectUnpublished();
        expect(f.bindings(source.id)).toEqual(sourceBindings);
        expect(f.bindings(target.id)).toEqual(targetBindings);
      };
      const expectPublished = () => {
        expect(published).toHaveBeenCalledOnce();
        expect(readUserProfileAliasRevision()).toBe(aliasRevision + 1);
        expect(readUserProfileVersion()).toBe(profileVersion + 1);
      };
      const rollback = () => {
        merge();
        expectUnpublished();
        throw new Error("rollback");
      };
      try {
        expect(() => f.transaction(rollback)).toThrow("rollback");
        expectRollback();
        f.transaction(() => expect(() => f.transaction(rollback)).toThrow("rollback"));
        expectRollback();
        f.transaction(() => {
          merge();
          expect(read()).toEqual(new Set([target.id]));
          expect(readUserProfileAliasRevision()).toBe(aliasRevision);
        });
        expectPublished();
        expect(published.mock.results[0]?.value).toEqual({
          aliases: new Set([source.id, target.id]),
          aliasRevision: aliasRevision + 1,
        });
        const mergedBindings = f.bindings(target.id);
        expectRenewed(mergedBindings, targetBindings, sourceBindings, sourceBindings.length);
        expect(f.bindings(source.id)).toEqual([]);
        expect(f.link("source@aliases.test", source.id)).toMatchObject({
          id: target.id,
          mergedInto: null,
          emails:
            producer === "github"
              ? ["source-other@aliases.test", "source@aliases.test", "target@aliases.test"]
              : ["source@aliases.test", "target@aliases.test"],
          hasAvatar: false,
        });
        expect(f.profile("source@aliases.test").id).toBe(target.id);
        expect(f.bindings(target.id)).toEqual(mergedBindings);
        expectPublished();
        expect(read()).toEqual(new Set([source.id, target.id]));
        expect(f.aliases(source.id)).toEqual(new Set([source.id, target.id]));
        expect(readUserProfileSnapshotSync(f.options).profiles).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: source.id, mergedInto: target.id, emails: [] }),
            expect.objectContaining({ id: target.id, mergedInto: null }),
          ]),
        );
      } finally {
        stop();
      }
    },
  );

  it("keeps profiles separate and renews an email binding when ownership moves away and back", async () => {
    const source = f.profile("source@aliases.test");
    const target = f.profile("target@aliases.test");
    await f.catalog();
    const originalBindings = f.bindings(source.id);
    const targetBindings = f.bindings(target.id);
    const aliasRevision = readUserProfileAliasRevision();
    f.link("retained@aliases.test", source.id);
    const retainedBindings = f
      .bindings(source.id)
      .filter((binding) => !originalBindings.includes(binding));
    expect(retainedBindings).toHaveLength(1);
    expect(f.aliases(target.id)).toEqual(new Set([target.id]));
    f.link("source@aliases.test", target.id);
    expect(f.aliases(target.id)).toEqual(new Set([target.id]));
    expect(f.aliases(source.id)).toEqual(new Set([source.id]));
    expect(readUserProfileAliasRevision()).toBe(aliasRevision);
    expect(f.bindings(source.id)).toEqual(retainedBindings);
    const movedBindings = f.bindings(target.id);
    expectRenewed(movedBindings, targetBindings, originalBindings);

    f.link("source@aliases.test", source.id);
    const returnedBindings = f.bindings(source.id);
    expectRenewed(returnedBindings, retainedBindings, [...originalBindings, ...movedBindings]);
    expect(f.bindings(target.id)).toEqual(targetBindings);
    closeOpenClawStateDatabaseByPath(f.options.path);
    expect(f.bindings(source.id)).toEqual(returnedBindings);
    expect(f.bindings(target.id)).toEqual(targetBindings);
  });

  it("renews an email binding when verified GitHub ownership moves away and back", () => {
    const sync = (accountId: number) =>
      f.github("shared@aliases.test", { accountId, login: `account-${accountId}` });
    const first = sync(10);
    const originalBindings = f.bindings(first.id);
    expect(originalBindings).toEqual([expect.any(String)]);
    const second = sync(20);
    expect(second.id).not.toBe(first.id);
    expect(f.bindings(first.id)).toEqual([]);
    const movedBindings = f.bindings(second.id);
    expect(movedBindings).toEqual([expect.any(String)]);
    expect(movedBindings).not.toEqual(originalBindings);

    expect(sync(10).id).toBe(first.id);
    const returnedBindings = f.bindings(first.id);
    expect(returnedBindings).toEqual([expect.any(String)]);
    expect(returnedBindings).not.toEqual(originalBindings);
    expect(returnedBindings).not.toEqual(movedBindings);
  });

  it("renews a deleted legacy alias binding on recreation while preserving unrelated bindings", () => {
    const provider = f.profile("user@github");
    const email = f.profile("person@aliases.test");
    const providerBindings = f.bindings(provider.id);
    const emailBindings = f.bindings(email.id);
    expect(migrateLegacyTailscaleProfileIdentities(f.options).warnings).toEqual([]);
    expect(f.bindings(provider.id)).toEqual([]);
    expect(f.bindings(email.id)).toEqual(emailBindings);

    f.link("user@github", provider.id);
    const recreatedBindings = f.bindings(provider.id);
    expect(recreatedBindings).toEqual([expect.any(String)]);
    expect(recreatedBindings).not.toEqual(providerBindings);
  });

  it("keeps alias access stable across profile creation, cosmetics and same-head GitHub refresh", async () => {
    const aliasRevision = readUserProfileAliasRevision();
    const profile = f.profile("cosmetic@aliases.test");
    await f.catalog();
    const bindings = f.bindings(profile.id);
    expect(bindings).toEqual([expect.any(String)]);
    f.link("cosmetic@aliases.test", profile.id);
    setDisplayName(profile.id, "Updated name", f.options);
    expect(setAvatar(profile.id, new Uint8Array([1]), "image/png", f.options).ok).toBe(true);
    f.github("cosmetic@aliases.test");
    f.github("cosmetic@aliases.test", { accountId: 123, login: "renamed-profile" });
    expect(f.aliases(profile.id)).toEqual(new Set([profile.id]));
    expect(readUserProfileAliasRevision()).toBe(aliasRevision);
    expect(f.bindings(profile.id)).toEqual(bindings);
  });

  it("compresses tombstones so durable profile references resolve to the merge head", async () => {
    const a = f.profile("a@example.com");
    const b = f.profile("b@example.com");
    const c = f.profile("c@example.com");
    await f.catalog();
    const aliasRevision = readUserProfileAliasRevision();

    f.link("a@example.com", b.id);
    f.link("a@example.com", c.id);
    f.link("b@example.com", c.id);
    expect(readUserProfileAliasRevision()).toBe(aliasRevision + 2);

    expect(setDisplayName(a.id, "Durable A", f.options)).toMatchObject({ id: c.id });
    const { profiles } = readUserProfileSnapshotSync(f.options);
    expect(profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: a.id, mergedInto: c.id }),
        expect.objectContaining({ id: b.id, mergedInto: c.id }),
      ]),
    );
  });

  it.each([false, true])(
    "leaves absent storage untouched and observes its later creation (database=%s)",
    async (exists) => {
      const db = exists ? openOpenClawStateDatabase(f.options).db : undefined;
      expect(f.aliases("missing")).toEqual(new Set(["missing"]));
      if (db) {
        expect(tableExists(db, "user_profiles")).toBe(false);
      } else {
        expect(fs.existsSync(f.options.path)).toBe(false);
      }
      const source = f.profile("source@aliases.test");
      const target = f.profile("target@aliases.test");
      f.link("source@aliases.test", target.id);
      await f.catalog();
      expect(f.aliases(target.id)).toEqual(new Set([source.id, target.id]));
    },
  );

  it("honors explicit paths and env roots, and drops handle-bound aliases after reopen", async () => {
    const other = { path: path.join(tempDirs.make("profile-other-"), "state", "openclaw.sqlite") };
    const source = f.profile("source@aliases.test");
    const target = f.profile("target@aliases.test");
    f.link("source@aliases.test", target.id);
    const release = (await prepareUserProfileCatalog(f.options)).release;
    using catalog = { release, [Symbol.dispose]: release };
    const env = { OPENCLAW_STATE_DIR: path.dirname(path.dirname(other.path)) };
    expect(readUserProfileAliases(target.id, { ...f.options, env })).toEqual(
      new Set([source.id, target.id]),
    );
    expect(readUserProfileAliases(target.id, { env })).toEqual(new Set([target.id]));
    expect(fs.existsSync(other.path)).toBe(false);
    catalog.release();
    closeOpenClawStateDatabaseByPath(f.options.path);
    // Fixture-only external change while closed; this does not promise external-process polling.
    const reopened = openOpenClawStateDatabase(f.options).db;
    reopened.prepare("DELETE FROM user_profiles WHERE id = ?").run(source.id);
    await f.catalog();
    expect(f.aliases(target.id)).toEqual(new Set([target.id]));
  });
});
