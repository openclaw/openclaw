import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "./accounts.js";

describe("LINE accounts", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.LINE_CHANNEL_SECRET;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("resolveLineAccount", () => {
    it("resolves account from config", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
            channelAccessToken: "test-token",
            channelSecret: "test-secret",
            name: "Test Bot",
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
      expect(account.enabled).toBe(true);
      expect(account.channelAccessToken).toBe("test-token");
      expect(account.channelSecret).toBe("test-secret");
      expect(account.name).toBe("Test Bot");
      expect(account.tokenSource).toBe("config");
    });

    it("resolves account from environment variables", () => {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = "env-token";
      process.env.LINE_CHANNEL_SECRET = "env-secret";

      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.channelAccessToken).toBe("env-token");
      expect(account.channelSecret).toBe("env-secret");
      expect(account.tokenSource).toBe("env");
    });

    it("resolves named account", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
            accounts: {
              business: {
                enabled: true,
                channelAccessToken: "business-token",
                channelSecret: "business-secret",
                name: "Business Bot",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg, accountId: "business" });

      expect(account.accountId).toBe("business");
      expect(account.enabled).toBe(true);
      expect(account.channelAccessToken).toBe("business-token");
      expect(account.channelSecret).toBe("business-secret");
      expect(account.name).toBe("Business Bot");
    });

    it("returns empty token when not configured", () => {
      const cfg: OpenClawConfig = {};

      const account = resolveLineAccount({ cfg });

      expect(account.channelAccessToken).toBe("");
      expect(account.channelSecret).toBe("");
      expect(account.tokenSource).toBe("none");
    });
  });

  describe("resolveDefaultLineAccountId", () => {
    it("prefers channels.line.defaultAccount when configured", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            defaultAccount: "business",
            accounts: {
              business: { enabled: true },
              support: { enabled: true },
            },
          },
        },
      };

      const id = resolveDefaultLineAccountId(cfg);
      expect(id).toBe("business");
    });

    it("normalizes channels.line.defaultAccount before lookup", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            defaultAccount: "Business Ops",
            accounts: {
              "business-ops": { enabled: true },
            },
          },
        },
      };

      const id = resolveDefaultLineAccountId(cfg);
      expect(id).toBe("business-ops");
    });

    it("returns first named account when default not configured", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            accounts: {
              business: { enabled: true },
            },
          },
        },
      };

      const id = resolveDefaultLineAccountId(cfg);

      expect(id).toBe("business");
    });

    it("falls back when channels.line.defaultAccount is missing", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            defaultAccount: "missing",
            accounts: {
              business: { enabled: true },
            },
          },
        },
      };

      const id = resolveDefaultLineAccountId(cfg);
      expect(id).toBe("business");
    });
  });

  describe("normalizeAccountId", () => {
    it("trims and lowercases account ids", () => {
      expect(normalizeAccountId("  Business  ")).toBe("business");
    });
  });

  describe("resolveLineAccount – tokenFile/secretFile relative path resolution", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-line-tokenfile-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("resolves tokenFile with a relative path when configFile is provided", () => {
      fs.writeFileSync(path.join(tmpDir, "token.txt"), "rel-line-token\n", "utf-8");
      fs.writeFileSync(path.join(tmpDir, "secret.txt"), "rel-line-secret\n", "utf-8");

      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
            tokenFile: "./token.txt",
            secretFile: "./secret.txt",
          },
        },
      };

      const account = resolveLineAccount({
        cfg,
        configFile: path.join(tmpDir, "openclaw.json"),
      });

      expect(account.channelAccessToken).toBe("rel-line-token");
      expect(account.channelSecret).toBe("rel-line-secret");
      expect(account.tokenSource).toBe("file");
    });

    it("resolves per-account tokenFile with a relative path when configFile is provided", () => {
      fs.writeFileSync(path.join(tmpDir, "biz-token.txt"), "biz-line-token\n", "utf-8");
      fs.writeFileSync(path.join(tmpDir, "biz-secret.txt"), "biz-line-secret\n", "utf-8");

      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
            accounts: {
              business: {
                enabled: true,
                tokenFile: "biz-token.txt",
                secretFile: "biz-secret.txt",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({
        cfg,
        accountId: "business",
        configFile: path.join(tmpDir, "openclaw.json"),
      });

      expect(account.channelAccessToken).toBe("biz-line-token");
      expect(account.channelSecret).toBe("biz-line-secret");
      expect(account.tokenSource).toBe("file");
    });

    it("still resolves absolute tokenFile paths without configFile", () => {
      const tokenFile = path.join(tmpDir, "abs-token.txt");
      const secretFile = path.join(tmpDir, "abs-secret.txt");
      fs.writeFileSync(tokenFile, "abs-line-token\n", "utf-8");
      fs.writeFileSync(secretFile, "abs-line-secret\n", "utf-8");

      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
            tokenFile,
            secretFile,
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.channelAccessToken).toBe("abs-line-token");
      expect(account.channelSecret).toBe("abs-line-secret");
      expect(account.tokenSource).toBe("file");
    });
  });
});
