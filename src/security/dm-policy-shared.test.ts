import { describe, expect, it } from "vitest";
import {
  resolveDmAllowState,
  resolveDmGroupAccessDecision,
  resolveEffectiveAllowFromLists,
} from "./dm-policy-shared.js";

describe("security/dm-policy-shared", () => {
  it("normalizes config + store allow entries and counts distinct senders", async () => {
    const state = await resolveDmAllowState({
      provider: "telegram",
      allowFrom: [" * ", " alice ", "ALICE", "bob"],
      normalizeEntry: (value) => value.toLowerCase(),
      readStore: async () => [" Bob ", "carol", ""],
    });
    expect(state.configAllowFrom).toEqual(["*", "alice", "ALICE", "bob"]);
    expect(state.hasWildcard).toBe(true);
    expect(state.allowCount).toBe(3);
    expect(state.isMultiUserDm).toBe(true);
  });

  it("handles empty allowlists and store failures", async () => {
    const state = await resolveDmAllowState({
      provider: "slack",
      allowFrom: undefined,
      readStore: async () => {
        throw new Error("offline");
      },
    });
    expect(state.configAllowFrom).toEqual([]);
    expect(state.hasWildcard).toBe(false);
    expect(state.allowCount).toBe(0);
    expect(state.isMultiUserDm).toBe(false);
  });

  it("builds effective DM/group allowlists from config + pairing store", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: [" owner ", "", "owner2"],
      groupAllowFrom: ["group:abc"],
      storeAllowFrom: [" owner3 ", ""],
    });
    expect(lists.effectiveAllowFrom).toEqual(["owner", "owner2", "owner3"]);
    expect(lists.effectiveGroupAllowFrom).toEqual(["group:abc", "owner3"]);
  });

  it("falls back to DM allowlist for groups when groupAllowFrom is empty", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: [" owner "],
      groupAllowFrom: [],
      storeAllowFrom: [" owner2 "],
    });
    expect(lists.effectiveAllowFrom).toEqual(["owner", "owner2"]);
    expect(lists.effectiveGroupAllowFrom).toEqual(["owner", "owner2"]);
  });

  it("excludes storeAllowFrom when dmPolicy is allowlist", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: ["+1111"],
      groupAllowFrom: ["group:abc"],
      storeAllowFrom: ["+2222", "+3333"],
      dmPolicy: "allowlist",
    });
    expect(lists.effectiveAllowFrom).toEqual(["+1111"]);
    expect(lists.effectiveGroupAllowFrom).toEqual(["group:abc"]);
  });

  it("includes storeAllowFrom when dmPolicy is pairing", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: ["+1111"],
      groupAllowFrom: [],
      storeAllowFrom: ["+2222"],
      dmPolicy: "pairing",
    });
    expect(lists.effectiveAllowFrom).toEqual(["+1111", "+2222"]);
    expect(lists.effectiveGroupAllowFrom).toEqual(["+1111", "+2222"]);
  });

  const channels = [
    "bluebubbles",
    "imessage",
    "signal",
    "telegram",
    "whatsapp",
    "msteams",
    "matrix",
    "zalo",
  ] as const;

  for (const channel of channels) {
    it(`[${channel}] blocks DM allowlist mode when allowlist is empty`, () => {
      const decision = resolveDmGroupAccessDecision({
        isGroup: false,
        dmPolicy: "allowlist",
        groupPolicy: "allowlist",
        effectiveAllowFrom: [],
        effectiveGroupAllowFrom: [],
        isSenderAllowed: () => false,
      });
      expect(decision).toEqual({
        decision: "block",
        reason: "dmPolicy=allowlist (not allowlisted)",
      });
    });

    it(`[${channel}] uses pairing flow when DM sender is not allowlisted`, () => {
      const decision = resolveDmGroupAccessDecision({
        isGroup: false,
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        effectiveAllowFrom: [],
        effectiveGroupAllowFrom: [],
        isSenderAllowed: () => false,
      });
      expect(decision).toEqual({
        decision: "pairing",
        reason: "dmPolicy=pairing (not allowlisted)",
      });
    });

    it(`[${channel}] allows DM sender when allowlisted`, () => {
      const decision = resolveDmGroupAccessDecision({
        isGroup: false,
        dmPolicy: "allowlist",
        groupPolicy: "allowlist",
        effectiveAllowFrom: ["owner"],
        effectiveGroupAllowFrom: [],
        isSenderAllowed: () => true,
      });
      expect(decision.decision).toBe("allow");
    });

    it(`[${channel}] blocks group allowlist mode when sender/group is not allowlisted`, () => {
      const decision = resolveDmGroupAccessDecision({
        isGroup: true,
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        effectiveAllowFrom: ["owner"],
        effectiveGroupAllowFrom: ["group:abc"],
        isSenderAllowed: () => false,
      });
      expect(decision).toEqual({
        decision: "block",
        reason: "groupPolicy=allowlist (not allowlisted)",
      });
    });
  }
});
