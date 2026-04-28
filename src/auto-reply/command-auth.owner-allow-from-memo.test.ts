import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  isOwnerAllowFromListMemoizedForTest,
  resolveOwnerAllowFromListForTest,
} from "./command-auth.js";
import { installDiscordRegistryHooks } from "./test-helpers/command-auth-registry-fixture.js";

installDiscordRegistryHooks();

// Regression coverage for #50289: large `commands.ownerAllowFrom` lists used
// to be re-walked O(n) on every inbound message because every authorization
// pass called resolveOwnerAllowFromList twice. Memoize the per-array
// filtering so subsequent calls with the same raw array hit a cache.

describe("resolveOwnerAllowFromList memoization (#50289)", () => {
  it("returns identical results across repeated calls for the same raw array", () => {
    const raw = ["123", "456", "discord:789", "telegram:42", "*"];
    const cfg = {
      commands: { ownerAllowFrom: raw },
      channels: { discord: {} },
    } as unknown as OpenClawConfig;

    const first = resolveOwnerAllowFromListForTest({
      cfg,
      accountId: "acct-1",
      providerId: "discord",
      allowFrom: raw,
    });
    const second = resolveOwnerAllowFromListForTest({
      cfg,
      accountId: "acct-1",
      providerId: "discord",
      allowFrom: raw,
    });

    expect(first).toEqual(second);
    // Subsequent call must hit the cache (same array reference).
    expect(
      isOwnerAllowFromListMemoizedForTest(raw, { accountId: "acct-1", providerId: "discord" }),
    ).toBe(true);
  });

  it("memoizes per (providerId, accountId, plugin.id) so different lookup keys do not collide", () => {
    const raw = ["123", "456", "discord:789", "telegram:42"];
    const cfg = { commands: { ownerAllowFrom: raw } } as unknown as OpenClawConfig;

    const discordList = resolveOwnerAllowFromListForTest({
      cfg,
      accountId: "acct-1",
      providerId: "discord",
      allowFrom: raw,
    });
    const telegramList = resolveOwnerAllowFromListForTest({
      cfg,
      accountId: "acct-1",
      providerId: "telegram",
      allowFrom: raw,
    });

    // discord-scoped entries (`discord:789`) drop the prefix and survive the
    // discord pass. telegram-scoped entries (`telegram:42`) drop the prefix
    // and survive the telegram pass. Plain entries appear in both.
    expect(discordList).toContain("789");
    expect(discordList).not.toContain("42");
    expect(telegramList).toContain("42");
    expect(telegramList).not.toContain("789");

    // Both discord and telegram results are independently cached on the same
    // raw array; no stale cross-pollination between provider passes.
    expect(
      isOwnerAllowFromListMemoizedForTest(raw, { accountId: "acct-1", providerId: "discord" }),
    ).toBe(true);
    expect(
      isOwnerAllowFromListMemoizedForTest(raw, { accountId: "acct-1", providerId: "telegram" }),
    ).toBe(true);
  });

  it("treats a freshly-allocated raw array as a cache miss (config reload semantics)", () => {
    const initial = ["alice", "bob", "discord:carol"];
    const reloaded = ["alice", "bob", "discord:carol"];
    const cfg = { commands: { ownerAllowFrom: initial } } as unknown as OpenClawConfig;

    resolveOwnerAllowFromListForTest({
      cfg,
      accountId: "acct-2",
      providerId: "discord",
      allowFrom: initial,
    });

    // After a config reload, the operator's array is replaced with a fresh
    // allocation; the WeakMap entry on the old array is unreachable, and the
    // new array starts uncached.
    expect(
      isOwnerAllowFromListMemoizedForTest(reloaded, {
        accountId: "acct-2",
        providerId: "discord",
      }),
    ).toBe(false);

    resolveOwnerAllowFromListForTest({
      cfg: { commands: { ownerAllowFrom: reloaded } } as unknown as OpenClawConfig,
      accountId: "acct-2",
      providerId: "discord",
      allowFrom: reloaded,
    });

    expect(
      isOwnerAllowFromListMemoizedForTest(reloaded, {
        accountId: "acct-2",
        providerId: "discord",
      }),
    ).toBe(true);
  });

  it("returns an empty list for empty/missing input without populating the cache", () => {
    const cfg = { commands: {} } as unknown as OpenClawConfig;
    expect(
      resolveOwnerAllowFromListForTest({ cfg, accountId: null, providerId: "discord" }),
    ).toEqual([]);
    expect(
      resolveOwnerAllowFromListForTest({
        cfg,
        accountId: null,
        providerId: "discord",
        allowFrom: [],
      }),
    ).toEqual([]);
  });
});
