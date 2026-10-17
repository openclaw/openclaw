import { existsSync } from "node:fs";
import { constants } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
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
  setUserProfileAuthLink,
  updateUserModelAuthProfile,
} from "./user-model-accounts.js";
import { readUserModelAccountCommand } from "./user-model-accounts.read.worker.js";
import { captureUserProfileModelAccountLinksAuthority } from "./user-profile-events.js";
import { linkEmail, mergeProfiles, setAvatar } from "./user-profile-writes.worker.js";
import { ensureProfileForEmail } from "./user-profiles.js";
import type { UserProfilesDatabase } from "./user-profiles.types.js";
import { useUserStateFixture } from "./user-state.test-support.js";

const stateOptions = useUserStateFixture("user-model-accounts-");

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

const tokenCredential = (token = "synthetic-personal-token", provider = "anthropic") =>
  ({ type: "token", provider, token }) satisfies AuthProfileCredential;
const apiKeyCredential = (key: string) =>
  ({ type: "api_key", provider: "xai", key }) satisfies AuthProfileCredential;

function connect(
  ownerProfileId: string,
  credential: AuthProfileCredential,
  options: ReturnType<typeof stateOptions>,
) {
  return connectUserModelAccount({ ownerProfileId, credential, assertCurrent() {} }, options);
}

function connectToken(
  ownerProfileId: string,
  options: ReturnType<typeof stateOptions>,
  token = "synthetic-personal-token",
) {
  return connectUserModelAccount(
    {
      ownerProfileId,
      credential: tokenCredential(token),
      replacement: readSelectedUserModelAccount(ownerProfileId, "anthropic", options),
      assertCurrent() {},
    },
    options,
  );
}

function owner(email: string, options: ReturnType<typeof stateOptions>) {
  const { id } = ensureProfileForEmail(email, options);
  return {
    id,
    accounts: () => listUserModelAccounts({ profileId: id }, options),
    links: () => listUserProfileAuthLinks(id, options),
    summary: (authProfileId: string) =>
      readUserModelAccountSummary({ profileId: id, authProfileId }, options),
    clear: (provider: string) => clearUserProfileAuthLink({ profileId: id, provider }, options),
    link: (provider: string, authProfileId: string) =>
      setUserProfileAuthLink({ profileId: id, provider, authProfileId }, options),
  };
}

