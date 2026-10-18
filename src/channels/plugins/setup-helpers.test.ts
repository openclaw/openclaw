import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  applySetupAccountConfigPatch,
  createEnvPatchedAccountSetupAdapter,
  createPatchedAccountSetupAdapter,
  moveSingleAccountChannelSectionToDefaultAccount,
  patchScopedAccountConfig,
} from "./setup-helpers.js";
import type { ChannelSetupAdapter } from "./types.adapters.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function config(channel: string, section: Record<string, unknown>): OpenClawConfig {
  return asConfig({ channels: { [channel]: section } });
}

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function channelRecord(cfg: OpenClawConfig, channelKey: string): Record<string, unknown> {
  return requireRecord(cfg.channels?.[channelKey]);
}

function accountRecord(
  channel: Record<string, unknown>,
  accountId: string,
): Record<string, unknown> {
  return requireRecord(requireRecord(channel.accounts)[accountId]);
}

const matrixSingleAccountKeysToMove = ["homeserver", "userId", "accessToken"] as const;
const matrixNamedAccountPromotionKeys = ["accessToken", "homeserver", "userId"] as const;
const matrixSetupSurface = {
  applyAccountConfig: ({ cfg }) => cfg,
  singleAccountKeysToMove: matrixSingleAccountKeysToMove,
  namedAccountPromotionKeys: matrixNamedAccountPromotionKeys,
  resolveSingleAccountPromotionTarget: resolveMatrixSingleAccountPromotionTarget,
} as ChannelSetupAdapter;

function resolveMatrixSingleAccountPromotionTarget(params: {
  channel: { defaultAccount?: string; accounts?: Record<string, unknown> };
}): string {
  const accounts = params.channel.accounts ?? {};
  const normalizedDefaultAccount = params.channel.defaultAccount?.trim()
    ? normalizeAccountId(params.channel.defaultAccount)
    : undefined;
  if (normalizedDefaultAccount) {
    return (
      Object.keys(accounts).find(
        (accountId) => normalizeAccountId(accountId) === normalizedDefaultAccount,
      ) ?? DEFAULT_ACCOUNT_ID
    );
  }
  const namedAccounts = Object.keys(accounts).filter(Boolean);
  return namedAccounts.length === 1
    ? expectDefined(namedAccounts[0], "namedAccounts[0] test invariant")
    : DEFAULT_ACCOUNT_ID;
}

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createTestRegistry([]));
});

afterAll(resetPluginRuntimeStateForTest);

it("applySetupAccountConfigPatch normalizes account id and preserves other accounts", () => {
  const next = applySetupAccountConfigPatch({
    cfg: config("demo-setup", { accounts: { personal: { botToken: "personal-token" } } }),
    channelKey: "demo-setup",
    accountId: "Work Team",
    patch: { botToken: "work-token" },
  });

  const channel = channelRecord(next, "demo-setup");
  expect(accountRecord(channel, "personal").botToken).toBe("personal-token");
  expect(accountRecord(channel, "work-team")).toMatchObject({
    enabled: true,
    botToken: "work-token",
  });
});

it("patchScopedAccountConfig clears only default-account credentials before replacement", () => {
  const next = patchScopedAccountConfig({
    cfg: config("demo-setup", {
      enabled: false,
      token: "old-token",
      tokenFile: "/old/token",
      webhookPath: "/keep",
    }),
    channelKey: "demo-setup",
    accountId: DEFAULT_ACCOUNT_ID,
    clearFields: ["token", "tokenFile"],
    patch: { token: "new-token" },
    ensureChannelEnabled: false,
  });

  expect(channelRecord(next, "demo-setup")).toEqual({
    enabled: false,
    token: "new-token",
    webhookPath: "/keep",
  });
});

