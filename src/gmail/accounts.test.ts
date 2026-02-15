import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { listGmailAccountIds, resolveGmailAccount, listEnabledGmailAccounts } from "./accounts.js";

vi.mock("./token.js", () => ({
  resolveGmailRefreshToken: (value: string | undefined) => value?.trim() || undefined,
}));

function makeCfg(gmail?: Record<string, unknown>): OpenClawConfig {
  return { channels: { gmail } } as OpenClawConfig;
}

describe("listGmailAccountIds", () => {
  it("returns default account when no accounts configured", () => {
    const cfg = makeCfg({ enabled: true });
    const ids = listGmailAccountIds(cfg);
    expect(ids).toEqual(["default"]);
  });

  it("returns configured account IDs sorted alphabetically", () => {
    const cfg = makeCfg({
      enabled: true,
      accounts: {
        zenloop: { refreshToken: "tok3" },
        edubites: { refreshToken: "tok1" },
        protaige: { refreshToken: "tok2" },
      },
    });
    const ids = listGmailAccountIds(cfg);
    expect(ids).toEqual(["edubites", "protaige", "zenloop"]);
  });

  it("filters out empty account keys", () => {
    const cfg = makeCfg({
      enabled: true,
      accounts: {
        "": { refreshToken: "tok" },
        edubites: { refreshToken: "tok1" },
      },
    });
    const ids = listGmailAccountIds(cfg);
    expect(ids).toEqual(["edubites"]);
  });
});

describe("resolveGmailAccount", () => {
  it("resolves default account from base config", () => {
    const cfg = makeCfg({
      enabled: true,
      clientId: "base-client",
      clientSecret: "base-secret",
      refreshToken: "base-token",
    });
    const account = resolveGmailAccount({ cfg });
    expect(account.accountId).toBe("default");
    expect(account.enabled).toBe(true);
    expect(account.refreshToken).toBe("base-token");
  });

  it("resolves named account with merged config", () => {
    const cfg = makeCfg({
      enabled: true,
      clientId: "base-client",
      clientSecret: "base-secret",
      accounts: {
        edubites: { refreshToken: "edubites-token" },
      },
    });
    const account = resolveGmailAccount({ cfg, accountId: "edubites" });
    expect(account.accountId).toBe("edubites");
    expect(account.refreshToken).toBe("edubites-token");
    expect(account.config.clientId).toBe("base-client");
  });

  it("account config overrides base config", () => {
    const cfg = makeCfg({
      enabled: true,
      clientId: "base-client",
      clientSecret: "base-secret",
      accounts: {
        edubites: {
          clientId: "edubites-client",
          refreshToken: "edubites-token",
        },
      },
    });
    const account = resolveGmailAccount({ cfg, accountId: "edubites" });
    expect(account.config.clientId).toBe("edubites-client");
    expect(account.config.clientSecret).toBe("base-secret");
  });

  it("reports disabled when base gmail is disabled", () => {
    const cfg = makeCfg({ enabled: false, refreshToken: "tok" });
    const account = resolveGmailAccount({ cfg });
    expect(account.enabled).toBe(false);
  });

  it("reports disabled when account is disabled", () => {
    const cfg = makeCfg({
      enabled: true,
      accounts: {
        edubites: { enabled: false, refreshToken: "tok" },
      },
    });
    const account = resolveGmailAccount({ cfg, accountId: "edubites" });
    expect(account.enabled).toBe(false);
  });

  it("falls back to env var for default account token", () => {
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "env-token");
    const cfg = makeCfg({ enabled: true });
    const account = resolveGmailAccount({ cfg });
    expect(account.refreshToken).toBe("env-token");
    vi.unstubAllEnvs();
  });

  it("config token takes precedence over env var", () => {
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "env-token");
    const cfg = makeCfg({ enabled: true, refreshToken: "config-token" });
    const account = resolveGmailAccount({ cfg });
    expect(account.refreshToken).toBe("config-token");
    vi.unstubAllEnvs();
  });

  it("does not use env var for named accounts", () => {
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "env-token");
    const cfg = makeCfg({
      enabled: true,
      accounts: { edubites: {} },
    });
    const account = resolveGmailAccount({ cfg, accountId: "edubites" });
    expect(account.refreshToken).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("includes actions config from account", () => {
    const cfg = makeCfg({
      enabled: true,
      actions: { read: true, send: false },
      accounts: {
        edubites: {
          refreshToken: "tok",
          actions: { read: true, send: true },
        },
      },
    });
    const account = resolveGmailAccount({ cfg, accountId: "edubites" });
    expect(account.actions).toEqual({ read: true, send: true });
  });
});

describe("listEnabledGmailAccounts", () => {
  it("returns only enabled accounts", () => {
    const cfg = makeCfg({
      enabled: true,
      accounts: {
        edubites: { enabled: true, refreshToken: "tok1" },
        protaige: { enabled: false, refreshToken: "tok2" },
        zenloop: { enabled: true, refreshToken: "tok3" },
      },
    });
    const accounts = listEnabledGmailAccounts(cfg);
    const ids = accounts.map((a) => a.accountId);
    expect(ids).toEqual(["edubites", "zenloop"]);
  });

  it("returns empty array when gmail is disabled", () => {
    const cfg = makeCfg({
      enabled: false,
      accounts: {
        edubites: { refreshToken: "tok1" },
      },
    });
    const accounts = listEnabledGmailAccounts(cfg);
    expect(accounts).toEqual([]);
  });
});