describe("personal model accounts", () => {
  it("reads current linked credentials together after in-process refresh and unlink writes", () => {
    const options = stateOptions();
    const alice = owner("catalog-alice@example.test", options);
    const first = connectToken(alice.id, options).authProfileId;
    const second = connect(
      alice.id,
      tokenCredential("synthetic-second-token", "openai"),
      options,
    ).authProfileId;
    const { db } = openOpenClawStateDatabase(options);
    const read = () => {
      const result = readUserModelAccountCommand(db, {
        type: "userModelAccounts.catalog",
        selection: { requesterProfileId: alice.id },
      });
      if (result.type !== "userModelAccounts.catalog") {
        throw new Error("Expected personal catalog");
      }
      return result.catalog;
    };
    expect(Object.keys(read().profiles)).toEqual([first, second]);
    expect(
      updateUserModelAuthProfile(
        first,
        (profile) => {
          if (profile.credential.type !== "token") {
            throw new Error("Expected token credential");
          }
          profile.credential.token = "synthetic-refreshed-token";
          return true;
        },
        options,
      ),
    ).toBe(true);
    alice.clear("openai");
    expect(read()).toEqual({
      links: [{ provider: "anthropic", authProfileId: first, updatedAt: expect.any(Number) }],
      profiles: {
        [first]: {
          credential: { type: "token", provider: "anthropic", token: "synthetic-refreshed-token" },
          usageStats: undefined,
        },
      },
    });
  });

  it("refreshes cached default links after committed link and merge writes", async () => {
    const options = stateOptions();
    const alice = owner("worker-links@example.test", options);
    const bob = owner("worker-link-target@example.test", options);
    const { authProfileId } = connectToken(alice.id, options);
    await expect(listUserProfileAuthLinksAsync(alice.id, options)).resolves.toEqual([
      expect.objectContaining({ provider: "anthropic", authProfileId }),
    ]);
    alice.clear("anthropic");
    await expect(listUserProfileAuthLinksAsync(alice.id, options)).resolves.toEqual([]);
    alice.link("anthropic", authProfileId);
    await expect(listUserProfileAuthLinksAsync(bob.id, options)).resolves.toEqual([]);
    mergeProfiles(alice.id, bob.id, options);
    for (const profileId of [alice.id, bob.id]) {
      await expect(listUserProfileAuthLinksAsync(profileId, options)).resolves.toEqual([
        expect.objectContaining({ provider: "anthropic", authProfileId }),
      ]);
    }
  });

  it("publishes default-link authority only on commit and never revives an old selection", () => {
    const options = stateOptions();
    const alice = owner("link-alice@example.test", options);
    const bob = owner("link-bob@example.test", options);
    const { authProfileId } = connectToken(alice.id, options);
    const admission = captureOpenClawStateReadContext(options.path).admission;
    const aliceCurrent = captureUserProfileModelAccountLinksAuthority(admission, alice.id);
    const bobCurrent = captureUserProfileModelAccountLinksAuthority(admission, bob.id);
    const { db } = openOpenClawStateDatabase(options);
    requireNativeSqliteDatabase(db).setAuthorizer(() => constants.SQLITE_DENY);
    try {
      expect(aliceCurrent()).toBe(true);
      expect(bobCurrent()).toBe(true);
    } finally {
      requireNativeSqliteDatabase(db).setAuthorizer(null);
    }
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        alice.clear("anthropic");
        expect(aliceCurrent()).toBe(true);
        throw new Error("rollback link change");
      }, options),
    ).toThrow("rollback link change");
    expect(aliceCurrent()).toBe(true);
    expect(alice.links()).toHaveLength(1);
    connectToken(bob.id, options);
    expect(aliceCurrent()).toBe(true);
    expect(bobCurrent()).toBe(false);
    alice.clear("anthropic");
    expect(aliceCurrent()).toBe(false);
    alice.link("anthropic", authProfileId);
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
      const source = owner("owner-source@example.test", options);
      const target = owner("owner-target@example.test", options);
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
      requireNativeSqliteDatabase(db).setAuthorizer((action, table, column) =>
        action === constants.SQLITE_READ && table === "user_profiles" && column === "avatar"
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      try {
        const ownsCredential = kind === "direct" || kind === "merged";
        expect(source.links().map((link) => link.authProfileId)).toEqual(
          ownsCredential ? [authProfileId] : [],
        );
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
        requireNativeSqliteDatabase(db).setAuthorizer(null);
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
        ...apiKeyCredential("  synthetic-personal-api-key\r\n"),
        displayName: `${"x".repeat(255)}🤖`,
        metadata: { account: "synthetic-account" },
      },
      label: "x".repeat(255),
    },
    ...["\ud83e", "\udd16"].map((surrogate) => ({
      credential: {
        ...tokenCredential("synthetic-malformed-label-token"),
        displayName: `${"x".repeat(255)}${surrogate}`,
      },
      label: `${"x".repeat(255)}\ufffd`,
    })),
    ...[
      { displayName: "Sign in with ChatGPT", label: "account@example.test · Sign in with ChatGPT" },
      { displayName: "account@example.test", label: "account@example.test" },
    ].map(({ displayName, label }) => ({
      credential: {
        ...tokenCredential("synthetic-account-label-token", "example"),
        email: "account@example.test",
        displayName,
      },
      label,
    })),
  ] satisfies Array<{ credential: AuthProfileCredential; label: string }>)(
    "retains the credential and exposes the repaired account label $label",
    ({ credential, label }) => {
      const options = stateOptions();
      const alice = owner("label-alice@example.test", options);
      const bob = owner("label-bob@example.test", options);
      const { authProfileId } = connect(alice.id, credential, options);
      closeOpenClawStateDatabaseByPath(options.path);
      expect(readUserModelAuthProfile(authProfileId, options)?.credential).toEqual(
        credential.type === "api_key"
          ? { ...credential, key: "synthetic-personal-api-key" }
          : credential,
      );
      expect(alice.accounts()).toEqual({
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
      expect(bob.accounts()).toEqual({ accounts: [] });
      expect(alice.summary(authProfileId)?.label).toBe(label);
    },
  );

  it.each([
    [
      "API-key SecretRef",
      {
        type: "api_key",
        provider: "xai",
        keyRef: { source: "env", provider: "default", id: "XAI_API_KEY" },
      },
    ],
    [
      "token SecretRef",
      {
        type: "token",
        provider: "synthetic",
        tokenRef: { source: "env", provider: "default", id: "SYNTHETIC_TOKEN" },
      },
    ],
    ["inline API-key reference", apiKeyCredential("${XAI_API_KEY}")],
    ["inline token reference", tokenCredential("$SYNTHETIC_TOKEN", "synthetic")],
    [
      "portable credential",
      {
        ...apiKeyCredential("synthetic-personal-key"),
        copyToAgents: true,
      },
    ],
  ] satisfies Array<[string, AuthProfileCredential]>)(
    "rejects personal %s without changing owner state",
    (_name, credential) => {
      const options = stateOptions();
      const rejectedOwner = owner("inline-owner@example.test", options);
      expect(() => connect(rejectedOwner.id, credential, options)).toThrow();
      expect(rejectedOwner.links()).toEqual([]);
      expect(hasPrivateAccountState(rejectedOwner.id, options)).toBe(false);
    },
  );

  it("lists retained owned accounts without secrets and can select them again after clearing a default", () => {
    const options = stateOptions();
    const alice = owner("inventory-alice@example.test", options);
    const bob = owner("inventory-bob@example.test", options);
    const first = connect(
      alice.id,
      {
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
      options,
    );
    const second = connectToken(alice.id, options);
    const expected = (
      [
        [first.authProfileId, "openai", "account@example.test", "oauth"],
        [second.authProfileId, "anthropic", "anthropic", "token"],
      ] satisfies Array<[string, string, string, string]>
    )
      .map(([authProfileId, provider, label, authType]) => ({
        authProfileId,
        provider,
        label,
        authType,
        selected: true,
      }))
      .toSorted((a, b) => a.authProfileId.localeCompare(b.authProfileId));
    expect(alice.accounts()).toEqual({ accounts: expected });
    expect(bob.accounts()).toEqual({ accounts: [] });
    expect(bob.summary(first.authProfileId)).toBeUndefined();

    alice.clear("openai");
    closeOpenClawStateDatabaseByPath(options.path);
    expect(readUserModelAuthProfile(first.authProfileId, options)?.credential).toMatchObject({
      clientId: "synthetic-client",
      authorizationScope: "openid profile resource.invoke offline_access",
      grantedScope: "openid offline_access",
    });
    expect(alice.summary(first.authProfileId)).toMatchObject({
      label: "account@example.test",
      selected: false,
    });
    alice.link("openai", first.authProfileId);
    expect(alice.accounts()).toEqual({ accounts: expected });
  });

  it("paginates only the current owner's retained accounts without losing the selected one", () => {
    const options = stateOptions();
    const alice = owner("pages-alice@example.test", options);
    const bob = owner("pages-bob@example.test", options);
    connectToken(bob.id, options);
    const ids = Array.from(
      { length: 51 },
      (_, index) =>
        connect(alice.id, tokenCredential(`synthetic-page-${index}`), options).authProfileId,
    );
    const first = alice.accounts();
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

  it("replaces only owned credentials, retaining exact session pins after unlink", () => {
    const options = stateOptions();
    const alice = owner("alice@example.test", options);
    const bob = owner("bob@example.test", options);
    alice.link("anthropic", "anthropic:shared");
    const first = connectToken(alice.id, options);
    expect(first.authProfileId).not.toBe("anthropic:shared");
    const reconnect = connectToken(alice.id, options, "synthetic-new-token");
    expect(reconnect.authProfileId).toBe(first.authProfileId);
    expect(() => bob.link("anthropic", first.authProfileId)).toThrow("does not belong");
    expect(bob.links()).toEqual([]);

    alice.clear("anthropic");
    expect(alice.links()).toEqual([]);
    expect(readUserModelAuthProfile(first.authProfileId, options)?.credential).toMatchObject({
      token: "synthetic-new-token",
    });
  });

  it("commits neither credential nor link when final authorization is revoked", () => {
    const options = stateOptions();
    const alice = owner("alice@example.test", options);
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
    expect(alice.links()).toEqual([]);
    expect(hasPrivateAccountState(alice.id, options)).toBe(false);
  });

  it("preserves private refresh and usage updates across reopen without changing the link", () => {
    const options = stateOptions();
    const alice = owner("alice@example.test", options);
    const { authProfileId } = connectToken(alice.id, options);
    expect(
      updateUserModelAuthProfile(
        authProfileId,
        (current) => {
          current.credential = tokenCredential("synthetic-rotated-token");
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
          current.credential = tokenCredential("synthetic-stale-token");
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
    expect(alice.links()).toMatchObject([{ provider: "anthropic", authProfileId }]);
  });

  it.each([false, true])(
    "merges account selections and bounded credentials without reviving disconnections (disconnected: %s)",
    (disconnected) => {
      const options = stateOptions();
      const source = owner("source@example.test", options);
      const target = owner("target@example.test", options);
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
        target.clear("anthropic");
      }
      linkEmail("source@example.test", target.id, options);
      const expectedLinks = [
        ...(disconnected
          ? []
          : [{ provider: "anthropic", authProfileId: targetAccount.authProfileId }]),
        { provider: "mistral", authProfileId: "mistral:target" },
        { provider: "openai", authProfileId: "openai:source" },
      ];
      expect(target.links()).toMatchObject(expectedLinks);
      expect(source.links()).toMatchObject(expectedLinks);
      expect(target.summary(sourceAccount.authProfileId)).toMatchObject({
        authProfileId: sourceAccount.authProfileId,
      });
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
