import { existsSync } from "node:fs";
import { join } from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { closeOpenClawStateDatabaseByPath } from "./openclaw-state-db-cache.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { captureOpenClawStateReadContext } from "./openclaw-state-worker-context.js";
import {
  clearUserProfileAuthLink,
  connectUserModelAccount,
  listUserModelAccounts,
  listUserProfileAuthLinks,
  listUserProfileAuthLinksAsync,
  readUserModelAccountSummary,
  readSelectedUserModelAccount,
  readUserModelAuthProfile,
  resolveUserProfileAuthLink,
  setUserProfileAuthLink,
  updateUserModelAuthProfile,
} from "./user-model-accounts.js";
import { captureUserProfileModelAccountLinksAuthority } from "./user-profile-events.js";
import { linkEmail, setAvatar } from "./user-profile-writes.worker.js";
import { ensureProfileForEmail } from "./user-profiles.js";
import type { UserProfilesDatabase } from "./user-profiles.types.js";

const tempDirs = createTempDirTracker();
const statePaths: string[] = [];

function stateOptions() {
  const path = join(tempDirs.make("user-model-accounts-"), "openclaw.sqlite");
  statePaths.push(path);
  return { path };
}

function hasPrivateAccountState(
  profileId: string,
  options: ReturnType<typeof stateOptions>,
): boolean {
  const { db } = openOpenClawStateDatabase(options);
  return (
    tableExists(db, "secret_store_entries") &&
    executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db)
        .selectFrom("secret_store_entries")
        .select("name")
        .where("scope_kind", "=", "identity")
        .where("scope_id", "=", profileId)
        .where((eb) =>
          eb.or([eb("name", "=", "model-accounts"), eb("name", "like", "model-account:%")]),
        ),
    ) !== undefined
  );
}

afterEach(() => {
  for (const path of statePaths.splice(0)) {
    closeOpenClawStateDatabaseByPath(path);
  }
  tempDirs.cleanup();
});

function connectToken(
  ownerProfileId: string,
  options: ReturnType<typeof stateOptions>,
  token = "synthetic-personal-token",
) {
  return connectUserModelAccount(
    {
      ownerProfileId,
      credential: { type: "token", provider: "anthropic", token },
      replacement: readSelectedUserModelAccount(ownerProfileId, "anthropic", options),
      assertCurrent() {},
    },
    options,
  );
}

