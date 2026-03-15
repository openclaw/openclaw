import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { createAccountListHelpers } from "./account-helpers.js";

const { listConfiguredAccountIds, listAccountIds, resolveDefaultAccountId } =
  createAccountListHelpers("testchannel");

function cfg(accounts?: Record<string, unknown> | null, defaultAccount?: string): OpenClawConfig {
  if (accounts === null) {
    return {
      channels: {
        testchannel: defaultAccount ? { defaultAccount } : {},
      },
    } as unknown as OpenClawConfig;
  }
  if (accounts === undefined && !defaultAccount) {
    return {} as unknown as OpenClawConfig;
  }
  return {
    channels: {
      testchannel: {
        ...(accounts === undefined ? {} : { accounts }),
        ...(defaultAccount ? { defaultAccount } : {}),
      },
    },
  } as unknown as OpenClawConfig;
}

describe("createAccountListHelpers", () => {
  describe("listConfiguredAccountIds", () => {
    it("returns empty for missing config", () => {
      expect(listConfiguredAccountIds({} as OpenClawConfig)).toEqual([]);
    });

    it("returns empty when no accounts key", () => {
      expect(listConfiguredAccountIds(cfg(null))).toEqual([]);
    });

    it("returns empty for empty accounts object", () => {
      expect(listConfiguredAccountIds(cfg({}))).toEqual([]);
    });

    it("filters out empty keys", () => {
      expect(listConfiguredAccountIds(cfg({ "": {}, a: {} }))).toEqual(["a"]);
    });

    it("returns account keys", () => {
      expect(listConfiguredAccountIds(cfg({ work: {}, personal: {} }))).toEqual([
        "work",
        "personal",
      ]);
    });
  });

  describe("with normalizeAccountId option", () => {
    const normalized = createAccountListHelpers("testchannel", { normalizeAccountId });

    it("normalizes and deduplicates configured account ids", () => {
      expect(
        normalized.listConfiguredAccountIds(
          cfg({
            "Router D": {},
            "router-d": {},
            "Personal A": {},
          }),
        ),
      ).toEqual(["router-d", "personal-a"]);
    });
  });

  describe("listAccountIds", () => {
    it('returns ["default"] for empty config', () => {
      expect(listAccountIds({} as OpenClawConfig)).toEqual(["default"]);
    });

    it('returns ["default"] for empty accounts', () => {
      expect(listAccountIds(cfg({}))).toEqual(["default"]);
    });

    it("returns sorted ids", () => {
      expect(listAccountIds(cfg({ z: {}, a: {}, m: {} }))).toEqual(["a", "m", "z"]);
    });

    it("includes default when ALL named accounts have their own tokens", () => {
      const config = {
        channels: {
          testchannel: {
            botToken: "xoxb-base",
            appToken: "xapp-base",
            accounts: { tank: { botToken: "xoxb-tank", appToken: "xapp-tank" } },
          },
        },
      } as unknown as OpenClawConfig;
      expect(listAccountIds(config)).toEqual(["default", "tank"]);
    });

    it("includes default when normalized IDs differ from raw config keys", () => {
      const normalizedHelpers = createAccountListHelpers("testchannel", {
        normalizeAccountId: (id: string) => id.toLowerCase().replace(/\s+/g, "-"),
      });
      const config = {
        channels: {
          testchannel: {
            botToken: "xoxb-base",
            accounts: {
              "Router D": { botToken: "xoxb-router-d" },
            },
          },
        },
      } as unknown as OpenClawConfig;
      // "Router D" normalizes to "router-d" — should still detect own token
      expect(normalizedHelpers.listAccountIds(config)).toEqual(["default", "router-d"]);
    });

    it("does NOT inject default in mixed configs (some accounts inherit base tokens)", () => {
      const config = {
        channels: {
          testchannel: {
            botToken: "xoxb-base",
            accounts: { teamA: { botToken: "xoxb-own" }, teamB: {} },
          },
        },
      } as unknown as OpenClawConfig;
      // teamB inherits base tokens — injecting default would duplicate teamB
      expect(listAccountIds(config)).toEqual(["teamA", "teamB"]);
    });

    it("does NOT inject default when account partially overrides (only appToken)", () => {
      const config = {
        channels: {
          testchannel: {
            botToken: "xoxb-base",
            appToken: "xapp-base",
            accounts: { teamA: { appToken: "xapp-own" } },
          },
        },
      } as unknown as OpenClawConfig;
      // teamA overrides appToken but inherits botToken — still same bot identity
      expect(listAccountIds(config)).toEqual(["teamA"]);
    });

    it("does NOT inject default when base token is whitespace-only", () => {
      const config = {
        channels: {
          testchannel: {
            botToken: "   ",
            accounts: { teamA: {} },
          },
        },
      } as unknown as OpenClawConfig;
      expect(listAccountIds(config)).toEqual(["teamA"]);
    });

    it("does NOT inject default when named accounts inherit base tokens (avoids duplicates)", () => {
      const config = {
        channels: {
          testchannel: {
            botToken: "xoxb-base",
            appToken: "xapp-base",
            accounts: { tank: {} },
          },
        },
      } as unknown as OpenClawConfig;
      expect(listAccountIds(config)).toEqual(["tank"]);
    });

    it("does NOT inject default when Discord named accounts inherit base token", () => {
      const config = {
        channels: {
          testchannel: {
            token: "discord-bot-token",
            accounts: { teamA: {} },
          },
        },
      } as unknown as OpenClawConfig;
      expect(listAccountIds(config)).toEqual(["teamA"]);
    });

    it("does not duplicate default when already in accounts (case-insensitive)", () => {
      const config = {
        channels: {
          testchannel: {
            botToken: "xoxb-base",
            accounts: { Default: {}, tank: {} },
          },
        },
      } as unknown as OpenClawConfig;
      expect(listAccountIds(config)).toEqual(["Default", "tank"]);
    });

    it("does not duplicate default when already in accounts", () => {
      const config = {
        channels: {
          testchannel: {
            botToken: "xoxb-base",
            accounts: { default: {}, tank: {} },
          },
        },
      } as unknown as OpenClawConfig;
      expect(listAccountIds(config)).toEqual(["default", "tank"]);
    });

    it("does not include default when base has no tokens", () => {
      expect(listAccountIds(cfg({ tank: {} }))).toEqual(["tank"]);
    });
  });

  describe("resolveDefaultAccountId", () => {
    it("prefers configured defaultAccount when it matches a configured account id", () => {
      expect(resolveDefaultAccountId(cfg({ alpha: {}, beta: {} }, "beta"))).toBe("beta");
    });

    it("normalizes configured defaultAccount before matching", () => {
      expect(resolveDefaultAccountId(cfg({ "router-d": {} }, "Router D"))).toBe("router-d");
    });

    it("falls back when configured defaultAccount is missing", () => {
      expect(resolveDefaultAccountId(cfg({ beta: {}, alpha: {} }, "missing"))).toBe("alpha");
    });

    it('returns "default" when present', () => {
      expect(resolveDefaultAccountId(cfg({ default: {}, other: {} }))).toBe("default");
    });

    it("returns first sorted id when no default", () => {
      expect(resolveDefaultAccountId(cfg({ beta: {}, alpha: {} }))).toBe("alpha");
    });

    it('returns "default" for empty config', () => {
      expect(resolveDefaultAccountId({} as OpenClawConfig)).toBe("default");
    });
  });
});
