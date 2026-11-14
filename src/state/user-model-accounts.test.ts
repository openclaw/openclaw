import { existsSync } from "node:fs";
import { constants, StatementSync } from "node:sqlite";
import { beforeEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { closeOpenClawStateDatabaseByPath } from "./openclaw-state-db-cache.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
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
  type UserProfileAuthLink,
} from "./user-model-accounts.js";
import { readUserModelAccountCommand } from "./user-model-accounts.read.worker.js";
import { captureUserProfileModelAccountLinksAuthority } from "./user-profile-events.js";
import { linkEmail, mergeProfiles, setAvatar } from "./user-profile-writes.worker.js";
import { ensureProfileForEmail } from "./user-profiles.js";
import { useUserStateFixture } from "./user-state.test-support.js";

const stateOptions = useUserStateFixture("user-model-accounts-");
let options: ReturnType<typeof stateOptions>;
beforeEach(() => {
  options = stateOptions();
});

function hasPrivateAccountState(profileId: string): boolean {
  const { db } = openOpenClawStateDatabase(options);
  return (
    tableExists(db, "secret_store_entries") &&
    db
      .prepare(`SELECT name FROM secret_store_entries
      WHERE scope_kind = 'identity' AND scope_id = ?
        AND (name = 'model-accounts' OR name LIKE 'model-account:%')`)
      .get(profileId) !== undefined
  );
}

const tokenCredential = (token = "synthetic-personal-token", provider = "anthropic") =>
  ({ type: "token", provider, token }) satisfies AuthProfileCredential;
const apiKeyCredential = (key: string) =>
  ({ type: "api_key", provider: "xai", key }) satisfies AuthProfileCredential;
const accountEmail = "account@example.test";
const labelPrefix = "x".repeat(255);
const labelCase = (credential: AuthProfileCredential, displayName: string, label: string) => ({
  credential: { ...credential, displayName },
  label,
});
const accountSummary = (
  authProfileId: string,
  provider: string,
  label: string,
  authType: string,
) => ({ authProfileId, provider, label, authType, selected: true });

function connect(
  ownerProfileId: string,
  credential: AuthProfileCredential,
  assertCurrent = () => {},
  replacement?: ReturnType<typeof readSelectedUserModelAccount>,
) {
  return connectUserModelAccount(
    { ownerProfileId, credential, assertCurrent, replacement },
    options,
  );
}

function owner(email = "alice@example.test") {
  const { id } = ensureProfileForEmail(email, options);
  return {
    id,
    accounts: (cursor?: string) => listUserModelAccounts({ profileId: id, cursor }, options),
    links: () => listUserProfileAuthLinks(id, options),
    summary: (authProfileId: string) =>
      readUserModelAccountSummary({ profileId: id, authProfileId }, options),
    clear: (provider: string) => clearUserProfileAuthLink({ profileId: id, provider }, options),
    link: (provider: string, authProfileId: string) =>
      setUserProfileAuthLink({ profileId: id, provider, authProfileId }, options),
    connect: (credential: AuthProfileCredential, assertCurrent?: () => void) =>
      connect(id, credential, assertCurrent),
    token: (token?: string) =>
      connect(
        id,
        tokenCredential(token),
        undefined,
        readSelectedUserModelAccount(id, "anthropic", options),
      ),
    read: (authProfileId: string) => readUserModelAuthProfile(authProfileId, options),
    update: (authProfileId: string, mutate: Parameters<typeof updateUserModelAuthProfile>[1]) =>
      updateUserModelAuthProfile(authProfileId, mutate, options),
  };
}

