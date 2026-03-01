import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  listFeishuAccountIds,
  resolveDefaultFeishuAccountId,
  resolveFeishuAccount,
  resolveFeishuCredentials,
} from "./accounts.js";

describe("Feishu accounts", () => {
  describe("listFeishuAccountIds", () => {
    it("returns [default] when no accounts configured", () => {
      const cfg: OpenClawConfig = { channels: { feishu: { enabled: true } } };
      expect(listFeishuAccountIds(cfg)).toEqual(["default"]);
    });

    it("returns sorted account ids from config", () => {
      const cfg: OpenClawConfig = {
        channels: {
          feishu: {
            accounts: {
              beta: { appId: "b", appSecret: "b" },
              alpha: { appId: "a", appSecret: "a" },
            },
          },
        },
      };
      expect(listFeishuAccountIds(cfg)).toEqual(["alpha", "beta"]);
    });

    it("returns [default] when feishu config is absent", () => {
      const cfg: OpenClawConfig = {};
      expect(listFeishuAccountIds(cfg)).toEqual(["default"]);
    });
  });

  describe("resolveDefaultFeishuAccountId", () => {
    it("returns 'default' when account named default exists", () => {
      const cfg: OpenClawConfig = {
        channels: {
          feishu: {
            accounts: {
              default: { appId: "d", appSecret: "d" },
              other: { appId: "o", appSecret: "o" },
            },
          },
        },
      };
      expect(resolveDefaultFeishuAccountId(cfg)).toBe("default");
    });

    it("returns first sorted account when no default exists", () => {
      const cfg: OpenClawConfig = {
        channels: {
          feishu: {
            accounts: {
              zeta: { appId: "z", appSecret: "z" },
              alpha: { appId: "a", appSecret: "a" },
            },
          },
        },
      };
      expect(resolveDefaultFeishuAccountId(cfg)).toBe("alpha");
    });
  });

  describe("resolveFeishuCredentials", () => {
    it("returns null when appId is missing", () => {
      expect(resolveFeishuCredentials({ appSecret: "s" })).toBeNull();
    });

    it("returns null when appSecret is missing", () => {
      expect(resolveFeishuCredentials({ appId: "a" })).toBeNull();
    });

    it("returns credentials with trimmed values", () => {
      const result = resolveFeishuCredentials({
        appId: "  cli_abc  ",
        appSecret: "  secret  ",
        encryptKey: "  key  ",
        verificationToken: "  token  ",
        domain: "lark",
      });
      expect(result).toEqual({
        appId: "cli_abc",
        appSecret: "secret",
        encryptKey: "key",
        verificationToken: "token",
        domain: "lark",
      });
    });

    it("defaults domain to feishu", () => {
      const result = resolveFeishuCredentials({ appId: "a", appSecret: "s" });
      expect(result?.domain).toBe("feishu");
    });
  });

  describe("resolveFeishuAccount", () => {
    it("resolves top-level credentials as default account", () => {
      const cfg: OpenClawConfig = {
        channels: {
          feishu: {
            appId: "cli_top",
            appSecret: "top_secret",
            domain: "lark",
          },
        },
      };
      const account = resolveFeishuAccount({ cfg });
      expect(account.accountId).toBe("default");
      expect(account.enabled).toBe(true);
      expect(account.configured).toBe(true);
      expect(account.appId).toBe("cli_top");
      expect(account.appSecret).toBe("top_secret");
      expect(account.domain).toBe("lark");
    });

    it("resolves named account with inherited top-level defaults", () => {
      const cfg: OpenClawConfig = {
        channels: {
          feishu: {
            domain: "lark",
            accounts: {
              prod: { appId: "cli_prod", appSecret: "prod_secret" },
            },
          },
        },
      };
      const account = resolveFeishuAccount({ cfg, accountId: "prod" });
      expect(account.accountId).toBe("prod");
      expect(account.appId).toBe("cli_prod");
      expect(account.domain).toBe("lark");
    });

    it("marks account as not configured when credentials missing", () => {
      const cfg: OpenClawConfig = {
        channels: { feishu: { enabled: true } },
      };
      const account = resolveFeishuAccount({ cfg });
      expect(account.configured).toBe(false);
      expect(account.appId).toBeUndefined();
    });

    it("respects enabled=false at top level", () => {
      const cfg: OpenClawConfig = {
        channels: {
          feishu: {
            enabled: false,
            appId: "a",
            appSecret: "s",
          },
        },
      };
      const account = resolveFeishuAccount({ cfg });
      expect(account.enabled).toBe(false);
      expect(account.configured).toBe(true);
    });

    it("respects enabled=false at account level", () => {
      const cfg: OpenClawConfig = {
        channels: {
          feishu: {
            accounts: {
              disabled: { appId: "a", appSecret: "s", enabled: false },
            },
          },
        },
      };
      const account = resolveFeishuAccount({ cfg, accountId: "disabled" });
      expect(account.enabled).toBe(false);
    });
  });
});
