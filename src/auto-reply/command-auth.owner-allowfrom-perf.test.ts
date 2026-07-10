/** Tests ownerAllowFrom authorization correctness and Set-lookup behavior for large lists (#50289). */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import type { MsgContext } from "./templating.js";
import { installDiscordRegistryHooks } from "./test-helpers/command-auth-registry-fixture.js";

installDiscordRegistryHooks();

function buildLargeOwnerAllowFrom(count: number): string[] {
  const entries: string[] = [];
  for (let i = 0; i < count; i++) {
    entries.push(`user${i}`);
  }
  return entries;
}

describe("ownerAllowFrom authorization with large lists (#50289)", () => {
  it("correctly identifies an owner from a large ownerAllowFrom list", () => {
    const targetSenderId = "target-user";
    const largeList = buildLargeOwnerAllowFrom(5000);
    largeList.push(targetSenderId);

    const cfg = {
      channels: { discord: {} },
      commands: {
        ownerAllowFrom: largeList,
      },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      From: `discord:${targetSenderId}`,
      SenderId: targetSenderId,
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(true);
    expect(auth.ownerList).toContain(targetSenderId);
  });

  it("correctly rejects a non-owner from a large ownerAllowFrom list", () => {
    const largeList = buildLargeOwnerAllowFrom(5000);

    const cfg = {
      channels: { discord: {} },
      commands: {
        ownerAllowFrom: largeList,
      },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      From: "discord:unknown-user",
      SenderId: "unknown-user",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
  });

  it("handles channel-prefixed entries in a large ownerAllowFrom list", () => {
    const targetSenderId = "channel-user";
    const largeList = buildLargeOwnerAllowFrom(3000);
    largeList.push(`discord:${targetSenderId}`);

    const cfg = {
      channels: { discord: {} },
      commands: {
        ownerAllowFrom: largeList,
      },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      From: `discord:${targetSenderId}`,
      SenderId: targetSenderId,
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(true);
  });

  it("does not match channel-prefixed entries from a different provider", () => {
    const targetSenderId = "telegram-user";
    const largeList = buildLargeOwnerAllowFrom(3000);
    largeList.push(`telegram:${targetSenderId}`);

    const cfg = {
      channels: { discord: {} },
      commands: {
        ownerAllowFrom: largeList,
      },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      From: `discord:${targetSenderId}`,
      SenderId: targetSenderId,
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    // telegram-prefixed entry should not grant owner on discord
    expect(auth.senderIsOwner).toBe(false);
  });

  it("large lists complete in reasonable time (Set-based lookup proof)", () => {
    const largeList = buildLargeOwnerAllowFrom(10000);
    const targetSenderId = "perf-test-user";
    largeList.push(`discord:${targetSenderId}`);

    const cfg = {
      channels: { discord: {} },
      commands: {
        ownerAllowFrom: largeList,
      },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      From: `discord:${targetSenderId}`,
      SenderId: targetSenderId,
    } as MsgContext;

    const start = performance.now();
    // Resolve many times to amplify any O(n²) behavior
    for (let i = 0; i < 100; i++) {
      resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true });
    }
    const elapsed = performance.now() - start;

    // 100 resolutions with 10k entries should complete in well under 1 second
    // with Set-based O(1) lookup. Before the fix (Array.includes O(n)),
    // this would be orders of magnitude slower.
    expect(elapsed).toBeLessThan(1000);
  });
});
