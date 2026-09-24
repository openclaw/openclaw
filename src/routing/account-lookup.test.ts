// Account lookup tests cover account matching by id, alias, and chat metadata.
import { describe, expect, it } from "vitest";
import { resolveAccountKey as resolvePublicAccountKey } from "../plugin-sdk/account-resolution.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { normalizeAccountId as normalizeRoutingAccountId } from "./account-id.js";
import {
  resolveAccountEntry,
  resolveAccountKey,
  resolveNormalizedAccountEntry,
} from "./account-lookup.js";

describe("SDK resolveAccountKey creation targets", () => {
  it.each(["__proto__", "constructor", "prototype"])(
    "rejects reserved %s for both plain and policy-backed setup writers",
    (accountId) => {
      for (const policy of [undefined, { canonicalAliasesRequireOwnField: "account" }]) {
        expect(() =>
          resolveAccountKey(undefined, accountId, undefined, policy, { allowMissing: true }),
        ).toThrow(`Account id "${accountId}" is reserved`);
      }
    },
  );
});

describe("SDK resolveAccountKey channel context", () => {
  const accounts = { "Work Phone": { account: "+12025550103" } };
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "phone-owner",
        channels: ["phone"],
        channelAccountKeyPolicies: { phone: { canonicalAliasesRequireOwnField: "account" } },
      },
    ],
  });

  it("selects the prepared policy without changing plain or explicit-policy lookups", () => {
    withPluginMetadataSnapshotScope(snapshot, () => {
      expect(resolvePublicAccountKey(accounts, "work-phone")).toBeUndefined();
      expect(resolvePublicAccountKey(accounts, "WORK PHONE")).toBe("Work Phone");
      expect(
        resolvePublicAccountKey(accounts, "work-phone", undefined, undefined, {
          channelId: "phone",
        }),
      ).toBe("Work Phone");
      expect(
        resolvePublicAccountKey(accounts, "work-phone", undefined, undefined, {
          channelId: "other",
        }),
      ).toBeUndefined();
      expect(
        resolvePublicAccountKey(
          accounts,
          "work-phone",
          undefined,
          { canonicalAliasesRequireOwnField: "token" },
          { channelId: "phone" },
        ),
      ).toBeUndefined();
      expect(resolvePublicAccountKey(accounts, "work-phone", normalizeRoutingAccountId)).toBe(
        "Work Phone",
      );
      expect(
        resolvePublicAccountKey(accounts, "work-phone", () => "different", undefined, {
          channelId: "phone",
        }),
      ).toBe("Work Phone");
    });
  });

  it("uses channel policy for missing targets and rejects reserved creation through the public entry", () => {
    withPluginMetadataSnapshotScope(snapshot, () => {
      expect(
        resolvePublicAccountKey(undefined, "New Phone", undefined, undefined, {
          channelId: "phone",
          allowMissing: true,
        }),
      ).toBe("new-phone");
      expect(
        resolvePublicAccountKey(undefined, "New Phone", undefined, undefined, {
          allowMissing: true,
        }),
      ).toBe("New Phone");
      for (const accountId of ["constructor", "__proto__", "prototype"]) {
        expect(() =>
          resolvePublicAccountKey(accounts, accountId, undefined, undefined, {
            channelId: "phone",
            allowMissing: true,
          }),
        ).toThrow(`Account id "${accountId}" is reserved`);
      }
    });
  });
});

function createAccountsWithPrototypePollution() {
  const inherited = { default: { id: "polluted" } };
  return Object.create(inherited) as Record<string, { id: string }>;
}

function expectResolvedAccountLookupCase(
  actual: { id: string } | undefined,
  expected: { id: string } | undefined,
) {
  expect(actual).toEqual(expected);
}

function expectPrototypePollutionIgnoredCase(
  resolve: (accounts: Record<string, { id: string }>) => { id: string } | undefined,
) {
  const pollutedAccounts = createAccountsWithPrototypePollution();
  expect(resolve(pollutedAccounts)).toBeUndefined();
}

function expectAccountLookupCase(params: {
  accounts?: Record<string, { id: string }>;
  resolve: (accounts: Record<string, { id: string }>) => { id: string } | undefined;
  expected: { id: string } | undefined;
}) {
  expectResolvedAccountLookupCase(params.resolve(params.accounts ?? {}), params.expected);
}

describe("resolveAccountEntry", () => {
  const accounts = {
    default: { id: "default" },
    Business: { id: "business" },
  };

  it.each([
    {
      name: "resolves the default account key",
      resolve: (localAccounts: Record<string, { id: string }>) =>
        resolveAccountEntry(localAccounts, "default"),
      expected: { id: "default" },
    },
    {
      name: "resolves a normalized business account key",
      resolve: (localAccounts: Record<string, { id: string }>) =>
        resolveAccountEntry(localAccounts, "business"),
      expected: { id: "business" },
    },
  ] as const)("$name", ({ resolve, expected }) => {
    expectAccountLookupCase({ accounts, resolve, expected });
  });

  it("ignores prototype-chain values", () => {
    expectPrototypePollutionIgnoredCase((localAccounts) =>
      resolveAccountEntry(localAccounts, "default"),
    );
  });
});

describe("resolveNormalizedAccountEntry", () => {
  const normalizeAccountId = (accountId: string) =>
    accountId.trim().toLowerCase().replaceAll(" ", "-");

  it.each([
    {
      name: "resolves normalized account keys with a custom normalizer",
      accounts: {
        "Ops Team": { id: "ops" },
      },
      resolve: (accounts: Record<string, { id: string }>) =>
        resolveNormalizedAccountEntry(accounts, "ops-team", normalizeAccountId),
      expected: {
        id: "ops",
      },
    },
    {
      name: "does not resolve blocked raw keys as the default account",
      accounts: JSON.parse('{"__proto__":{"id":"blocked"}}') as Record<string, { id: string }>,
      resolve: (accounts: Record<string, { id: string }>) =>
        resolveNormalizedAccountEntry(accounts, "default", normalizeRoutingAccountId),
      expected: undefined,
    },
    {
      name: "does not resolve keys that normalize to blocked object keys",
      accounts: {
        "constructor ": { id: "blocked" },
      } as Record<string, { id: string }>,
      resolve: (accounts: Record<string, { id: string }>) =>
        resolveNormalizedAccountEntry(accounts, "constructor", (accountId) =>
          accountId.trim().toLowerCase(),
        ),
      expected: undefined,
    },
    {
      name: "does not resolve invalid raw keys through the default account fallback",
      accounts: {
        "constructor ": { id: "blocked" },
      } as Record<string, { id: string }>,
      resolve: (accounts: Record<string, { id: string }>) =>
        resolveNormalizedAccountEntry(accounts, "default", normalizeRoutingAccountId),
      expected: undefined,
    },
    {
      name: "ignores prototype-chain values",
      resolve: () => undefined,
      expected: undefined,
      assert: () =>
        expectPrototypePollutionIgnoredCase((accounts) =>
          resolveNormalizedAccountEntry(accounts, "default", (accountId) => accountId),
        ),
    },
  ] as const)("$name", ({ accounts, resolve, expected, assert }) => {
    if (assert) {
      assert();
      return;
    }

    expectAccountLookupCase({
      accounts,
      resolve,
      expected,
    });
  });
});
