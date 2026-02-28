import { describe, expect, it } from "vitest";
import {
  DM_GROUP_ACCESS_REASON,
  readStoreAllowFromForDmPolicy,
  resolveDmAllowState,
  resolveDmGroupAccessWithCommandGate,
  resolveDmGroupAccessDecision,
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
} from "./dm-policy-shared.js";

describe("security/dm-policy-shared", () => {
  it("normalizes config + store allow entries and counts distinct senders", async () => {
    const state = await resolveDmAllowState({
      provider: "telegram",
      accountId: "default",
      allowFrom: [" * ", " alice ", "ALICE", "bob"],
      normalizeEntry: (value) => value.toLowerCase(),
      readStore: async (_provider, _accountId) => [" Bob ", "carol", ""],
    });
    expect(state.configAllowFrom).toEqual(["*", "alice", "ALICE", "bob"]);
    expect(state.hasWildcard).toBe(true);
    expect(state.allowCount).toBe(3);
    expect(state.isMultiUserDm).toBe(true);
  });

  it("handles empty allowlists and store failures", async () => {
    const state = await resolveDmAllowState({
      provider: "slack",
      accountId: "default",
      allowFrom: undefined,
      readStore: async (_provider, _accountId) => {
        throw new Error("offline");
      },
    });
    expect(state.configAllowFrom).toEqual([]);
    expect(state.hasWildcard).toBe(false);
    expect(state.allowCount).toBe(0);
    expect(state.isMultiUserDm).toBe(false);
  });

  it("skips pairing-store reads when dmPolicy is allowlist", async () => {
    let called = false;
    const storeAllowFrom = await readStoreAllowFromForDmPolicy({
      provider: "telegram",
      accountId: "default",
      dmPolicy: "allowlist",
      readStore: async (_provider, _accountId) => {
        called = true;
        return ["should-not-be-read"];
      },
    });
    expect(called).toBe(false);
    expect(storeAllowFrom).toEqual([]);
  });

  it("skips pairing-store reads when shouldRead=false", async () => {
    let called = false;
    const storeAllowFrom = await readStoreAllowFromForDmPolicy({
      provider: "slack",
      accountId: "default",
      shouldRead: false,
      readStore: async (_provider, _accountId) => {
        called = true;
        return ["should-not-be-read"];
      },
    });
    expect(called).toBe(false);
    expect(storeAllowFrom).toEqual([]);
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
    expect(resolved.reasonCode).toBe(DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED);
    expect(resolved.reason).toBe("dmPolicy=pairing (allowlisted)");
    expect(resolved.effectiveAllowFrom).toEqual(["owner", "paired-user"]);
    expect(resolved.effectiveGroupAllowFrom).toEqual(["group:room"]);
  });

  it("resolves command gate with dm/group parity for groups", () => {
    const resolved = resolveDmGroupAccessWithCommandGate({
      isGroup: true,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: ["owner"],
      groupAllowFrom: ["group-owner"],
      storeAllowFrom: ["paired-user"],
      isSenderAllowed: (allowFrom) => allowFrom.includes("paired-user"),
      command: {
        useAccessGroups: true,
        allowTextCommands: true,
        hasControlCommand: true,
      },
    });
    expect(resolved.decision).toBe("block");
    expect(resolved.reason).toBe("groupPolicy=allowlist (not allowlisted)");
    expect(resolved.commandAuthorized).toBe(false);
    expect(resolved.shouldBlockControlCommand).toBe(true);
  });

  it("keeps configured dm allowlist usable for group command auth", () => {
    const resolved = resolveDmGroupAccessWithCommandGate({
      isGroup: true,
      dmPolicy: "pairing",
      groupPolicy: "open",
      allowFrom: ["owner"],
      groupAllowFrom: [],
      storeAllowFrom: ["paired-user"],
      isSenderAllowed: (allowFrom) => allowFrom.includes("owner"),
      command: {
        useAccessGroups: true,
        allowTextCommands: true,
        hasControlCommand: true,
      },
    });
    expect(resolved.commandAuthorized).toBe(true);
    expect(resolved.shouldBlockControlCommand).toBe(false);
  });

  it("treats dm command authorization as dm access result", () => {
    const resolved = resolveDmGroupAccessWithCommandGate({
      isGroup: false,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: ["owner"],
      groupAllowFrom: ["group-owner"],
      storeAllowFrom: ["paired-user"],
      isSenderAllowed: (allowFrom) => allowFrom.includes("paired-user"),
      command: {
        useAccessGroups: true,
        allowTextCommands: true,
        hasControlCommand: true,
      },
    });
    expect(resolved.decision).toBe("allow");
    expect(resolved.commandAuthorized).toBe(true);
    expect(resolved.shouldBlockControlCommand).toBe(false);
  });

  it("does not auto-authorize dm commands in open mode without explicit allowlists", () => {
    const resolved = resolveDmGroupAccessWithCommandGate({
      isGroup: false,
      dmPolicy: "open",
      groupPolicy: "allowlist",
      allowFrom: [],
      groupAllowFrom: [],
      storeAllowFrom: [],
      isSenderAllowed: () => false,
      command: {
        useAccessGroups: true,
        allowTextCommands: true,
        hasControlCommand: true,
      },
    });
    expect(resolved.decision).toBe("allow");
    expect(resolved.commandAuthorized).toBe(false);
    expect(resolved.shouldBlockControlCommand).toBe(false);
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
    expect(resolved.reasonCode).toBe(DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED);
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
        isGroup: false,
        dmPolicy: "open" as const,
        groupPolicy: "allowlist" as const,
        allowFrom: [] as string[],
        groupAllowFrom: [] as string[],
        storeAllowFrom: [] as string[],
        isSenderAllowed: () => false,
        expectedDecision: "allow" as const,
        expectedReactionAllowed: true,
      },
      {
        name: "dmPolicy=disabled",
        isGroup: false,
        dmPolicy: "disabled" as const,
        groupPolicy: "allowlist" as const,
        allowFrom: [] as string[],
        groupAllowFrom: [] as string[],
        storeAllowFrom: [] as string[],
        isSenderAllowed: () => false,
        expectedDecision: "block" as const,
        expectedReactionAllowed: false,
      },
      {
        name: "dmPolicy=allowlist unauthorized",
        isGroup: false,
        dmPolicy: "allowlist" as const,
        groupPolicy: "allowlist" as const,
        allowFrom: ["owner"],
        groupAllowFrom: [] as string[],
        storeAllowFrom: [] as string[],
        isSenderAllowed: () => false,
        expectedDecision: "block" as const,
        expectedReactionAllowed: false,
      },
      {
        name: "dmPolicy=allowlist authorized",
        isGroup: false,
        dmPolicy: "allowlist" as const,
        groupPolicy: "allowlist" as const,
        allowFrom: ["owner"],
        groupAllowFrom: [] as string[],
        storeAllowFrom: [] as string[],
        isSenderAllowed: () => true,
        expectedDecision: "allow" as const,
        expectedReactionAllowed: true,
      },
      {
        name: "dmPolicy=pairing unauthorized",
        isGroup: false,
        dmPolicy: "pairing" as const,
        groupPolicy: "allowlist" as const,
        allowFrom: [] as string[],
        groupAllowFrom: [] as string[],
        storeAllowFrom: [] as string[],
        isSenderAllowed: () => false,
        expectedDecision: "pairing" as const,
        expectedReactionAllowed: false,
      },
      {
        name: "groupPolicy=allowlist rejects DM-paired sender not in explicit group list",
        isGroup: true,
        dmPolicy: "pairing" as const,
        groupPolicy: "allowlist" as const,
        allowFrom: ["owner"] as string[],
        groupAllowFrom: ["group-owner"] as string[],
        storeAllowFrom: ["paired-user"] as string[],
        isSenderAllowed: (allowFrom: string[]) => allowFrom.includes("paired-user"),
        expectedDecision: "block" as const,
        expectedReactionAllowed: false,
      },
    ];

    for (const channel of channels) {
      for (const testCase of cases) {
        const access = resolveDmGroupAccessWithLists({
          isGroup: testCase.isGroup,
          dmPolicy: testCase.dmPolicy,
          groupPolicy: testCase.groupPolicy,
          allowFrom: testCase.allowFrom,
          groupAllowFrom: testCase.groupAllowFrom,
          storeAllowFrom: testCase.storeAllowFrom,
          isSenderAllowed: testCase.isSenderAllowed,
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
        reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
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
        reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_PAIRING_REQUIRED,
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
        reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED,
        reason: "groupPolicy=allowlist (not allowlisted)",
      });
    });
  }
});
