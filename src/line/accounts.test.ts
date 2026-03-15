import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveLineAccount,
  listLineAccountIds,
  resolveDefaultLineAccountId,
  normalizeAccountId,
  DEFAULT_ACCOUNT_ID,
} from "./accounts.js";

describe("LINE accounts", () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];

  const createSecretFile = (fileName: string, contents: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-line-account-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, contents, "utf8");
    return filePath;
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.LINE_CHANNEL_SECRET;
  });

  afterEach(() => {
    process.env = originalEnv;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

    it("resolves default account credentials from channels.line.accounts.default", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
            accounts: {
              default: {
                channelAccessToken: "default-token",
                channelSecret: "default-secret",
                name: "Default Bot",
                webhookPath: "/line/webhook",
              },
              twgreen: {
                channelAccessToken: "twgreen-token",
                channelSecret: "twgreen-secret",
                webhookPath: "/line-twgreen/webhook",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
      expect(account.enabled).toBe(true);
      expect(account.channelAccessToken).toBe("default-token");
      expect(account.channelSecret).toBe("default-secret");
      expect(account.name).toBe("Default Bot");
      expect(account.config.webhookPath).toBe("/line/webhook");
      expect(account.tokenSource).toBe("config");
    });

    it("treats named accounts as enabled unless explicitly disabled", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
            accounts: {
              twgreen: {
                channelAccessToken: "twgreen-token",
                channelSecret: "twgreen-secret",
                webhookPath: "/line-twgreen/webhook",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg, accountId: "twgreen" });

      expect(account.accountId).toBe("twgreen");
      expect(account.enabled).toBe(true);
      expect(account.channelAccessToken).toBe("twgreen-token");
      expect(account.channelSecret).toBe("twgreen-secret");
      expect(account.config.webhookPath).toBe("/line-twgreen/webhook");
    });

    it("falls back to channels.line.defaultAccount when no explicit account is provided", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            defaultAccount: "twgreen",
            accounts: {
              twgreen: {
                channelAccessToken: "twgreen-token",
                channelSecret: "twgreen-secret",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.accountId).toBe("twgreen");
      expect(account.channelAccessToken).toBe("twgreen-token");
      expect(account.channelSecret).toBe("twgreen-secret");
    });

    it("falls back to the first configured named account when the default account has no credentials", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            accounts: {
              "Business Ops": {
                channelAccessToken: "business-token",
                channelSecret: "business-secret",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.accountId).toBe("business-ops");
      expect(account.channelAccessToken).toBe("business-token");
      expect(account.channelSecret).toBe("business-secret");
    });

    it("lets accounts.default override top-level default credentials", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
            channelAccessToken: "base-token",
            channelSecret: "base-secret",
            accounts: {
              default: {
                channelAccessToken: "override-token",
                channelSecret: "override-secret",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });

      expect(account.channelAccessToken).toBe("override-token");
      expect(account.channelSecret).toBe("override-secret");
    });

    it("ignores malformed account keys when resolving the default account", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            channelAccessToken: "base-token",
            channelSecret: "base-secret",
            webhookPath: "/line/webhook",
            accounts: {
              "!!!": {
                channelAccessToken: "bad-token",
                channelSecret: "bad-secret",
                webhookPath: "/line-bad/webhook",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
      expect(account.channelAccessToken).toBe("base-token");
      expect(account.channelSecret).toBe("base-secret");
      expect(account.config.webhookPath).toBe("/line/webhook");
    });

    it("respects explicit account-level disable for named accounts", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
            accounts: {
              twgreen: {
                enabled: false,
                channelAccessToken: "twgreen-token",
                channelSecret: "twgreen-secret",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg, accountId: "twgreen" });

      expect(account.enabled).toBe(false);
      expect(account.channelAccessToken).toBe("twgreen-token");
      expect(account.channelSecret).toBe("twgreen-secret");
    });

    it("returns empty token when not configured", () => {
      const cfg: OpenClawConfig = {};

      const account = resolveLineAccount({ cfg });

      expect(account.channelAccessToken).toBe("");
      expect(account.channelSecret).toBe("");
      expect(account.tokenSource).toBe("none");
    });

    it("resolves default account credentials from files", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            tokenFile: createSecretFile("token.txt", "file-token\n"),
            secretFile: createSecretFile("secret.txt", "file-secret\n"),
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.channelAccessToken).toBe("file-token");
      expect(account.channelSecret).toBe("file-secret");
      expect(account.tokenSource).toBe("file");
    });

    it("resolves named account credentials from account-level files", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            accounts: {
              business: {
                tokenFile: createSecretFile("business-token.txt", "business-file-token\n"),
                secretFile: createSecretFile("business-secret.txt", "business-file-secret\n"),
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg, accountId: "business" });

      expect(account.channelAccessToken).toBe("business-file-token");
      expect(account.channelSecret).toBe("business-file-secret");
      expect(account.tokenSource).toBe("file");
    });

    it.runIf(process.platform !== "win32")("rejects symlinked token and secret files", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-line-account-"));
      tempDirs.push(dir);
      const tokenFile = path.join(dir, "token.txt");
      const tokenLink = path.join(dir, "token-link.txt");
      const secretFile = path.join(dir, "secret.txt");
      const secretLink = path.join(dir, "secret-link.txt");
      fs.writeFileSync(tokenFile, "file-token\n", "utf8");
      fs.writeFileSync(secretFile, "file-secret\n", "utf8");
      fs.symlinkSync(tokenFile, tokenLink);
      fs.symlinkSync(secretFile, secretLink);

      const cfg: OpenClawConfig = {
        channels: {
          line: {
            tokenFile: tokenLink,
            secretFile: secretLink,
          },
        },
      };

      const account = resolveLineAccount({ cfg });
      expect(account.channelAccessToken).toBe("");
      expect(account.channelSecret).toBe("");
      expect(account.tokenSource).toBe("none");
    });
  });

  describe("listLineAccountIds", () => {
    it("normalizes and sorts configured account ids", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            accounts: {
              "Business Ops": {},
              Zebra: {},
              alpha: {},
            },
          },
        },
      };

      expect(listLineAccountIds(cfg)).toEqual(["alpha", "business-ops", "zebra"]);
    });

    it("keeps the default account when base-level credentials are configured", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            channelAccessToken: "base-token",
            accounts: {
              business: {},
            },
          },
        },
      };

      expect(listLineAccountIds(cfg)).toEqual(["business", DEFAULT_ACCOUNT_ID]);
    });

    it("ignores malformed configured account ids", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            accounts: {
              "!!!": {},
              alpha: {},
            },
          },
        },
      };

      expect(listLineAccountIds(cfg)).toEqual(["alpha"]);
    });
  });

  describe("resolveDefaultLineAccountId", () => {
    it.each([
      {
        name: "prefers channels.line.defaultAccount when configured",
        cfg: {
          channels: {
            line: {
              defaultAccount: "business",
              accounts: {
                business: { enabled: true },
                support: { enabled: true },
              },
            },
          },
        } satisfies OpenClawConfig,
        expected: "business",
      },
      {
        name: "normalizes channels.line.defaultAccount before lookup",
        cfg: {
          channels: {
            line: {
              defaultAccount: "Business Ops",
              accounts: {
                "business-ops": { enabled: true },
              },
            },
          },
        } satisfies OpenClawConfig,
        expected: "business-ops",
      },
      {
        name: "returns first named account when default not configured",
        cfg: {
          channels: {
            line: {
              accounts: {
                business: { enabled: true },
              },
            },
          },
        } satisfies OpenClawConfig,
        expected: "business",
      },
      {
        name: "falls back when channels.line.defaultAccount is missing",
        cfg: {
          channels: {
            line: {
              defaultAccount: "missing",
              accounts: {
                business: { enabled: true },
              },
            },
          },
        } satisfies OpenClawConfig,
        expected: "business",
      },
      {
        name: "prefers the default account when base credentials are configured",
        cfg: {
          channels: {
            line: {
              channelAccessToken: "base-token",
              accounts: {
                business: { enabled: true },
              },
            },
          },
        } satisfies OpenClawConfig,
        expected: DEFAULT_ACCOUNT_ID,
      },
    ])("$name", ({ cfg, expected }) => {
      expect(resolveDefaultLineAccountId(cfg)).toBe(expected);
    });
  });

  describe("normalizeAccountId", () => {
    it("trims and lowercases account ids", () => {
      expect(normalizeAccountId("  Business  ")).toBe("business");
    });
  });
});
