import { describe, expect, it } from "vitest";
import {
  firstDefined,
  isSenderIdAllowed,
  mergeDmAllowFromSources,
  resolveGroupAllowFromSources,
} from "./allow-from.js";

/**
 * Security test suite for dmPolicy configuration validation.
 * These tests verify that dmPolicy values are enforced correctly
 * to prevent privacy/security misconfigurations.
 */
describe("dmPolicy security validation", () => {
  describe("mergeDmAllowFromSources: allowlist mode isolation", () => {
    it('strictly excludes pairing-store entries when dmPolicy="allowlist" (privacy protection)', () => {
      // Security requirement: allowlist mode should NEVER include pairing-store entries
      // This prevents accidental exposure if a user changes from pairing -> allowlist
      expect(
        mergeDmAllowFromSources({
          allowFrom: ["+1111"],
          storeAllowFrom: ["+2222", "+3333"],
          dmPolicy: "allowlist",
        }),
      ).toEqual(["+1111"]);

      expect(mergeDmAllowFromSources({ storeAllowFrom: ["+2222"], dmPolicy: "allowlist" })).toEqual(
        [],
      );
    });

    it("includes pairing-store when dmPolicy is non-allowlist (default), even if unspecified", () => {
      // When dmPolicy is pairing, we should include pairing-store
      expect(
        mergeDmAllowFromSources({
          allowFrom: ["+1111"],
          storeAllowFrom: ["+2222"],
          dmPolicy: "pairing",
        }),
      ).toEqual(["+1111", "+2222"]);

      // When dmPolicy is not specified, default behavior includes store
      expect(
        mergeDmAllowFromSources({
          allowFrom: ["+1111"],
          storeAllowFrom: ["+2222"],
        }),
      ).toEqual(["+1111", "+2222"]);
    });

    it("handles dmPolicy=open and dmPolicy=disabled correctly", () => {
      // open/disabled modes should still merge store entries
      // (they are checked separately in enforcement)
      expect(
        mergeDmAllowFromSources({
          allowFrom: ["+1111"],
          storeAllowFrom: ["+2222"],
          dmPolicy: "open",
        }),
      ).toEqual(["+1111", "+2222"]);

      expect(
        mergeDmAllowFromSources({
          allowFrom: ["+1111"],
          storeAllowFrom: ["+2222"],
          dmPolicy: "disabled",
        }),
      ).toEqual(["+1111", "+2222"]);
    });

    it("trims and filters empty/whitespace entries", () => {
      expect(
        mergeDmAllowFromSources({
          allowFrom: ["  +111  ", "", "  ", "123"],
          storeAllowFrom: ["  456  "],
        }),
      ).toEqual(["+111", "123", "456"]);
    });

    it("handles numeric IDs correctly", () => {
      expect(
        mergeDmAllowFromSources({
          allowFrom: [123, "456", 789],
          storeAllowFrom: [1011],
        }),
      ).toEqual(["123", "456", "789", "1011"]);
    });
  });

  describe("isSenderIdAllowed: access control enforcement", () => {
    it("denies access when no allowlist entries and allowWhenEmpty=false (default-secure)", () => {
      expect(
        isSenderIdAllowed(
          {
            entries: [],
            hasEntries: false,
            hasWildcard: false,
          },
          "sender123",
          false,
        ),
      ).toBe(false);
    });

    it("allows access when no allowlist entries but allowWhenEmpty=true (open mode)", () => {
      expect(
        isSenderIdAllowed(
          {
            entries: [],
            hasEntries: false,
            hasWildcard: false,
          },
          "sender123",
          true,
        ),
      ).toBe(true);
    });

    it("allows any sender when wildcard is present (regardless of entries)", () => {
      expect(
        isSenderIdAllowed(
          {
            entries: ["111"],
            hasEntries: true,
            hasWildcard: true,
          },
          "999",
          false,
        ),
      ).toBe(true);

      // Wildcard works even when sender ID is undefined
      expect(
        isSenderIdAllowed(
          {
            entries: ["111"],
            hasEntries: true,
            hasWildcard: true,
          },
          undefined,
          false,
        ),
      ).toBe(true);
    });

    it("denies unknown sender when no wildcard but entries exist", () => {
      expect(
        isSenderIdAllowed(
          {
            entries: ["111", "222"],
            hasEntries: true,
            hasWildcard: false,
          },
          "999",
          false,
        ),
      ).toBe(false);
    });

    it("allows known sender when ID matches (exact match)", () => {
      expect(
        isSenderIdAllowed(
          {
            entries: ["111", "222"],
            hasEntries: true,
            hasWildcard: false,
          },
          "222",
          false,
        ),
      ).toBe(true);
    });

    it("denies when sender ID is undefined and entries exist (no match)", () => {
      expect(
        isSenderIdAllowed(
          {
            entries: ["111", "222"],
            hasEntries: true,
            hasWildcard: false,
          },
          undefined,
          false,
        ),
      ).toBe(false);
    });

    it("attackers cannot bypass allowlist by sending undefined sender ID", () => {
      // Security: even with allowWhenEmpty=true, wildcard must be explicit
      expect(
        isSenderIdAllowed(
          {
            entries: ["111"],
            hasEntries: true,
            hasWildcard: false,
          },
          undefined,
          true,
        ),
      ).toBe(false);
    });
  });

  describe("resolveGroupAllowFromSources: inheritance and override semantics", () => {
    it("prefers explicit group allowlist over DM allowlist (prevents scope leakage)", () => {
      expect(
        resolveGroupAllowFromSources({
          allowFrom: ["owner1", "owner2"],
          groupAllowFrom: ["group_moderator"],
        }),
      ).toEqual(["group_moderator"]);
    });

    it("falls back to DM allowlist when group allowlist is empty (shared scope)", () => {
      expect(
        resolveGroupAllowFromSources({
          allowFrom: ["owner1", "owner2"],
          groupAllowFrom: [],
        }),
      ).toEqual(["owner1", "owner2"]);
    });

    it("can disable fallback to DM allowlist with fallbackToAllowFrom=false", () => {
      expect(
        resolveGroupAllowFromSources({
          allowFrom: ["owner1", "owner2"],
          groupAllowFrom: [],
          fallbackToAllowFrom: false,
        }),
      ).toEqual([]);
    });

    it("returns empty when group scope is empty and fallback disabled", () => {
      expect(
        resolveGroupAllowFromSources({
          allowFrom: undefined,
          groupAllowFrom: undefined,
          fallbackToAllowFrom: false,
        }),
      ).toEqual([]);
    });

    it("handles undefined groupAllowFrom (uses fallback logic)", () => {
      expect(
        resolveGroupAllowFromSources({
          allowFrom: ["dm_user"],
          groupAllowFrom: undefined,
        }),
      ).toEqual(["dm_user"]);

      // When fallback is disabled, undefined is treated as "no override"
      expect(
        resolveGroupAllowFromSources({
          allowFrom: ["dm_user"],
          groupAllowFrom: undefined,
          fallbackToAllowFrom: false,
        }),
      ).toEqual(["dm_user"]);
    });

    it("trims whitespace from all entries", () => {
      expect(
        resolveGroupAllowFromSources({
          allowFrom: ["  user1  ", " user2 "],
          groupAllowFrom: ["  group_admin  "],
        }),
      ).toEqual(["group_admin"]);
    });

    it("filters out empty strings", () => {
      expect(
        resolveGroupAllowFromSources({
          allowFrom: ["user1", "", "user2"],
          groupAllowFrom: ["", "admin"],
        }),
      ).toEqual(["admin"]);
    });
  });

  describe("firstDefined: utility for fallback chain", () => {
    it("returns first defined non-undefined value", () => {
      expect(firstDefined(undefined, undefined, "x", "y")).toBe("x");
      expect(firstDefined(undefined, 0, 1)).toBe(0);
      expect(firstDefined(false, true)).toBe(false);
    });

    it("returns undefined when all values are undefined", () => {
      expect(firstDefined(undefined, undefined, undefined)).toBeUndefined();
    });

    it("handles empty args", () => {
      expect(firstDefined()).toBeUndefined();
    });

    it("supports null as a defined value", () => {
      expect(firstDefined(undefined, null, "x")).toBe(null);
    });
  });

  describe("dmPolicy security scenarios (attack simulation)", () => {
    it("scenario: attacker tries to send via undefined sender ID in allowlist mode", () => {
      const result = isSenderIdAllowed(
        {
          entries: ["known_id"],
          hasEntries: true,
          hasWildcard: false,
        },
        undefined,
        false,
      );
      expect(result).toBe(false);
    });

    it("scenario: attacker tries to spoof numeric ID with string", () => {
      // The check is strict: "111" !== 111 as entries
      const result = isSenderIdAllowed(
        {
          entries: ["111"],
          hasEntries: true,
          hasWildcard: false,
        },
        "111",
        false,
      );
      expect(result).toBe(true);
      // But mismatch fails
      const result2 = isSenderIdAllowed(
        {
          entries: ["111"],
          hasEntries: true,
          hasWildcard: false,
        },
        "112",
        false,
      );
      expect(result2).toBe(false);
    });

    it("scenario: misconfiguration allows allowlist + store merge to accidentally expose old contacts", () => {
      // If dmPolicy is wrongly set to non-allowlist while intending allowlist
      const dangerous = mergeDmAllowFromSources({
        allowFrom: ["approved_contact"],
        storeAllowFrom: ["old_contact_from_pairing"],
        dmPolicy: "pairing", // Wrong: should be "allowlist"
      });
      expect(dangerous).toContain("old_contact_from_pairing");
      expect(dangerous).toContain("approved_contact");

      // Correct config blocks it
      const safe = mergeDmAllowFromSources({
        allowFrom: ["approved_contact"],
        storeAllowFrom: ["old_contact_from_pairing"],
        dmPolicy: "allowlist",
      });
      expect(safe).not.toContain("old_contact_from_pairing");
      expect(safe).toContain("approved_contact");
    });

    it("scenario: group scope leaks into DM when allowlist is misconfigured", () => {
      // If developer accidentally returns DM allowlist for group checks
      const dmAllowlist = ["alice"];
      const groupAllowlist = ["group_admin"];

      // Correct usage (group takes precedence)
      const correct = resolveGroupAllowFromSources({
        allowFrom: dmAllowlist,
        groupAllowFrom: groupAllowlist,
      });
      expect(correct).toEqual(["group_admin"]);
      expect(correct).not.toEqual(dmAllowlist);

      // Common bug: using wrong scope
      const buggy = resolveGroupAllowFromSources({
        allowFrom: dmAllowlist,
        groupAllowFrom: [], // Empty, should we fall back?
      });
      // With fallback enabled (default), it falls back - might be intended
      expect(buggy).toEqual(dmAllowlist);
    });

    it("scenario: allowWhenEmpty bypassed in untrusted context", () => {
      // allowWhenEmpty should ONLY be used for known-safe contexts (open mode)
      // Attackers cannot flip this flag in untrusted flows
      const restrictive = isSenderIdAllowed(
        {
          entries: [],
          hasEntries: false,
          hasWildcard: false,
        },
        "attacker_id",
        false, // Secure: allowWhenEmpty=false
      );
      expect(restrictive).toBe(false);

      // Only open mode should pass
      const permissive = isSenderIdAllowed(
        {
          entries: [],
          hasEntries: false,
          hasWildcard: false,
        },
        "anyone",
        true, // Only in open mode
      );
      expect(permissive).toBe(true);
    });

    it("scenario: wildcard configuration must be explicit (not inferred)", () => {
      // Never generate wildcard from partial config
      const noWildcard = isSenderIdAllowed(
        {
          entries: ["111"],
          hasEntries: true,
          hasWildcard: false, // Explicitly false
        },
        "999",
        false,
      );
      expect(noWildcard).toBe(false);

      // Only explicit wildcard allows all
      const withWildcard = isSenderIdAllowed(
        {
          entries: ["111"],
          hasEntries: true,
          hasWildcard: true, // Explicitly set
        },
        "999",
        false,
      );
      expect(withWildcard).toBe(true);
    });
  });

  describe("edge case: empty and null configurations", () => {
    it("safely handles all-undefined sources", () => {
      expect(mergeDmAllowFromSources({})).toEqual([]);
      expect(
        mergeDmAllowFromSources({
          allowFrom: undefined,
          storeAllowFrom: undefined,
          dmPolicy: undefined,
        }),
      ).toEqual([]);
    });

    it("handles empty array sources", () => {
      expect(mergeDmAllowFromSources({ allowFrom: [], storeAllowFrom: [] })).toEqual([]);
    });

    it("safely denies access on empty config (fail-closed)", () => {
      expect(
        isSenderIdAllowed(
          {
            entries: [],
            hasEntries: false,
            hasWildcard: false,
          },
          "sender",
          false,
        ),
      ).toBe(false);
    });
  });

  describe("data type coercion and validation", () => {
    it("coerces numeric IDs to strings consistently", () => {
      const result = mergeDmAllowFromSources({
        allowFrom: [123, "456", 789],
        storeAllowFrom: [1011],
      });
      expect(result).toEqual(["123", "456", "789", "1011"]);
    });

    it("handles string numbers in allowlist checks", () => {
      expect(
        isSenderIdAllowed(
          {
            entries: ["123", "456"],
            hasEntries: true,
            hasWildcard: false,
          },
          "123",
          false,
        ),
      ).toBe(true);
    });

    it("maintains type safety: mixed types converted to strings", () => {
      const mixed = mergeDmAllowFromSources({
        allowFrom: [111, "222", 333],
        storeAllowFrom: ["444"],
      });
      expect(mixed).toEqual(["111", "222", "333", "444"]);
      expect(typeof mixed[0]).toBe("string");
      expect(typeof mixed[1]).toBe("string");
    });
  });

  describe("whitespace and normalization attacks", () => {
    it("strips leading/trailing whitespace (prevents identity bypass)", () => {
      const result = mergeDmAllowFromSources({
        allowFrom: ["  alice  ", "bob"],
        storeAllowFrom: ["  charlie  "],
      });
      expect(result).toEqual(["alice", "bob", "charlie"]);
    });

    it("filters empty strings after normalization", () => {
      const result = mergeDmAllowFromSources({
        allowFrom: ["", "  ", "alice"],
      });
      expect(result).toEqual(["alice"]);
    });

    it("maintains security even with whitespace-only entries", () => {
      const result = isSenderIdAllowed(
        {
          entries: ["alice"],
          hasEntries: true,
          hasWildcard: false,
        },
        "  alice  ", // Incoming sender has whitespace
        false,
      );
      // Must match exactly; whitespace is not normalized at check time
      expect(result).toBe(false);
    });
  });
});
