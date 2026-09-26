import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withPathResolutionEnv } from "../test-utils/env.js";
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
import {
  listUserProfilesSync,
  readUserProfileEmailBindings,
} from "./user-profile-identity.read.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";
import { migrateLegacyTailscaleProfileIdentities } from "./user-profiles-tailscale-migration.js";
import {
  ensureProfileForEmail,
  linkEmail,
  readUserProfileAliases,
  resolveUserProfileId,
  setAvatar,
  setDisplayName,
  syncGitHubIdentity,
} from "./user-profiles.js";

const roots = createTempDirTracker();
const statePaths: string[] = [];
function stateOptions() {
  const pathname = path.join(roots.make("profile-aliases-"), "state", "openclaw.sqlite");
  statePaths.push(pathname);
  return { path: pathname };
}
afterEach(() => {
  for (const pathname of statePaths.splice(0)) {
    closeOpenClawStateDatabaseByPath(pathname);
  }
  roots.cleanup();
});

function readUserProfileEmailBindingIds(
  profileId: string,
  options: ReturnType<typeof stateOptions>,
): string[] {
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

describe("profile alias reader lifecycle", () => {
  it.each(["email", "github"])(
    "publishes committed %s merges, not rollbacks or canonical no-ops",
    (producer) => {
      const options = stateOptions();
      const source = ensureProfileForEmail("source@aliases.test", options);
      const target = ensureProfileForEmail("target@aliases.test", options);
      const verifiedIdentity = { accountId: 123, login: "verified-profile" };
      if (producer === "github") {
        linkEmail("source-other@aliases.test", source.id, options);
        syncGitHubIdentity(
          {
            identity: verifiedIdentity,
            authenticationAlias: { kind: "email", email: "target@aliases.test" },
          },
          options,
        );
      }
      const sourceBindings = readUserProfileEmailBindingIds(source.id, options);
      const targetBindings = readUserProfileEmailBindingIds(target.id, options);
      const merge = () =>
        producer === "email"
          ? linkEmail("source@aliases.test", target.id, options)
          : syncGitHubIdentity(
              {
                identity: verifiedIdentity,
                authenticationAlias: { kind: "email", email: "source@aliases.test" },
              },
              options,
            );
      const read = () => readUserProfileAliases(target.id, options);
      expect(read()).toEqual(new Set([target.id]));
      const aliasRevision = readUserProfileAliasRevision();
      const profileVersion = readUserProfileVersion();
      const published = vi.fn(() => ({
        aliases: read(),
        aliasRevision: readUserProfileAliasRevision(),
      }));
      const stop = onUserProfilesChanged(published);
      try {
        expect(() =>
          runOpenClawStateWriteTransaction(() => {
            merge();
            expect(read()).toEqual(new Set([target.id]));
            expect(readUserProfileAliasRevision()).toBe(aliasRevision);
            expect(published).not.toHaveBeenCalled();
            throw new Error("rollback");
          }, options),
        ).toThrow("rollback");
        expect(read()).toEqual(new Set([target.id]));
        expect(readUserProfileAliasRevision()).toBe(aliasRevision);
        expect(published).not.toHaveBeenCalled();
        expect(readUserProfileEmailBindingIds(source.id, options)).toEqual(sourceBindings);
        expect(readUserProfileEmailBindingIds(target.id, options)).toEqual(targetBindings);
        runOpenClawStateWriteTransaction(() => {
          expect(() =>
            runOpenClawStateWriteTransaction(() => {
              merge();
              throw new Error("nested rollback");
            }, options),
          ).toThrow("nested rollback");
        }, options);
        expect(read()).toEqual(new Set([target.id]));
        expect(readUserProfileAliasRevision()).toBe(aliasRevision);
        expect(published).not.toHaveBeenCalled();
        expect(readUserProfileEmailBindingIds(source.id, options)).toEqual(sourceBindings);
        expect(readUserProfileEmailBindingIds(target.id, options)).toEqual(targetBindings);
        runOpenClawStateWriteTransaction(() => {
          merge();
          expect(read()).toEqual(new Set([target.id]));
          expect(readUserProfileAliasRevision()).toBe(aliasRevision);
        }, options);
        expect(published).toHaveBeenCalledOnce();
        expect(published.mock.results[0]?.value).toEqual({
          aliases: new Set([source.id, target.id]),
          aliasRevision: aliasRevision + 1,
        });
        const mergedBindings = readUserProfileEmailBindingIds(target.id, options);
        expect(mergedBindings).toHaveLength(sourceBindings.length + targetBindings.length);
        expect(new Set(mergedBindings).size).toBe(mergedBindings.length);
        expect(mergedBindings).toEqual(expect.arrayContaining(targetBindings));
        for (const binding of sourceBindings) {
          expect(mergedBindings).not.toContain(binding);
        }
        expect(readUserProfileEmailBindingIds(source.id, options)).toEqual([]);
        expect(readUserProfileAliasRevision()).toBe(aliasRevision + 1);
        expect(readUserProfileVersion()).toBe(profileVersion + 1);
        expect(linkEmail("source@aliases.test", source.id, options)).toMatchObject({
          id: target.id,
          mergedInto: null,
          emails:
            producer === "github"
              ? ["source-other@aliases.test", "source@aliases.test", "target@aliases.test"]
              : ["source@aliases.test", "target@aliases.test"],
          hasAvatar: false,
        });
        expect(ensureProfileForEmail("source@aliases.test", options).id).toBe(target.id);
        expect(readUserProfileEmailBindingIds(target.id, options)).toEqual(mergedBindings);
        expect(published).toHaveBeenCalledOnce();
        expect(readUserProfileAliasRevision()).toBe(aliasRevision + 1);
        expect(readUserProfileVersion()).toBe(profileVersion + 1);
        expect(read()).toEqual(new Set([source.id, target.id]));
        expect(readUserProfileAliases(source.id, options)).toEqual(new Set([source.id, target.id]));
        expect(listUserProfilesSync(options)).toEqual(
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

  it("keeps profiles separate and renews an email binding when ownership moves away and back", () => {
    const options = stateOptions();
    const source = ensureProfileForEmail("source@aliases.test", options);
    const target = ensureProfileForEmail("target@aliases.test", options);
    const originalBindings = readUserProfileEmailBindingIds(source.id, options);
    const targetBindings = readUserProfileEmailBindingIds(target.id, options);
    const aliasRevision = readUserProfileAliasRevision();
    linkEmail("retained@aliases.test", source.id, options);
    const retainedBindings = readUserProfileEmailBindingIds(source.id, options).filter(
      (binding) => !originalBindings.includes(binding),
    );
    expect(retainedBindings).toHaveLength(1);
    expect(readUserProfileAliases(target.id, options)).toEqual(new Set([target.id]));
    linkEmail("source@aliases.test", target.id, options);
    expect(readUserProfileAliases(target.id, options)).toEqual(new Set([target.id]));
    expect(readUserProfileAliases(source.id, options)).toEqual(new Set([source.id]));
    expect(readUserProfileAliasRevision()).toBe(aliasRevision);
    expect(readUserProfileEmailBindingIds(source.id, options)).toEqual(retainedBindings);
    const movedBindings = readUserProfileEmailBindingIds(target.id, options);
    expect(movedBindings).toHaveLength(2);
    expect(movedBindings).toEqual(expect.arrayContaining(targetBindings));
    expect(movedBindings).not.toContain(originalBindings[0]);

    linkEmail("source@aliases.test", source.id, options);
    const returnedBindings = readUserProfileEmailBindingIds(source.id, options);
    expect(returnedBindings).toHaveLength(2);
    expect(returnedBindings).toEqual(expect.arrayContaining(retainedBindings));
    expect(returnedBindings).not.toContain(originalBindings[0]);
    for (const binding of movedBindings) {
      expect(returnedBindings).not.toContain(binding);
    }
    expect(readUserProfileEmailBindingIds(target.id, options)).toEqual(targetBindings);
    closeOpenClawStateDatabaseByPath(options.path);
    expect(readUserProfileEmailBindingIds(source.id, options)).toEqual(returnedBindings);
    expect(readUserProfileEmailBindingIds(target.id, options)).toEqual(targetBindings);
  });

  it("renews an email binding when verified GitHub ownership moves away and back", () => {
    const options = stateOptions();
    const authenticationAlias = { kind: "email" as const, email: "shared@aliases.test" };
    const sync = (accountId: number) =>
      syncGitHubIdentity(
        { identity: { accountId, login: `account-${accountId}` }, authenticationAlias },
        options,
      );
    const first = sync(10);
    const originalBindings = readUserProfileEmailBindingIds(first.id, options);
    expect(originalBindings).toEqual([expect.any(String)]);
    const second = sync(20);
    expect(second.id).not.toBe(first.id);
    expect(readUserProfileEmailBindingIds(first.id, options)).toEqual([]);
    const movedBindings = readUserProfileEmailBindingIds(second.id, options);
    expect(movedBindings).toEqual([expect.any(String)]);
    expect(movedBindings).not.toEqual(originalBindings);

    expect(sync(10).id).toBe(first.id);
    const returnedBindings = readUserProfileEmailBindingIds(first.id, options);
    expect(returnedBindings).toEqual([expect.any(String)]);
    expect(returnedBindings).not.toEqual(originalBindings);
    expect(returnedBindings).not.toEqual(movedBindings);
  });

  it("renews a deleted legacy alias binding on recreation while preserving unrelated bindings", () => {
    const options = stateOptions();
    const provider = ensureProfileForEmail("user@github", options);
    const email = ensureProfileForEmail("person@aliases.test", options);
    const providerBindings = readUserProfileEmailBindingIds(provider.id, options);
    const emailBindings = readUserProfileEmailBindingIds(email.id, options);
    expect(migrateLegacyTailscaleProfileIdentities(options).warnings).toEqual([]);
    expect(readUserProfileEmailBindingIds(provider.id, options)).toEqual([]);
    expect(readUserProfileEmailBindingIds(email.id, options)).toEqual(emailBindings);

    linkEmail("user@github", provider.id, options);
    const recreatedBindings = readUserProfileEmailBindingIds(provider.id, options);
    expect(recreatedBindings).toEqual([expect.any(String)]);
    expect(recreatedBindings).not.toEqual(providerBindings);
  });

  it("keeps alias access stable across profile creation, cosmetics and same-head GitHub refresh", () => {
    const options = stateOptions();
    const aliasRevision = readUserProfileAliasRevision();
    const profile = ensureProfileForEmail("cosmetic@aliases.test", options);
    const bindings = readUserProfileEmailBindingIds(profile.id, options);
    expect(bindings).toEqual([expect.any(String)]);
    linkEmail("cosmetic@aliases.test", profile.id, options);
    setDisplayName(profile.id, "Updated name", options);
    expect(setAvatar(profile.id, new Uint8Array([1]), "image/png", options).ok).toBe(true);
    const identity = { accountId: 123, login: "verified-profile" };
    const authenticationAlias = { kind: "email" as const, email: "cosmetic@aliases.test" };
    syncGitHubIdentity({ identity, authenticationAlias }, options);
    syncGitHubIdentity(
      { identity: { ...identity, login: "renamed-profile" }, authenticationAlias },
      options,
    );
    expect(readUserProfileAliases(profile.id, options)).toEqual(new Set([profile.id]));
    expect(readUserProfileAliasRevision()).toBe(aliasRevision);
    expect(readUserProfileEmailBindingIds(profile.id, options)).toEqual(bindings);
  });

  it("compresses tombstones so durable profile references resolve to the merge head", () => {
    const options = stateOptions();
    const a = ensureProfileForEmail("a@example.com", options);
    const b = ensureProfileForEmail("b@example.com", options);
    const c = ensureProfileForEmail("c@example.com", options);
    const aliasRevision = readUserProfileAliasRevision();

    linkEmail("a@example.com", b.id, options);
    linkEmail("a@example.com", c.id, options);
    linkEmail("b@example.com", c.id, options);
    expect(readUserProfileAliasRevision()).toBe(aliasRevision + 2);

    expect(setDisplayName(a.id, "Durable A", options)).toMatchObject({ id: c.id });
    expect(resolveUserProfileId(a.id, options)).toBe(c.id);
    expect(listUserProfilesSync(options)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: a.id, mergedInto: c.id }),
        expect.objectContaining({ id: b.id, mergedInto: c.id }),
      ]),
    );
  });

  it.each([false, true])(
    "leaves absent storage untouched and observes its later creation (database=%s)",
    (exists) => {
      const options = stateOptions();
      const db = exists ? openOpenClawStateDatabase(options).db : undefined;
      expect(readUserProfileAliases("missing", options)).toEqual(new Set(["missing"]));
      if (db) {
        expect(tableExists(db, "user_profiles")).toBe(false);
      } else {
        expect(fs.existsSync(options.path)).toBe(false);
      }
      const source = ensureProfileForEmail("source@aliases.test", options);
      const target = ensureProfileForEmail("target@aliases.test", options);
      linkEmail("source@aliases.test", target.id, options);
      expect(readUserProfileAliases(target.id, options)).toEqual(new Set([source.id, target.id]));
    },
  );

  it("honors explicit paths and env roots, and drops handle-bound aliases after reopen", () => {
    const options = stateOptions();
    const other = stateOptions();
    const source = ensureProfileForEmail("source@aliases.test", options);
    const target = ensureProfileForEmail("target@aliases.test", options);
    linkEmail("source@aliases.test", target.id, options);
    const env = { OPENCLAW_STATE_DIR: path.dirname(path.dirname(other.path)) };
    expect(readUserProfileAliases(target.id, { ...options, env })).toEqual(
      new Set([source.id, target.id]),
    );
    expect(readUserProfileAliases(target.id, { env })).toEqual(new Set([target.id]));
    expect(fs.existsSync(other.path)).toBe(false);
    closeOpenClawStateDatabaseByPath(options.path);
    // Fixture-only external change while closed; this does not promise external-process polling.
    const reopened = openOpenClawStateDatabase(options).db;
    reopened.prepare("DELETE FROM user_profiles WHERE id = ?").run(source.id);
    expect(readUserProfileAliases(target.id, options)).toEqual(new Set([target.id]));
  });

  it("reselects a newly created default state root instead of retaining legacy-root aliases", () => {
    const home = roots.make("profile-alias-home-");
    const legacyRoot = path.join(home, ".clawdbot");
    const newRoot = path.join(home, ".openclaw");
    const legacyPath = path.join(legacyRoot, "state", "openclaw.sqlite");
    statePaths.push(legacyPath, path.join(newRoot, "state", "openclaw.sqlite"));
    fs.mkdirSync(legacyRoot);
    withPathResolutionEnv(
      home,
      {
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        VITEST_WORKER_ID: undefined,
        NODE_ENV: "production",
      },
      () => {
        const source = ensureProfileForEmail("source@aliases.test");
        const target = ensureProfileForEmail("target@aliases.test");
        linkEmail("source@aliases.test", target.id);
        expect(readUserProfileAliases(target.id)).toEqual(new Set([source.id, target.id]));
        fs.mkdirSync(newRoot);
        expect(readUserProfileAliases(target.id)).toEqual(new Set([target.id]));
        expect(fs.existsSync(path.join(newRoot, "state"))).toBe(false);
        expect(
          readUserProfileAliases(target.id, { env: { OPENCLAW_STATE_DIR: legacyRoot } }),
        ).toEqual(new Set([source.id, target.id]));
      },
    );
  });
});