describe("personal model accounts", () => {
  it("observes foreign default-link commits on the next worker read", async () => {
    const options = stateOptions();
    const alice = ensureProfileForEmail("worker-links@example.test", options);
    const { authProfileId } = connectToken(alice.id, options);
    await expect(listUserProfileAuthLinksAsync(alice.id, options)).resolves.toEqual([
      expect.objectContaining({ provider: "anthropic", authProfileId }),
    ]);
    const external = new DatabaseSync(options.path);
    try {
      external
        .prepare(
          "UPDATE secret_store_entries SET value = ? WHERE scope_kind = 'identity' AND scope_id = ? AND name = 'model-accounts'",
        )
        .run(JSON.stringify({ version: 1, links: {} }), alice.id);
      await expect(listUserProfileAuthLinksAsync(alice.id, options)).resolves.toEqual([]);
    } finally {
      external.close();
    }
  });

  it("publishes default-link authority only on commit and never revives an old selection", () => {
    const options = stateOptions();
    const alice = ensureProfileForEmail("link-alice@example.test", options);
    const bob = ensureProfileForEmail("link-bob@example.test", options);
    const { authProfileId } = connectToken(alice.id, options);
    const admission = captureOpenClawStateReadContext(options.path).admission;
    const aliceCurrent = captureUserProfileModelAccountLinksAuthority(admission, alice.id);
    const bobCurrent = captureUserProfileModelAccountLinksAuthority(admission, bob.id);
    const { db } = openOpenClawStateDatabase(options);
    db.setAuthorizer(() => constants.SQLITE_DENY);
    try {
      expect(aliceCurrent()).toBe(true);
      expect(bobCurrent()).toBe(true);
    } finally {
      db.setAuthorizer(null);
    }
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        clearUserProfileAuthLink({ profileId: alice.id, provider: "anthropic" }, options);
        expect(aliceCurrent()).toBe(true);
        throw new Error("rollback link change");
      }, options),
    ).toThrow("rollback link change");
    expect(aliceCurrent()).toBe(true);
    expect(listUserProfileAuthLinks(alice.id, options)).toHaveLength(1);
    connectToken(bob.id, options);
    expect(aliceCurrent()).toBe(true);
    expect(bobCurrent()).toBe(false);
    clearUserProfileAuthLink({ profileId: alice.id, provider: "anthropic" }, options);
    expect(aliceCurrent()).toBe(false);
    setUserProfileAuthLink({ profileId: alice.id, provider: "anthropic", authProfileId }, options);
    expect(aliceCurrent()).toBe(false);
    const next = captureUserProfileModelAccountLinksAuthority(admission, alice.id);
    expect(next()).toBe(true);
    closeOpenClawStateDatabaseByPath(options.path);
    expect(next()).toBe(false);
  });

  it.each(["direct", "merged", "missing target", "unflattened chain"])(
    "resolves %s account ownership without reading profile avatars",
    (kind) => {
      const options = stateOptions();
      const source = ensureProfileForEmail("owner-source@example.test", options);
      const target = ensureProfileForEmail("owner-target@example.test", options);
      const avatar = new Uint8Array(512 * 1024).fill(42);
      expect(setAvatar(source.id, avatar, "image/png", options).ok).toBe(true);
      expect(setAvatar(target.id, avatar, "image/png", options).ok).toBe(true);
      const { authProfileId } = connectToken(source.id, options);
      if (kind !== "direct") {
        linkEmail("owner-source@example.test", target.id, options);
      }
      const { db } = openOpenClawStateDatabase(options);
      if (kind === "missing target" || kind === "unflattened chain") {
        const successor =
          kind === "unflattened chain"
            ? ensureProfileForEmail("owner-successor@example.test", options).id
            : "missing-profile";
        // Simulate damaged persisted lineage; only the merge writer may flatten it.
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<UserProfilesDatabase>(db)
            .updateTable("user_profiles")
            .set({ merged_into: successor })
            .where("id", "=", kind === "missing target" ? source.id : target.id),
        );
      }
      db.setAuthorizer((action, table, column) =>
        action === constants.SQLITE_READ && table === "user_profiles" && column === "avatar"
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      try {
        const ownsCredential = kind === "direct" || kind === "merged";
        expect(
          listUserProfileAuthLinks(source.id, options).map((link) => link.authProfileId),
        ).toEqual(ownsCredential ? [authProfileId] : []);
        expect(readUserModelAuthProfile(authProfileId, options)?.credential).toEqual(
          ownsCredential
            ? { type: "token", provider: "anthropic", token: "synthetic-personal-token" }
            : undefined,
        );
        expect(listUserProfileAuthLinks("missing-profile", options)).toEqual([]);
        if (!ownsCredential) {
          expect(() =>
            setUserProfileAuthLink(
              { profileId: source.id, provider: "anthropic", authProfileId },
              options,
            ),
          ).toThrow("owner is unavailable");
        }
      } finally {
        db.setAuthorizer(null);
      }
    },
  );

  it.each([false, true])(
    "reads absent account storage without creating it (profile: %s)",
    (withProfile) => {
      const options = stateOptions();
      const profileId = withProfile
        ? ensureProfileForEmail("lazy@example.test", options).id
        : "missing";
      expect(listUserProfileAuthLinks(profileId, options)).toEqual([]);
      expect(listUserModelAccounts({ profileId }, options)).toEqual({ accounts: [] });
      expect(
        resolveUserProfileAuthLink({ profileId, providers: ["openai"] }, options),
      ).toBeUndefined();
      if (withProfile) {
        expect(hasPrivateAccountState(profileId, options)).toBe(false);
      } else {
        expect(existsSync(options.path)).toBe(false);
        expect(() =>
          setUserProfileAuthLink(
            { profileId, provider: "openai", authProfileId: "openai:x" },
            options,
          ),
        ).toThrow("owner is unavailable");
      }
    },
  );

  it.each([
    {
      credential: {
        type: "api_key",
        provider: "xai",
        key: "  synthetic-personal-api-key\r\n",
        displayName: `${"x".repeat(255)}🤖`,
        metadata: { account: "synthetic-account" },
      },
      label: "x".repeat(255),
    },
    ...["\ud83e", "\udd16"].map((surrogate) => ({
      credential: {
        type: "token" as const,
        provider: "anthropic",
        token: "synthetic-malformed-label-token",
        displayName: `${"x".repeat(255)}${surrogate}`,
      },
      label: `${"x".repeat(255)}\ufffd`,
    })),
    ...[
      { displayName: "Sign in with ChatGPT", label: "account@example.test · Sign in with ChatGPT" },
      { displayName: "account@example.test", label: "account@example.test" },
    ].map(({ displayName, label }) => ({
      credential: {
        type: "token" as const,
        provider: "example",
        token: "synthetic-account-label-token",
        email: "account@example.test",
        displayName,
      },
      label,
    })),
  ] satisfies Array<{ credential: AuthProfileCredential; label: string }>)(
    "retains the credential and exposes the repaired account label $label",
    ({ credential, label }) => {
      const options = stateOptions();
      const alice = ensureProfileForEmail("label-alice@example.test", options);
      const bob = ensureProfileForEmail("label-bob@example.test", options);
      const { authProfileId } = connectUserModelAccount(
        { ownerProfileId: alice.id, credential, assertCurrent() {} },
        options,
      );
      closeOpenClawStateDatabaseByPath(options.path);
      expect(readUserModelAuthProfile(authProfileId, options)?.credential).toEqual(
        credential.type === "api_key"
          ? { ...credential, key: "synthetic-personal-api-key" }
          : credential,
      );
      expect(listUserModelAccounts({ profileId: alice.id }, options)).toEqual({
        accounts: [
          {
            authProfileId,
            provider: credential.provider,
            label,
            authType: credential.type,
            selected: true,
          },
        ],
      });
      expect(listUserModelAccounts({ profileId: bob.id }, options)).toEqual({ accounts: [] });
      expect(
        readUserModelAccountSummary({ profileId: alice.id, authProfileId }, options)?.label,
      ).toBe(label);
    },
  );

  it.each([
    {
      name: "API-key SecretRef",
      credential: {
        type: "api_key",
        provider: "xai",
        keyRef: { source: "env", provider: "default", id: "XAI_API_KEY" },
      },
    },
    {
      name: "token SecretRef",
      credential: {
        type: "token",
        provider: "synthetic",
        tokenRef: { source: "env", provider: "default", id: "SYNTHETIC_TOKEN" },
      },
    },
    {
      name: "inline API-key reference",
      credential: { type: "api_key", provider: "xai", key: "${XAI_API_KEY}" },
    },
    {
      name: "inline token reference",
      credential: { type: "token", provider: "synthetic", token: "$SYNTHETIC_TOKEN" },
    },
    {
      name: "portable credential",
      credential: {
        type: "api_key",
        provider: "xai",
        key: "synthetic-personal-key",
        copyToAgents: true,
      },
    },
  ] satisfies Array<{ name: string; credential: AuthProfileCredential }>)(
    "rejects personal $name without changing owner state",
    ({ credential }) => {
      const options = stateOptions();
      const owner = ensureProfileForEmail("inline-owner@example.test", options);
      expect(() =>
        connectUserModelAccount(
          { ownerProfileId: owner.id, credential, assertCurrent() {} },
          options,
        ),
      ).toThrow();
      expect(listUserProfileAuthLinks(owner.id, options)).toEqual([]);
      expect(hasPrivateAccountState(owner.id, options)).toBe(false);
    },
  );

  it("lists retained owned accounts without secrets and can select them again after clearing a default", () => {
    const options = stateOptions();
    const alice = ensureProfileForEmail("inventory-alice@example.test", options);
    const bob = ensureProfileForEmail("inventory-bob@example.test", options);
    const first = connectUserModelAccount(
      {
        ownerProfileId: alice.id,
        credential: {
          type: "oauth",
          provider: "openai",
          email: "account@example.test",
          access: "synthetic-inventory-access",
          refresh: "synthetic-inventory-refresh",
          expires: 123,
          clientId: "synthetic-client",
          authorizationScope: "openid profile resource.invoke offline_access",
          grantedScope: "openid offline_access",
        },
        assertCurrent() {},
      },
      options,
    );
    const second = connectToken(alice.id, options);
    const expected = [
      {
        authProfileId: first.authProfileId,
        provider: "openai",
        label: "account@example.test",
        authType: "oauth",
        selected: true,
      },
      {
        authProfileId: second.authProfileId,
        provider: "anthropic",
        label: "anthropic",
        authType: "token",
        selected: true,
      },
    ].toSorted((a, b) => a.authProfileId.localeCompare(b.authProfileId));
    expect(listUserModelAccounts({ profileId: alice.id }, options)).toEqual({ accounts: expected });
    expect(listUserModelAccounts({ profileId: bob.id }, options)).toEqual({ accounts: [] });
    expect(
      readUserModelAccountSummary(
        { profileId: bob.id, authProfileId: first.authProfileId },
        options,
      ),
    ).toBeUndefined();

    clearUserProfileAuthLink({ profileId: alice.id, provider: "openai" }, options);
    closeOpenClawStateDatabaseByPath(options.path);
    expect(readUserModelAuthProfile(first.authProfileId, options)?.credential).toMatchObject({
      clientId: "synthetic-client",
      authorizationScope: "openid profile resource.invoke offline_access",
      grantedScope: "openid offline_access",
    });
    expect(
      readUserModelAccountSummary(
        { profileId: alice.id, authProfileId: first.authProfileId },
        options,
      ),
    ).toMatchObject({ label: "account@example.test", selected: false });
    setUserProfileAuthLink(
      { profileId: alice.id, provider: "openai", authProfileId: first.authProfileId },
      options,
    );
    expect(listUserModelAccounts({ profileId: alice.id }, options)).toEqual({ accounts: expected });
  });

  it("paginates only the current owner's retained accounts without losing the selected one", () => {
    const options = stateOptions();
    const alice = ensureProfileForEmail("pages-alice@example.test", options);
    const bob = ensureProfileForEmail("pages-bob@example.test", options);
    connectToken(bob.id, options);
    const ids = Array.from(
      { length: 51 },
      (_, index) =>
        connectUserModelAccount(
          {
            ownerProfileId: alice.id,
            credential: { type: "token", provider: "anthropic", token: `synthetic-page-${index}` },
            assertCurrent() {},
          },
          options,
        ).authProfileId,
    );
    const first = listUserModelAccounts({ profileId: alice.id }, options);
    expect(first.accounts).toHaveLength(50);
    expect(first.nextCursor).toBeDefined();
    const second = listUserModelAccounts(
      { profileId: alice.id, cursor: first.nextCursor },
      options,
    );
    expect(second.accounts).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    const all = [...first.accounts, ...second.accounts];
    expect(all.map((account) => account.authProfileId)).toEqual(ids.toSorted());
    expect(
      all.filter((account) => account.selected).map((account) => account.authProfileId),
    ).toEqual([ids.at(-1)]);
  });

  it("resolves through provider preference order without creating storage", () => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("bob@example.test", options);
    expect(
      resolveUserProfileAuthLink({ profileId: profile.id, providers: ["openai"] }, options),
    ).toBeUndefined();
    expect(hasPrivateAccountState(profile.id, options)).toBe(false);
    setUserProfileAuthLink(
      { profileId: profile.id, provider: "openai", authProfileId: "openai:bob" },
      options,
    );
    setUserProfileAuthLink(
      { profileId: profile.id, provider: "anthropic", authProfileId: "anthropic:bob" },
      options,
    );
    expect(
      resolveUserProfileAuthLink(
        { profileId: profile.id, providers: ["anthropic", "openai"] },
        options,
      ),
    ).toBe("anthropic:bob");
    expect(
      resolveUserProfileAuthLink({ profileId: profile.id, providers: ["openai"] }, options),
    ).toBe("openai:bob");
    expect(
      resolveUserProfileAuthLink({ profileId: profile.id, providers: ["mistral"] }, options),
    ).toBeUndefined();
  });

  it("replaces only owned credentials, retaining exact session pins after unlink", () => {
    const options = stateOptions();
    const alice = ensureProfileForEmail("alice@example.test", options);
    const bob = ensureProfileForEmail("bob@example.test", options);
    setUserProfileAuthLink(
      { profileId: alice.id, provider: "anthropic", authProfileId: "anthropic:shared" },
      options,
    );
    const first = connectToken(alice.id, options);
    expect(first.authProfileId).not.toBe("anthropic:shared");
    const reconnect = connectToken(alice.id, options, "synthetic-new-token");
    expect(reconnect.authProfileId).toBe(first.authProfileId);
    expect(() =>
      setUserProfileAuthLink(
        {
          profileId: bob.id,
          provider: "anthropic",
          authProfileId: first.authProfileId,
        },
        options,
      ),
    ).toThrow("does not belong");
    expect(listUserProfileAuthLinks(bob.id, options)).toEqual([]);

    clearUserProfileAuthLink({ profileId: alice.id, provider: "anthropic" }, options);
    expect(
      resolveUserProfileAuthLink({ profileId: alice.id, providers: ["anthropic"] }, options),
    ).toBeUndefined();
    expect(readUserModelAuthProfile(first.authProfileId, options)?.credential).toMatchObject({
      token: "synthetic-new-token",
    });
  });

  it("commits neither credential nor link when final authorization is revoked", () => {
    const options = stateOptions();
    const alice = ensureProfileForEmail("alice@example.test", options);
    expect(() =>
      connectUserModelAccount(
        {
          ownerProfileId: alice.id,
          credential: { type: "token", provider: "anthropic", token: "synthetic-revoked-token" },
          assertCurrent: () => {
            throw new Error("revoked");
          },
        },
        options,
      ),
    ).toThrow("revoked");
    expect(listUserProfileAuthLinks(alice.id, options)).toEqual([]);
    expect(hasPrivateAccountState(alice.id, options)).toBe(false);
  });

  it("preserves private refresh and usage updates across reopen without changing the link", () => {
    const options = stateOptions();
    const alice = ensureProfileForEmail("alice@example.test", options);
    const { authProfileId } = connectToken(alice.id, options);
    expect(
      updateUserModelAuthProfile(
        authProfileId,
        (current) => {
          current.credential = {
            type: "token",
            provider: "anthropic",
            token: "synthetic-rotated-token",
          };
          current.usageStats = { lastUsed: 42, cooldownUntil: 99, cooldownReason: "rate_limit" };
          return true;
        },
        options,
      ),
    ).toBe(true);
    expect(
      updateUserModelAuthProfile(
        authProfileId,
        (current) => {
          current.credential = {
            type: "token",
            provider: "anthropic",
            token: "synthetic-stale-token",
          };
          return false;
        },
        options,
      ),
    ).toBe(false);
    closeOpenClawStateDatabaseByPath(options.path);
    expect(readUserModelAuthProfile(authProfileId, options)).toMatchObject({
      credential: { token: "synthetic-rotated-token" },
      usageStats: { lastUsed: 42, cooldownUntil: 99, cooldownReason: "rate_limit" },
    });
    expect(
      resolveUserProfileAuthLink({ profileId: alice.id, providers: ["anthropic"] }, options),
    ).toBe(authProfileId);
  });

  it.each([false, true])(
    "merges account selections and bounded credentials without reviving disconnections (disconnected: %s)",
    (disconnected) => {
      const options = stateOptions();
      const source = ensureProfileForEmail("source@example.test", options);
      const target = ensureProfileForEmail("target@example.test", options);
      const sourceToken = "synthetic-source-".repeat(2800);
      const targetToken = "synthetic-target-".repeat(2800);
      const sourceAccount = connectToken(source.id, options, sourceToken);
      const targetAccount = connectToken(target.id, options, targetToken);
      for (const [profileId, provider, authProfileId] of [
        [source.id, "openai", "openai:source"],
        [source.id, "mistral", "mistral:source"],
        [target.id, "mistral", "mistral:target"],
      ] as const) {
        setUserProfileAuthLink({ profileId, provider, authProfileId }, options);
      }
      if (disconnected) {
        clearUserProfileAuthLink({ profileId: target.id, provider: "anthropic" }, options);
      }
      linkEmail("source@example.test", target.id, options);
      const expectedLinks = [
        ...(disconnected
          ? []
          : [{ provider: "anthropic", authProfileId: targetAccount.authProfileId }]),
        { provider: "mistral", authProfileId: "mistral:target" },
        { provider: "openai", authProfileId: "openai:source" },
      ];
      expect(listUserProfileAuthLinks(target.id, options)).toMatchObject(expectedLinks);
      expect(
        resolveUserProfileAuthLink({ profileId: source.id, providers: ["mistral"] }, options),
      ).toBe("mistral:target");
      expect(
        resolveUserProfileAuthLink({ profileId: target.id, providers: ["anthropic"] }, options),
      ).toBe(disconnected ? undefined : targetAccount.authProfileId);
      expect(
        readUserModelAccountSummary(
          { profileId: target.id, authProfileId: sourceAccount.authProfileId },
          options,
        ),
      ).toMatchObject({ authProfileId: sourceAccount.authProfileId });
      expect(
        readUserModelAuthProfile(sourceAccount.authProfileId, options)?.credential,
      ).toMatchObject({ token: sourceToken });
      expect(
        readUserModelAuthProfile(targetAccount.authProfileId, options)?.credential,
      ).toMatchObject({ token: targetToken });
      expect(hasPrivateAccountState(source.id, options)).toBe(false);
      expect(() => connectToken(source.id, options)).toThrow("owner changed");
    },
  );
});
