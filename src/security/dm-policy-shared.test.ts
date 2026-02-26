import { describe, expect, it } from "vitest";
import {
  resolveDmAllowState,
  resolveDmGroupAccessDecision,
  resolveDmGroupAccessWithLists,
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
    expect(lists.effectiveGroupAllowFrom).toEqual(["group:abc"]);
  });

  it("falls back to DM allowlist for groups when groupAllowFrom is empty", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: [" owner "],
      groupAllowFrom: [],
      storeAllowFrom: [" owner2 "],
    });
    expect(lists.effectiveAllowFrom).toEqual(["owner", "owner2"]);
    expect(lists.effectiveGroupAllowFrom).toEqual(["owner"]);
  });

  it("can keep group allowlist empty when fallback is disabled", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: ["owner"],
      groupAllowFrom: [],
      storeAllowFrom: ["paired-user"],
      groupAllowFromFallbackToAllowFrom: false,
    });
    expect(lists.effectiveAllowFrom).toEqual(["owner", "paired-user"]);
    expect(lists.effectiveGroupAllowFrom).toEqual([]);
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

  it("keeps group allowlist explicit when dmPolicy is pairing", () => {
    const lists = resolveEffectiveAllowFromLists({
      allowFrom: ["+1111"],
      groupAllowFrom: [],
      storeAllowFrom: ["+2222"],
      dmPolicy: "pairing",
    });
    expect(lists.effectiveAllowFrom).toEqual(["+1111", "+2222"]);
    expect(lists.effectiveGroupAllowFrom).toEqual(["+1111"]);
  });

  it("resolves access + effective allowlists in one shared call", () => {
    const resolved = resolveDmGroupAccessWithLists({
      isGroup: false,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: ["owner"],
      groupAllowFrom: ["group:room"],
      storeAllowFrom: ["paired-user"],
      isSenderAllowed: (allowFrom) => allowFrom.includes("paired-user"),
    });
    expect(resolved.decision).toBe("allow");
    expect(resolved.reason).toBe("dmPolicy=pairing (allowlisted)");
    expect(resolved.effectiveAllowFrom).toEqual(["owner", "paired-user"]);
    expect(resolved.effectiveGroupAllowFrom).toEqual(["group:room"]);
  });

  it("keeps allowlist mode strict in shared resolver (no pairing-store fallback)", () => {
    const resolved = resolveDmGroupAccessWithLists({
      isGroup: false,
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      allowFrom: ["owner"],
      groupAllowFrom: [],
      storeAllowFrom: ["paired-user"],
      isSenderAllowed: () => false,
    });
    expect(resolved.decision).toBe("block");
    expect(resolved.reason).toBe("dmPolicy=allowlist (not allowlisted)");
    expect(resolved.effectiveAllowFrom).toEqual(["owner"]);
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

  it("keeps message/reaction policy parity table across channels", () => {
    const cases = [
      {
        name: "dmPolicy=open",
        dmPolicy: "open" as const,
        allowFrom: [] as string[],
        senderAllowed: false,
        expectedDecision: "allow" as const,
        expectedReactionAllowed: true,
      },
      {
        name: "dmPolicy=disabled",
        dmPolicy: "disabled" as const,
        allowFrom: [] as string[],
        senderAllowed: false,
        expectedDecision: "block" as const,
        expectedReactionAllowed: false,
      },
      {
        name: "dmPolicy=allowlist unauthorized",
        dmPolicy: "allowlist" as const,
        allowFrom: ["owner"],
        senderAllowed: false,
        expectedDecision: "block" as const,
        expectedReactionAllowed: false,
      },
      {
        name: "dmPolicy=allowlist authorized",
        dmPolicy: "allowlist" as const,
        allowFrom: ["owner"],
        senderAllowed: true,
        expectedDecision: "allow" as const,
        expectedReactionAllowed: true,
      },
      {
        name: "dmPolicy=pairing unauthorized",
        dmPolicy: "pairing" as const,
        allowFrom: [] as string[],
        senderAllowed: false,
        expectedDecision: "pairing" as const,
        expectedReactionAllowed: false,
      },
    ];

    for (const channel of channels) {
      for (const testCase of cases) {
        const access = resolveDmGroupAccessWithLists({
          isGroup: false,
          dmPolicy: testCase.dmPolicy,
          groupPolicy: "allowlist",
          allowFrom: testCase.allowFrom,
          groupAllowFrom: [],
          storeAllowFrom: [],
          isSenderAllowed: () => testCase.senderAllowed,
        });
        const reactionAllowed = access.decision === "allow";
        expect(access.decision, `[${channel}] ${testCase.name}`).toBe(testCase.expectedDecision);
        expect(reactionAllowed, `[${channel}] ${testCase.name} reaction`).toBe(
          testCase.expectedReactionAllowed,
        );
      }
    }
  });

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
