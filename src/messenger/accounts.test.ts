import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveMessengerAccount,
  listMessengerAccountIds,
  resolveDefaultMessengerAccountId,
  normalizeAccountId,
  DEFAULT_ACCOUNT_ID,
} from "./accounts.js";

describe("Messenger accounts", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MESSENGER_PAGE_ACCESS_TOKEN;
    delete process.env.MESSENGER_APP_SECRET;
    delete process.env.MESSENGER_VERIFY_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("resolveMessengerAccount", () => {
    it("resolves account from config", () => {
      const cfg: OpenClawConfig = {
        channels: {
          messenger: {
            enabled: true,
            pageAccessToken: "test-token",
            appSecret: "test-secret",
            verifyToken: "test-verify",
            name: "Test Page",
          },
        },
      };

      const account = resolveMessengerAccount({ cfg });

      expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
      expect(account.enabled).toBe(true);
      expect(account.pageAccessToken).toBe("test-token");
      expect(account.appSecret).toBe("test-secret");
      expect(account.verifyToken).toBe("test-verify");
      expect(account.name).toBe("Test Page");
      expect(account.tokenSource).toBe("config");
    });

    it("resolves account from environment variables", () => {
      process.env.MESSENGER_PAGE_ACCESS_TOKEN = "env-token";
      process.env.MESSENGER_APP_SECRET = "env-secret";
      process.env.MESSENGER_VERIFY_TOKEN = "env-verify";

      const cfg: OpenClawConfig = {
        channels: {
          messenger: {
            enabled: true,
          },
        },
      };

      const account = resolveMessengerAccount({ cfg });

      expect(account.pageAccessToken).toBe("env-token");
      expect(account.appSecret).toBe("env-secret");
      expect(account.verifyToken).toBe("env-verify");
      expect(account.tokenSource).toBe("env");
    });

    it("resolves named account", () => {
      const cfg: OpenClawConfig = {
        channels: {
          messenger: {
            enabled: true,
            accounts: {
              business: {
                enabled: true,
                pageAccessToken: "business-token",
                appSecret: "business-secret",
                verifyToken: "business-verify",
                name: "Business Page",
              },
            },
          },
        },
      };

      const account = resolveMessengerAccount({ cfg, accountId: "business" });

      expect(account.accountId).toBe("business");
      expect(account.enabled).toBe(true);
      expect(account.pageAccessToken).toBe("business-token");
      expect(account.appSecret).toBe("business-secret");
      expect(account.verifyToken).toBe("business-verify");
      expect(account.name).toBe("Business Page");
    });

    it("returns empty token when not configured", () => {
      const cfg: OpenClawConfig = {};

      const account = resolveMessengerAccount({ cfg });

      expect(account.pageAccessToken).toBe("");
      expect(account.appSecret).toBe("");
      expect(account.verifyToken).toBe("");
      expect(account.tokenSource).toBe("none");
    });

    it("falls back to base config for default account", () => {
      const cfg: OpenClawConfig = {
        channels: {
          messenger: {
            pageAccessToken: "base-token",
            appSecret: "base-secret",
            verifyToken: "base-verify",
          },
        },
      };

      const account = resolveMessengerAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });

      expect(account.pageAccessToken).toBe("base-token");
      expect(account.appSecret).toBe("base-secret");
      expect(account.verifyToken).toBe("base-verify");
    });
  });

  describe("listMessengerAccountIds", () => {
    it("returns default account when configured at base level", () => {
      const cfg: OpenClawConfig = {
        channels: {
          messenger: {
            pageAccessToken: "test-token",
          },
        },
      };

      const ids = listMessengerAccountIds(cfg);

      expect(ids).toContain(DEFAULT_ACCOUNT_ID);
    });

    it("returns named accounts", () => {
      const cfg: OpenClawConfig = {
        channels: {
          messenger: {
            accounts: {
              business: { enabled: true },
              personal: { enabled: true },
            },
          },
        },
      };

      const ids = listMessengerAccountIds(cfg);

      expect(ids).toContain("business");
      expect(ids).toContain("personal");
    });

    it("returns default from env", () => {
      process.env.MESSENGER_PAGE_ACCESS_TOKEN = "env-token";
      const cfg: OpenClawConfig = {};

      const ids = listMessengerAccountIds(cfg);

      expect(ids).toContain(DEFAULT_ACCOUNT_ID);
    });
  });

  describe("resolveDefaultMessengerAccountId", () => {
    it("returns default when configured", () => {
      const cfg: OpenClawConfig = {
        channels: {
          messenger: {
            pageAccessToken: "test-token",
          },
        },
      };

      const id = resolveDefaultMessengerAccountId(cfg);

      expect(id).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("returns first named account when default not configured", () => {
      const cfg: OpenClawConfig = {
        channels: {
          messenger: {
            accounts: {
              business: { enabled: true },
            },
          },
        },
      };

      const id = resolveDefaultMessengerAccountId(cfg);

      expect(id).toBe("business");
    });
  });

  describe("normalizeAccountId", () => {
    it("normalizes undefined to default", () => {
      expect(normalizeAccountId(undefined)).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("normalizes 'default' to DEFAULT_ACCOUNT_ID", () => {
      expect(normalizeAccountId("default")).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("preserves other account ids", () => {
      expect(normalizeAccountId("business")).toBe("business");
    });

    it("lowercases account ids", () => {
      expect(normalizeAccountId("Business")).toBe("business");
    });

    it("trims whitespace", () => {
      expect(normalizeAccountId("  business  ")).toBe("business");
    });
  });
});
