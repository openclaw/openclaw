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

describe("resolveAccountEntry", () => {
  const accounts = { default: { id: "default" }, Business: { id: "business" } };

  it.each([
    ["default", "default"],
    ["business", "business"],
  ])("resolves %s to %s", (accountId, id) => {
    expect(resolveAccountEntry(accounts, accountId)).toEqual({ id });
  });

  it("ignores prototype-chain values", () => {
    expect(
      resolveAccountEntry(Object.create({ default: { id: "polluted" } }), "default"),
    ).toBeUndefined();
  });
});

describe("resolveNormalizedAccountEntry", () => {
  it("resolves normalized account keys with a custom normalizer", () => {
    expect(
      resolveNormalizedAccountEntry({ "Ops Team": { id: "ops" } }, "ops-team", (id) =>
        id.trim().toLowerCase().replaceAll(" ", "-"),
      ),
    ).toEqual({ id: "ops" });
  });

  it.each([
    {
      name: "blocked raw keys",
      key: "__proto__",
      accountId: "default",
      normalize: normalizeRoutingAccountId,
    },
    {
      name: "keys that normalize to blocked object keys",
      key: "constructor ",
      accountId: "constructor",
      normalize: (id: string) => id.trim().toLowerCase(),
    },
    {
      name: "invalid raw keys through the default account fallback",
      key: "constructor ",
      accountId: "default",
      normalize: normalizeRoutingAccountId,
    },
  ])("does not resolve $name", ({ key, accountId, normalize }) => {
    expect(
      resolveNormalizedAccountEntry({ [key]: { id: "blocked" } }, accountId, normalize),
    ).toBeUndefined();
  });

  it("ignores prototype-chain values", () => {
    expect(
      resolveNormalizedAccountEntry(
        Object.create({ default: { id: "polluted" } }),
        "default",
        (id) => id,
      ),
    ).toBeUndefined();
  });
});