it("reads current linked credentials together after in-process refresh and unlink writes", () => {
  const alice = owner();
  const first = alice.token().authProfileId;
  const second = alice.connect(tokenCredential("synthetic-second-token", "openai")).authProfileId;
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
    alice.update(first, (profile) => {
      if (profile.credential.type !== "token") {
        throw new Error("Expected token credential");
      }
      profile.credential.token = "synthetic-refreshed-token";
      return true;
    }),
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

it("reads one-statement default links and refreshes cached links after committed writes", async () => {
  const alice = owner();
  const bob = owner("bob@example.test");
  const { authProfileId } = alice.token();
  const { db } = openOpenClawStateDatabase(options);
  const expectLinks = async (profileId: string, expected: UserProfileAuthLink[]) => {
    const observation = observeSqliteReadSql(StatementSync.prototype);
    const exec = vi.spyOn(requireNativeSqliteDatabase(db), "exec");
    try {
      expect(
        readUserModelAccountCommand(db, { type: "userModelAccounts.links", profileId }),
      ).toEqual({
        type: "userModelAccounts.links",
        links: expected,
      });
      expect(observation.queries).toHaveLength(1);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      observation.restore();
      exec.mockRestore();
    }
    await expect(listUserProfileAuthLinksAsync(profileId, options)).resolves.toEqual(expected);
  };
  const linked = [{ provider: "anthropic", authProfileId, updatedAt: expect.any(Number) }];
  await expectLinks(alice.id, linked);
  alice.clear("anthropic");
  await expectLinks(alice.id, []);
  alice.link("anthropic", authProfileId);
  await expectLinks(bob.id, []);
  mergeProfiles(alice.id, bob.id, options);
  for (const profileId of [alice.id, bob.id]) {
    await expectLinks(profileId, linked);
  }
});

it("publishes default-link authority only on commit and never revives an old selection", () => {
  const alice = owner();
  const bob = owner("bob@example.test");
  const { authProfileId } = alice.token();
  const admission = captureOpenClawStateReadContext(options.path).admission;
  const aliceCurrent = captureUserProfileModelAccountLinksAuthority(admission, alice.id);
  const bobCurrent = captureUserProfileModelAccountLinksAuthority(admission, bob.id);
  const { db } = openOpenClawStateDatabase(options);
  requireNativeSqliteDatabase(db).setAuthorizer(() => constants.SQLITE_DENY);
  try {
    expect([aliceCurrent(), bobCurrent()]).toEqual([true, true]);
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
  bob.token();
  expect([aliceCurrent(), bobCurrent()]).toEqual([true, false]);
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
    const source = owner("owner-source@example.test");
    const target = owner("owner-target@example.test");
    const avatar = new Uint8Array(512 * 1024).fill(42);
    expect(setAvatar(source.id, avatar, "image/png", options).ok).toBe(true);
    expect(setAvatar(target.id, avatar, "image/png", options).ok).toBe(true);
    const { authProfileId } = source.token();
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
      db.prepare("UPDATE user_profiles SET merged_into = ? WHERE id = ?").run(
        successor,
        kind === "missing target" ? source.id : target.id,
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
      expect(source.read(authProfileId)?.credential).toEqual(
        ownsCredential ? tokenCredential() : undefined,
      );
      expect(listUserProfileAuthLinks("missing-profile", options)).toEqual([]);
      if (!ownsCredential) {
        expect(() => source.link("anthropic", authProfileId)).toThrow("owner is unavailable");
      }
    } finally {
      requireNativeSqliteDatabase(db).setAuthorizer(null);
    }
  },
);

it.each([false, true])(
  "reads absent account storage without creating it (profile: %s)",
  (withProfile) => {
    const profileId = withProfile
      ? ensureProfileForEmail("lazy@example.test", options).id
      : "missing";
    expect(listUserProfileAuthLinks(profileId, options)).toEqual([]);
    expect(listUserModelAccounts({ profileId }, options)).toEqual({ accounts: [] });
    if (withProfile) {
      expect(hasPrivateAccountState(profileId)).toBe(false);
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
  labelCase(
    {
      ...apiKeyCredential("  synthetic-personal-api-key\r\n"),
      metadata: { account: "synthetic-account" },
    },
    `${labelPrefix}🤖`,
    labelPrefix,
  ),
  ...["\ud83e", "\udd16"].map((surrogate) =>
    labelCase(tokenCredential(), `${labelPrefix}${surrogate}`, `${labelPrefix}\ufffd`),
  ),
  ...[
    { displayName: "Sign in with ChatGPT", label: `${accountEmail} · Sign in with ChatGPT` },
    { displayName: accountEmail, label: accountEmail },
  ].map(({ displayName, label }) =>
    labelCase(
      { ...tokenCredential("synthetic-token", "example"), email: accountEmail },
      displayName,
      label,
    ),
  ),
] satisfies Array<{ credential: AuthProfileCredential; label: string }>)(
  "retains the credential and exposes the repaired account label $label",
  ({ credential, label }) => {
    const alice = owner();
    const bob = owner("bob@example.test");
    const { authProfileId } = alice.connect(credential);
    closeOpenClawStateDatabaseByPath(options.path);
    expect(alice.read(authProfileId)?.credential).toEqual(
      credential.type === "api_key"
        ? { ...credential, key: "synthetic-personal-api-key" }
        : credential,
    );
    expect(alice.accounts()).toEqual({
      accounts: [accountSummary(authProfileId, credential.provider, label, credential.type)],
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
  ["portable credential", { ...apiKeyCredential("synthetic-personal-key"), copyToAgents: true }],
] satisfies Array<[string, AuthProfileCredential]>)(
  "rejects personal %s without changing owner state",
  (_name, credential) => {
    const rejectedOwner = owner();
    expect(() => rejectedOwner.connect(credential)).toThrow();
    expect(rejectedOwner.links()).toEqual([]);
    expect(hasPrivateAccountState(rejectedOwner.id)).toBe(false);
  },
);

it("lists retained owned accounts without secrets and can select them again after clearing a default", () => {
  const alice = owner();
  const bob = owner("bob@example.test");
  const scopes = {
    clientId: "synthetic-client",
    authorizationScope: "openid profile resource.invoke offline_access",
    grantedScope: "openid offline_access",
  };
  const first = alice.connect({
    type: "oauth",
    provider: "openai",
    email: accountEmail,
    access: "synthetic-inventory-access",
    refresh: "synthetic-inventory-refresh",
    expires: 123,
    ...scopes,
  });
  const second = alice.token();
  const expected = [
    accountSummary(first.authProfileId, "openai", accountEmail, "oauth"),
    accountSummary(second.authProfileId, "anthropic", "anthropic", "token"),
  ].toSorted((a, b) => a.authProfileId.localeCompare(b.authProfileId));
  expect(alice.accounts()).toEqual({ accounts: expected });
  expect(bob.accounts()).toEqual({ accounts: [] });
  expect(bob.summary(first.authProfileId)).toBeUndefined();

  alice.clear("openai");
  closeOpenClawStateDatabaseByPath(options.path);
  expect(alice.read(first.authProfileId)?.credential).toMatchObject(scopes);
  expect(alice.summary(first.authProfileId)).toMatchObject({
    label: accountEmail,
    selected: false,
  });
  alice.link("openai", first.authProfileId);
  expect(alice.accounts()).toEqual({ accounts: expected });
});

it("paginates only the current owner's retained accounts without losing the selected one", () => {
  const alice = owner();
  const bob = owner("bob@example.test");
  bob.token();
  const ids = Array.from(
    { length: 51 },
    (_, index) => alice.connect(tokenCredential(`synthetic-page-${index}`)).authProfileId,
  );
  const first = alice.accounts();
  expect(first.accounts).toHaveLength(50);
  expect(first.nextCursor).toBeDefined();
  const second = alice.accounts(first.nextCursor);
  expect(second.accounts).toHaveLength(1);
  expect(second.nextCursor).toBeUndefined();
  const all = [...first.accounts, ...second.accounts];
  expect(all.map((account) => account.authProfileId)).toEqual(ids.toSorted());
  expect(all.filter((account) => account.selected).map((account) => account.authProfileId)).toEqual(
    [ids.at(-1)],
  );
});

it("replaces only owned credentials, retaining exact session pins after unlink", () => {
  const alice = owner();
  const bob = owner("bob@example.test");
  alice.link("anthropic", "anthropic:shared");
  const first = alice.token();
  expect(first.authProfileId).not.toBe("anthropic:shared");
  const reconnect = alice.token("synthetic-new-token");
  expect(reconnect.authProfileId).toBe(first.authProfileId);
  expect(() => bob.link("anthropic", first.authProfileId)).toThrow("does not belong");
  expect(bob.links()).toEqual([]);

  alice.clear("anthropic");
  expect(alice.links()).toEqual([]);
  expect(alice.read(first.authProfileId)?.credential).toMatchObject({
    token: "synthetic-new-token",
  });
});

it("commits neither credential nor link when final authorization is revoked", () => {
  const alice = owner();
  expect(() =>
    alice.connect(tokenCredential("synthetic-revoked-token"), () => {
      throw new Error("revoked");
    }),
  ).toThrow("revoked");
  expect(alice.links()).toEqual([]);
  expect(hasPrivateAccountState(alice.id)).toBe(false);
});

it("preserves private refresh and usage updates across reopen without changing the link", () => {
  const alice = owner();
  const { authProfileId } = alice.token();
  expect(
    alice.update(authProfileId, (current) => {
      current.credential = tokenCredential("synthetic-rotated-token");
      current.usageStats = { lastUsed: 42, cooldownUntil: 99, cooldownReason: "rate_limit" };
      return true;
    }),
  ).toBe(true);
  expect(
    alice.update(authProfileId, (current) => {
      current.credential = tokenCredential("synthetic-stale-token");
      return false;
    }),
  ).toBe(false);
  closeOpenClawStateDatabaseByPath(options.path);
  expect(alice.read(authProfileId)).toMatchObject({
    credential: { token: "synthetic-rotated-token" },
    usageStats: { lastUsed: 42, cooldownUntil: 99, cooldownReason: "rate_limit" },
  });
  expect(alice.links()).toMatchObject([{ provider: "anthropic", authProfileId }]);
});

it.each([false, true])(
  "merges account selections and bounded credentials without reviving disconnections (disconnected: %s)",
  (disconnected) => {
    const source = owner("source@example.test");
    const target = owner("target@example.test");
    const sourceToken = "synthetic-source-".repeat(2800);
    const targetToken = "synthetic-target-".repeat(2800);
    const sourceAccount = source.token(sourceToken);
    const targetAccount = target.token(targetToken);
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
    expect(source.read(sourceAccount.authProfileId)?.credential).toMatchObject({
      token: sourceToken,
    });
    expect(target.read(targetAccount.authProfileId)?.credential).toMatchObject({
      token: targetToken,
    });
    expect(hasPrivateAccountState(source.id)).toBe(false);
    expect(() => source.token()).toThrow("owner changed");
  },
);
