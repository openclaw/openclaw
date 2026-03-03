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

    it("includes default when base has tokens AND a named account has its own tokens", () => {
      const config = {
        channels: {
          testchannel: {
            botToken: "xoxb-base",
            appToken: "xapp-base",
            accounts: { tank: { botToken: "xoxb-tank" } },
          },
        },
      } as unknown as OpenClawConfig;
      expect(listAccountIds(config)).toEqual(["default", "tank"]);
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
