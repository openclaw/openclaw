import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveLineAccount,
  resolveDefaultLineAccountId,
  normalizeAccountId,
  DEFAULT_ACCOUNT_ID,
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

    it("resolves token from tokenFile with absolute path", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "line-test-"));
      try {
        const tokenPath = path.join(tmpDir, "token.txt");
        const secretPath = path.join(tmpDir, "secret.txt");
        fs.writeFileSync(tokenPath, "  absolute-token  ");
        fs.writeFileSync(secretPath, "  absolute-secret  ");

        const cfg: OpenClawConfig = {
          channels: {
            line: {
              enabled: true,
              tokenFile: tokenPath,
              secretFile: secretPath,
            },
          },
        };

        const account = resolveLineAccount({ cfg });

        expect(account.channelAccessToken).toBe("absolute-token");
        expect(account.channelSecret).toBe("absolute-secret");
        expect(account.tokenSource).toBe("file");
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it("resolves token from tokenFile with relative path when configDir is provided", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "line-test-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "token.txt"), "  relative-token  ");
        fs.writeFileSync(path.join(tmpDir, "secret.txt"), "  relative-secret  ");

        const cfg: OpenClawConfig = {
          channels: {
            line: {
              enabled: true,
              tokenFile: "./token.txt",
              secretFile: "./secret.txt",
            },
          },
        };

        const account = resolveLineAccount({ cfg, configDir: tmpDir });

        expect(account.channelAccessToken).toBe("relative-token");
        expect(account.channelSecret).toBe("relative-secret");
        expect(account.tokenSource).toBe("file");
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it("returns empty token when relative tokenFile cannot be read without configDir", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
            tokenFile: "./no-such-file.txt",
          },
        },
      };

      // Without a valid configDir the file will not be found and token is empty.
      const account = resolveLineAccount({ cfg, configDir: "/nonexistent-dir" });

      expect(account.channelAccessToken).toBe("");
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
});
