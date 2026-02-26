import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withEnv } from "../test-utils/env.js";
import { listTelegramAccountIds, resolveTelegramAccount } from "./accounts.js";

const { warnMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => {
    const logger = {
      warn: warnMock,
      child: () => logger,
    };
    return logger;
  },
}));

describe("resolveTelegramAccount", () => {
  afterEach(() => {
    warnMock.mockClear();
  });

  it("falls back to the first configured account when accountId is omitted", () => {
    withEnv({ TELEGRAM_BOT_TOKEN: "" }, () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: { accounts: { work: { botToken: "tok-work" } } },
        },
      };

      const account = resolveTelegramAccount({ cfg });
      expect(account.accountId).toBe("work");
      expect(account.token).toBe("tok-work");
      expect(account.tokenSource).toBe("config");
    });
  });

  it("uses TELEGRAM_BOT_TOKEN when default account config is missing", () => {
    withEnv({ TELEGRAM_BOT_TOKEN: "tok-env" }, () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: { accounts: { work: { botToken: "tok-work" } } },
        },
      };

      const account = resolveTelegramAccount({ cfg });
      expect(account.accountId).toBe("default");
      expect(account.token).toBe("tok-env");
      expect(account.tokenSource).toBe("env");
    });
  });

  it("prefers default config token over TELEGRAM_BOT_TOKEN", () => {
    withEnv({ TELEGRAM_BOT_TOKEN: "tok-env" }, () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: { botToken: "tok-config" },
        },
      };

      const account = resolveTelegramAccount({ cfg });
      expect(account.accountId).toBe("default");
      expect(account.token).toBe("tok-config");
      expect(account.tokenSource).toBe("config");
    });
  });

  it("does not fall back when accountId is explicitly provided", () => {
    withEnv({ TELEGRAM_BOT_TOKEN: "" }, () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: { accounts: { work: { botToken: "tok-work" } } },
        },
      };

      const account = resolveTelegramAccount({ cfg, accountId: "default" });
      expect(account.accountId).toBe("default");
      expect(account.tokenSource).toBe("none");
      expect(account.token).toBe("");
    });
  });

  it("formats debug logs with inspect-style output when debug env is enabled", () => {
    withEnv({ TELEGRAM_BOT_TOKEN: "", OPENCLAW_DEBUG_TELEGRAM_ACCOUNTS: "1" }, () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: { accounts: { work: { botToken: "tok-work" } } },
        },
      };

      expect(listTelegramAccountIds(cfg)).toEqual(["work"]);
      resolveTelegramAccount({ cfg, accountId: "work" });
    });

    const lines = warnMock.mock.calls.map(([line]) => String(line));
    expect(lines).toContain("listTelegramAccountIds [ 'work' ]");
    expect(lines).toContain("resolve { accountId: 'work', enabled: true, tokenSource: 'config' }");
  });
});

describe("resolveTelegramAccount allowFrom precedence", () => {
  it("prefers accounts.default allowlists over top-level for default account", () => {
    const resolved = resolveTelegramAccount({
      cfg: {
        channels: {
          telegram: {
            allowFrom: ["top"],
            groupAllowFrom: ["top-group"],
            accounts: {
              default: {
                botToken: "123:default",
                allowFrom: ["default"],
                groupAllowFrom: ["default-group"],
              },
            },
          },
        },
      },
      accountId: "default",
    });

    expect(resolved.config.allowFrom).toEqual(["default"]);
    expect(resolved.config.groupAllowFrom).toEqual(["default-group"]);
  });

  it("falls back to top-level allowlists for named account without overrides", () => {
    const resolved = resolveTelegramAccount({
      cfg: {
        channels: {
          telegram: {
            allowFrom: ["top"],
            groupAllowFrom: ["top-group"],
            accounts: {
              work: { botToken: "123:work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toEqual(["top"]);
    expect(resolved.config.groupAllowFrom).toEqual(["top-group"]);
  });

  it("does not inherit default account allowlists for named account when top-level is absent", () => {
    const resolved = resolveTelegramAccount({
      cfg: {
        channels: {
          telegram: {
            accounts: {
              default: {
                botToken: "123:default",
                allowFrom: ["default"],
                groupAllowFrom: ["default-group"],
              },
              work: { botToken: "123:work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toBeUndefined();
    expect(resolved.config.groupAllowFrom).toBeUndefined();
  });
});