describe("createPatchedAccountSetupAdapter", () => {
  const tokenAdapter = createPatchedAccountSetupAdapter({
    channelKey: "demo-setup",
    buildPatch: (input) => ({ botToken: input.token }),
  });

  it("stores default-account patch at channel root", () => {
    const next = tokenAdapter.applyAccountConfig({
      cfg: config("demo-setup", { enabled: false }),
      accountId: DEFAULT_ACCOUNT_ID,
      input: { name: "Personal", token: "tok" },
    });

    expect(channelRecord(next, "demo-setup")).toMatchObject({
      enabled: true,
      name: "Personal",
      botToken: "tok",
    });
  });

  it("migrates base name into the default account before patching a named account", () => {
    const next = tokenAdapter.applyAccountConfig({
      cfg: config("demo-setup", { name: "Personal", accounts: { work: { botToken: "old" } } }),
      accountId: "Work Team",
      input: { name: "Work", token: "new" },
    });

    const channel = channelRecord(next, "demo-setup");
    expect(accountRecord(channel, "default").name).toBe("Personal");
    expect(accountRecord(channel, "work").botToken).toBe("old");
    expect(accountRecord(channel, "work-team")).toMatchObject({
      enabled: true,
      name: "Work",
      botToken: "new",
    });
    expect(next.channels?.["demo-setup"]).not.toHaveProperty("name");
  });

  it("can store the default account in accounts.default", () => {
    const adapter = createPatchedAccountSetupAdapter({
      channelKey: "demo-accounts",
      alwaysUseAccounts: true,
      buildPatch: (input) => ({ authDir: input.authDir }),
    });

    const next = adapter.applyAccountConfig({
      cfg: config("demo-accounts", {}),
      accountId: DEFAULT_ACCOUNT_ID,
      input: { name: "Phone", authDir: "/tmp/auth" },
    });

    const channel = channelRecord(next, "demo-accounts");
    expect(accountRecord(channel, "default")).toMatchObject({
      enabled: true,
      name: "Phone",
      authDir: "/tmp/auth",
    });
    expect(next.channels?.["demo-accounts"]).not.toHaveProperty("enabled");
    expect(next.channels?.["demo-accounts"]).not.toHaveProperty("authDir");
  });
});

describe("moveSingleAccountChannelSectionToDefaultAccount", () => {
  it("does not add a default when an ordinary named account already exists and no keys move", () => {
    const cfg = asConfig({ channels: { demo: { enabled: true, accounts: { ada: {} } } } });
    expect(moveSingleAccountChannelSectionToDefaultAccount({ cfg, channelKey: "demo" })).toBe(cfg);
  });

  it("promotes legacy Matrix keys into the sole named account when defaultAccount is unset", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: config("matrix", {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "token",
        accounts: { main: { enabled: true } },
      }),
      channelKey: "matrix",
      setupSurface: matrixSetupSurface,
    });

    expect(next.channels?.matrix).toEqual({
      accounts: {
        main: {
          enabled: true,
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "token",
        },
      },
    });
  });

  it("preserves explicit named-account values over promoted root defaults", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: config("zalouser", {
        dmPolicy: "disabled",
        accounts: { work: { dmPolicy: "allowlist" } },
      }),
      channelKey: "zalouser",
    });

    const channel = channelRecord(next, "zalouser");
    const work = accountRecord(channel, "work");
    expect(work.dmPolicy).toBe("allowlist");
    expect(next.channels?.zalouser?.dmPolicy).toBeUndefined();
  });
});

it("createEnvPatchedAccountSetupAdapter rejects named-account env mode and requires credentials", () => {
  const adapter = createEnvPatchedAccountSetupAdapter({
    channelKey: "demo-env",
    defaultAccountOnlyEnvError: "env only on default",
    missingCredentialError: "token required",
    hasCredentials: (input) => Boolean(input.token || input.tokenFile),
    buildPatch: (input) => ({ token: input.token }),
  });

  const validate = (
    accountId: string,
    input: Parameters<NonNullable<typeof adapter.validateInput>>[0]["input"],
  ) => adapter.validateInput?.({ cfg: {}, accountId, input });
  expect(validate("work", { useEnv: true })).toBe("env only on default");
  expect(validate(DEFAULT_ACCOUNT_ID, {})).toBe("token required");
  expect(validate(DEFAULT_ACCOUNT_ID, { token: "tok" })).toBeNull();
});
