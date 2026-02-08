import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedAllowFrom } from "./bot-access.js";
import {
  clearGroupMembershipCache,
  invalidateGroupMembership,
  verifyGroupMembership,
} from "./group-membership-cache.js";

function makeAllowFrom(entries: string[], hasWildcard = false): NormalizedAllowFrom {
  return {
    entries,
    entriesLower: entries.map((e) => e.toLowerCase()),
    hasWildcard,
    hasEntries: entries.length > 0 || hasWildcard,
  };
}

function makeApi(opts: {
  memberCount?: number;
  members?: Record<number, string>; // userId -> status
  countError?: boolean;
  memberError?: boolean;
}) {
  return {
    getChatMemberCount: vi.fn(async () => {
      if (opts.countError) {
        throw new Error("API error");
      }
      return opts.memberCount ?? 0;
    }),
    getChatMember: vi.fn(async (_chatId: number, userId: number) => {
      if (opts.memberError) {
        throw new Error("API error");
      }
      const status = opts.members?.[userId] ?? "left";
      return { status };
    }),
  } as unknown as import("grammy").Api;
}

describe("group-membership-cache", () => {
  afterEach(() => {
    clearGroupMembershipCache();
  });

  it("returns trusted when all members are in allowlist + bot", async () => {
    const api = makeApi({
      memberCount: 3, // 2 trusted users + 1 bot
      members: { 111: "member", 222: "member", 999: "member" },
    });
    const result = await verifyGroupMembership({
      chatId: -100123,
      api,
      botId: 999,
      allowFrom: makeAllowFrom(["111", "222"]),
    });
    expect(result.trusted).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns untrusted when unknown members present (count mismatch)", async () => {
    const api = makeApi({
      memberCount: 5, // more than 2 trusted + 1 bot
      members: { 111: "member", 222: "member" },
    });
    const result = await verifyGroupMembership({
      chatId: -100456,
      api,
      botId: 999,
      allowFrom: makeAllowFrom(["111", "222"]),
    });
    expect(result.trusted).toBe(false);
    expect(result.reason).toContain("member-count-mismatch");
  });

  it("caches results (no API call on second check)", async () => {
    const api = makeApi({
      memberCount: 2,
      members: { 111: "member", 999: "member" },
    });
    const allowFrom = makeAllowFrom(["111"]);

    const r1 = await verifyGroupMembership({ chatId: -100789, api, botId: 999, allowFrom });
    expect(r1.trusted).toBe(true);

    const r2 = await verifyGroupMembership({ chatId: -100789, api, botId: 999, allowFrom });
    expect(r2.trusted).toBe(true);

    // getChatMemberCount should only be called once (first call), not on cached second call
    expect((api.getChatMemberCount as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("invalidateGroupMembership clears cache for that chat", async () => {
    const api = makeApi({
      memberCount: 2,
      members: { 111: "member", 999: "member" },
    });
    const allowFrom = makeAllowFrom(["111"]);

    await verifyGroupMembership({ chatId: -100111, api, botId: 999, allowFrom });
    expect((api.getChatMemberCount as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    invalidateGroupMembership(-100111);

    await verifyGroupMembership({ chatId: -100111, api, botId: 999, allowFrom });
    // Should have called API again after invalidation
    expect((api.getChatMemberCount as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("fails closed on API error (getChatMemberCount)", async () => {
    const api = makeApi({ countError: true });
    const result = await verifyGroupMembership({
      chatId: -100222,
      api,
      botId: 999,
      allowFrom: makeAllowFrom(["111"]),
    });
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe("api-error");
  });

  it("returns untrusted when no numeric entries in allowFrom", async () => {
    const api = makeApi({ memberCount: 2 });
    const result = await verifyGroupMembership({
      chatId: -100333,
      api,
      botId: 999,
      allowFrom: makeAllowFrom(["@alice", "@bob"]),
    });
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe("no-numeric-ids");
    // Should not call API at all
    expect((api.getChatMemberCount as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("returns trusted immediately if allowFrom has wildcard", async () => {
    const api = makeApi({ memberCount: 100 });
    const result = await verifyGroupMembership({
      chatId: -100444,
      api,
      botId: 999,
      allowFrom: makeAllowFrom([], true),
    });
    expect(result.trusted).toBe(true);
    // Should not call API at all
    expect((api.getChatMemberCount as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("handles members who left the group correctly", async () => {
    const api = makeApi({
      memberCount: 2, // 1 trusted user + 1 bot
      members: { 111: "member", 222: "left", 999: "member" },
    });
    const result = await verifyGroupMembership({
      chatId: -100555,
      api,
      botId: 999,
      allowFrom: makeAllowFrom(["111", "222"]),
    });
    // 2 present (111 + bot 999), 222 left → 2 present = 2 total = trusted
    expect(result.trusted).toBe(true);
  });

  it("returns untrusted when getChatMember fails for all users", async () => {
    const api = makeApi({
      memberCount: 2,
      memberError: true,
    });
    const result = await verifyGroupMembership({
      chatId: -100666,
      api,
      botId: 999,
      allowFrom: makeAllowFrom(["111"]),
    });
    // 0 present (all getChatMember calls fail), but total is 2 → untrusted
    expect(result.trusted).toBe(false);
  });
});
